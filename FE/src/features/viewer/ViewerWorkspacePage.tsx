import * as React from 'react';
import { flushSync } from 'react-dom';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  Eraser,
  Eye,
  EyeOff,
  Lock,
  Maximize2,
  Minimize2,
  Paintbrush,
  PanelRightClose,
  PanelRightOpen,
  Printer,
  Redo2,
  RotateCcw,
  Save,
  SkipBack,
  SkipForward,
  Undo2,
} from 'lucide-react';
import {
  registerTrackedObjectUrl,
  revokeTrackedObjectUrl,
  useAuthStore,
} from '@/app/auth-store';
import { fetchCaseDetail } from '@/shared/api/endpoints';
import { ApiClientError, isAbortError, normalizeApiError } from '@/shared/api/errors';
import {
  downloadMaskVersionExport,
  downloadProtectedFileBuffer,
  fetchAllMaskVersions,
  fetchMaskVersionMetadata,
  saveManualMaskVersion,
  type MaskVersionMetadataDto,
} from '@/shared/api/maskVersions';
import { getSessionEpoch } from '@/shared/api/client';
import type {
  MaskVersionDto,
  PaginatedResponse,
  VolumeModality,
} from '@/shared/api/types';
import { useQueryErrorToast } from '@/shared/api/useQueryErrorToast';
import { cn } from '@/shared/lib/cn';
import { formatDateTimeVN, formatStudyDate } from '@/shared/lib/datetime';
import {
  BRATS_COMPOSITE_GROUPS,
  BRATS_LABELS,
  BRATS_TUMOR_LABEL_IDS,
  type BraTSLabelId,
} from '@/shared/lib/labels';
import { formatVolumeSummary } from '@/shared/lib/volume';
import {
  Alert,
  Button,
  ErrorState,
  IconButton,
  buttonVariants,
  useToast,
} from '@/shared/ui';
import {
  DESKTOP_EDITOR_MIN_WIDTH_PX,
  MaskEditorEngine,
  checkViewportEditorCapability,
  clampSliceIndex,
  computeSliceBrushIndices,
  createEmptyMaskBuffer,
  createSyntheticBrainVolumes,
  displayPointToVoxelCoord,
  findNextMaskSlice,
  getAdjacentSliceIndices,
  getAxialSliceCount,
  interpolateDisplayStroke,
  parseNiftiVolume,
  parsedVolumeToUint8Mask,
  planeDisplayPointToVoxelCoord,
  resolveAxialSliceAxes,
  resolvePlaneAxes,
  serializeNiftiMask,
  toOneBasedSlice,
  toZeroBasedSlice,
  useViewerStore,
  type SlicePlaneType,
  type ViewerLayoutMode,
  type VolumeGeometry,
} from '@/viewer-adapter';
import {
  DirtyExportModal,
  DirtyPrintModal,
  DirtySwitchModal,
  MaskConflictModal,
  SaveMaskNoteModal,
} from './MaskSaveModals';
import { SliceCanvasPane } from './SliceCanvasPane';

interface PendingRetryPayload {
  maskBlob: Blob;
  serializedNiftiBytes: Uint8Array;
  idempotencyKey: string;
  referenceVolumeId: string;
  baseVersionId: string | null;
  note: string;
  snapshot: Uint8Array;
  counts: Record<string, number>;
  volumesMm3: Record<string, number>;
}

type PendingNavigationAction =
  | { type: 'switch-version'; versionId: string }
  | { type: 'leave-page'; to: string };

function areUint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function triggerBrowserBlobDownload(blob: Blob, filename: string): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = registerTrackedObjectUrl(URL.createObjectURL(blob));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => {
    revokeTrackedObjectUrl(url);
  }, 1000);
}

function createUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return '00000000-0000-4000-8000-' + String(Date.now()).padStart(12, '0').slice(-12);
}

function isEditableElementFocused(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    return true;
  }
  if (target.isContentEditable) return true;
  const role = target.getAttribute('role');
  if (role === 'combobox' || role === 'dialog') return true;
  return Boolean(target.closest('[role="dialog"]'));
}

export function ViewerWorkspacePage() {
  const { id = '' } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const requestedVersionParam = searchParams.get('version')?.trim() || null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const user = useAuthStore((s) => s.user);
  const fixtureMode = useAuthStore((s) => s.fixtureMode);
  const reauthRequired = useAuthStore((s) => s.reauthRequired);

  const layoutMode = useViewerStore((s) => s.layoutMode);
  const activeTool = useViewerStore((s) => s.activeTool);
  const activeLabel = useViewerStore((s) => s.activeLabel);
  const brushRadius = useViewerStore((s) => s.brushRadius);
  const maskOpacityPercent = useViewerStore((s) => s.maskOpacityPercent);
  const visibleLabels = useViewerStore((s) => s.visibleLabels);
  const modality = useViewerStore((s) => s.modality);
  const currentSliceZeroBased = useViewerStore((s) => s.currentSliceZeroBased);
  const totalSlices = useViewerStore((s) => s.totalSlices);
  const isDirty = useViewerStore((s) => s.isDirty);
  const dirtySlices = useViewerStore((s) => s.dirtySlices);
  const occupiedSlices = useViewerStore((s) => s.occupiedSlices);
  const canUndoCurrentSlice = useViewerStore((s) => s.canUndoCurrentSlice);
  const canRedoCurrentSlice = useViewerStore((s) => s.canRedoCurrentSlice);
  const historyLimitMessage = useViewerStore((s) => s.historyLimitMessage);
  const zoomLevel = useViewerStore((s) => s.zoomLevel);
  const panOffset = useViewerStore((s) => s.panOffset);
  const windowLevel = useViewerStore((s) => s.windowLevel);
  const crosshairVoxel = useViewerStore((s) => s.crosshairVoxel);

  const setCaseContext = useViewerStore((s) => s.setCaseContext);
  const setActiveVersionId = useViewerStore((s) => s.setActiveVersionId);
  const setLayoutMode = useViewerStore((s) => s.setLayoutMode);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const setActiveLabel = useViewerStore((s) => s.setActiveLabel);
  const setBrushRadius = useViewerStore((s) => s.setBrushRadius);
  const setMaskOpacityPercent = useViewerStore((s) => s.setMaskOpacityPercent);
  const toggleLabelVisibility = useViewerStore((s) => s.toggleLabelVisibility);
  const setModality = useViewerStore((s) => s.setModality);
  const setSliceIndex = useViewerStore((s) => s.setSliceIndex);
  const setTotalSlices = useViewerStore((s) => s.setTotalSlices);
  const syncEngineState = useViewerStore((s) => s.syncEngineState);
  const setZoomLevel = useViewerStore((s) => s.setZoomLevel);
  const setPanOffset = useViewerStore((s) => s.setPanOffset);
  const setWindowLevel = useViewerStore((s) => s.setWindowLevel);
  const setCrosshairVoxel = useViewerStore((s) => s.setCrosshairVoxel);
  const resetViewportTransform = useViewerStore((s) => s.resetViewportTransform);

  const [viewportWidth, setViewportWidth] = React.useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1280,
  );
  const [sliceInputText, setSliceInputText] = React.useState<string>('1');
  const [renderRevision, setRenderRevision] = React.useState<number>(0);
  const [volumeLoadStatus, setVolumeLoadStatus] = React.useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [volumeLoadError, setVolumeLoadError] = React.useState<string | null>(
    null,
  );
  const [selectedVersionId, setSelectedVersionId] = React.useState<
    string | null
  >(null);
  const [versionMetadata, setVersionMetadata] =
    React.useState<MaskVersionMetadataDto | null>(null);

  const [saveNoteModalOpen, setSaveNoteModalOpen] = React.useState(false);
  const [dirtySwitchModalOpen, setDirtySwitchModalOpen] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [conflictModalOpen, setConflictModalOpen] = React.useState(false);
  const [pendingRetry, setPendingRetry] =
    React.useState<PendingRetryPayload | null>(null);
  const [pendingNavAction, setPendingNavAction] =
    React.useState<PendingNavigationAction | null>(null);
  const [exportAfterSave, setExportAfterSave] = React.useState(false);
  const [printAfterSave, setPrintAfterSave] = React.useState(false);
  const [dirtyExportModalOpen, setDirtyExportModalOpen] = React.useState(false);
  const [dirtyPrintModalOpen, setDirtyPrintModalOpen] = React.useState(false);
  const [newAiVersionNotice, setNewAiVersionNotice] =
    React.useState<MaskVersionDto | null>(null);
  const [printTimestampIso, setPrintTimestampIso] = React.useState<string>(() =>
    new Date().toISOString(),
  );
  const [latestFetchSettled, setLatestFetchSettled] = React.useState(true);
  const [versionLoadRevision, setVersionLoadRevision] = React.useState(0);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = React.useState(false);
  const [maximizedPaneId, setMaximizedPaneId] = React.useState<string | null>(
    null,
  );
  const lastNonZeroOpacityRef = React.useRef<number>(40);

  React.useEffect(() => {
    if (maskOpacityPercent > 0) {
      lastNonZeroOpacityRef.current = maskOpacityPercent;
    }
  }, [maskOpacityPercent]);

  const handleToggleMaskOverlay = React.useCallback(() => {
    const current = useViewerStore.getState().maskOpacityPercent;
    if (current > 0) {
      lastNonZeroOpacityRef.current = current;
      setMaskOpacityPercent(0);
    } else {
      setMaskOpacityPercent(
        lastNonZeroOpacityRef.current > 0 ? lastNonZeroOpacityRef.current : 40,
      );
    }
  }, [setMaskOpacityPercent]);

  // Giữ các buffer 3D lớn trong ref để tránh đưa Uint8Array/Float32Array vào React state
  const engineRef = React.useRef<MaskEditorEngine>(new MaskEditorEngine());
  const mriBuffersRef = React.useRef<{
    flair: Float32Array | null;
    t1ce: Float32Array | null;
  }>({ flair: null, t1ce: null });
  const synthAiMaskRef = React.useRef<Uint8Array | null>(null);
  const mriCacheMetaRef = React.useRef<{
    caseId: string | null;
    shapeKey: string | null;
    fileIds: { flair: string | null; t1ce: string | null };
    parsedShape: [number, number, number] | null;
    parsedAffine: number[][] | null;
  }>({
    caseId: null,
    shapeKey: null,
    fileIds: { flair: null, t1ce: null },
    parsedShape: null,
    parsedAffine: null,
  });
  const loadedVersionKeyRef = React.useRef<string | null>(null);
  const loadedBaseVersionIdRef = React.useRef<string | null>(null);
  const localSavedVersionsRef = React.useRef<Map<string, MaskVersionDto>>(
    new Map(),
  );
  const pendingSelectLatestRef = React.useRef(false);
  const initialSelectionDoneRef = React.useRef(false);
  const pendingInitialVersionIdRef = React.useRef<string | null>(null);
  const lastHandledUrlVersionRef = React.useRef<string | null>(null);
  const knownVersionIdsRef = React.useRef<Set<string> | null>(null);
  const activeExportControllerRef = React.useRef<AbortController | null>(null);
  const previousContextRef = React.useRef({ id, userId: user?.id ?? null });
  const lastStrokePointRef = React.useRef<{ x: number; y: number } | null>(null);
  const trackedUrlsRef = React.useRef<Set<string>>(new Set());
  const isMountedRef = React.useRef(true);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const clearPendingSaveFollowUps = React.useCallback(() => {
    setDirtySwitchModalOpen(false);
    setPendingNavAction(null);
    setExportAfterSave(false);
    setPrintAfterSave(false);
  }, []);

  const caseQueryKey = React.useMemo(
    () => ['doctor', user?.id ?? 'anon', 'case', id, { fixtureMode }] as const,
    [user?.id, id, fixtureMode],
  );
  const maskVersionsQueryKey = React.useMemo(
    () => ['doctor', user?.id ?? 'anon', 'case', id, 'mask-versions-all'] as const,
    [user?.id, id],
  );

  const caseQuery = useQuery({
    queryKey: caseQueryKey,
    queryFn: ({ signal }) => fetchCaseDetail(id, { signal, fixtureMode }),
    enabled: Boolean(id),
    refetchInterval: (query) =>
      query.state.data?.jobs.some(
        (job) => job.state === 'queued' || job.state === 'running',
      )
        ? 3000
        : false,
    refetchIntervalInBackground: false,
  });

  const maskVersionsQuery = useQuery({
    queryKey: maskVersionsQueryKey,
    queryFn: async ({ signal }) => {
      try {
        return await fetchAllMaskVersions(id, { signal, fixtureMode });
      } catch (error) {
        if (isAbortError(error)) throw error;
        return null;
      }
    },
    enabled: Boolean(id),
  });

  const isAccessOrNotFoundError =
    caseQuery.error instanceof ApiClientError &&
    (caseQuery.error.status === 403 || caseQuery.error.status === 404);

  React.useEffect(() => {
    if (!isAccessOrNotFoundError) return;
    engineRef.current.dispose();
    mriBuffersRef.current = { flair: null, t1ce: null };
    synthAiMaskRef.current = null;
    mriCacheMetaRef.current = {
      caseId: null,
      shapeKey: null,
      fileIds: { flair: null, t1ce: null },
      parsedShape: null,
      parsedAffine: null,
    };
    loadedVersionKeyRef.current = null;
    loadedBaseVersionIdRef.current = null;
  }, [isAccessOrNotFoundError]);

  const latestCaseHeadVersionId =
    caseQuery.data?.caseData.latest_mask_version_id ?? null;
  React.useEffect(() => {
    if (!latestCaseHeadVersionId || maskVersionsQuery.isPending) return;
    const knownInList = maskVersionsQuery.data?.items.some(
      (item) => item.id === latestCaseHeadVersionId,
    );
    if (maskVersionsQuery.data && !knownInList) {
      void queryClient.invalidateQueries({
        queryKey: maskVersionsQueryKey,
        exact: true,
      });
    }
  }, [
    latestCaseHeadVersionId,
    maskVersionsQuery.isPending,
    maskVersionsQuery.data,
    maskVersionsQueryKey,
    queryClient,
  ]);

  useQueryErrorToast(
    caseQuery.data && !isAccessOrNotFoundError ? null : caseQuery.error,
    'Không thể tải dữ liệu ca chụp cho Viewer',
  );

  React.useEffect(() => {
    setCaseContext(id || null, loadedBaseVersionIdRef.current);
  }, [id, selectedVersionId, setCaseContext]);

  React.useEffect(() => {
    const previous = previousContextRef.current;
    if (previous.id !== id || previous.userId !== (user?.id ?? null)) {
      setPendingRetry(null);
      pendingSelectLatestRef.current = false;
      initialSelectionDoneRef.current = false;
      pendingInitialVersionIdRef.current = null;
      lastHandledUrlVersionRef.current = null;
      knownVersionIdsRef.current = null;
      setNewAiVersionNotice(null);
      setSaveNoteModalOpen(false);
      setConflictModalOpen(false);
      setDirtyExportModalOpen(false);
      setDirtyPrintModalOpen(false);
      clearPendingSaveFollowUps();
      setLatestFetchSettled(true);
      mriBuffersRef.current = { flair: null, t1ce: null };
      synthAiMaskRef.current = null;
      mriCacheMetaRef.current = {
        caseId: null,
        shapeKey: null,
        fileIds: { flair: null, t1ce: null },
        parsedShape: null,
        parsedAffine: null,
      };
      loadedVersionKeyRef.current = null;
      loadedBaseVersionIdRef.current = null;
      localSavedVersionsRef.current.clear();
      setActiveVersionId(null);
      setVersionMetadata(null);
      activeExportControllerRef.current?.abort();
      activeExportControllerRef.current = null;
      if (previous.id !== id) {
        setSelectedVersionId(null);
      }
      previousContextRef.current = { id, userId: user?.id ?? null };
    }
  }, [id, user?.id, setActiveVersionId, clearPendingSaveFollowUps]);

  React.useEffect(() => {
    return () => {
      activeExportControllerRef.current?.abort();
      activeExportControllerRef.current = null;
    };
  }, [id, user?.id]);

  React.useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Bảo vệ reload/đóng tab khi có thay đổi chưa lưu
  React.useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const maskVersions = React.useMemo(() => {
    const list =
      maskVersionsQuery.data?.items ?? caseQuery.data?.maskVersions ?? [];
    const byId = new Map<string, MaskVersionDto>();
    for (const ver of localSavedVersionsRef.current.values()) {
      if (ver.case_id === id) {
        byId.set(ver.id, ver);
      }
    }
    for (const ver of list) {
      byId.set(ver.id, ver);
    }
    return Array.from(byId.values()).sort(
      (a, b) => b.version_number - a.version_number,
    );
  }, [maskVersionsQuery.data, caseQuery.data?.maskVersions, id, selectedVersionId]);

  // QA-MASK-06: Theo dõi danh sách phiên bản đã biết để báo "Có kết quả AI mới" mà KHÔNG ghi đè bản đang xem / bản nháp
  React.useEffect(() => {
    if (caseQuery.isPending || maskVersionsQuery.isPending) {
      return;
    }
    if (knownVersionIdsRef.current === null) {
      knownVersionIdsRef.current = new Set(maskVersions.map((v) => v.id));
      return;
    }
    const newlyAdded: MaskVersionDto[] = [];
    for (const ver of maskVersions) {
      if (!knownVersionIdsRef.current.has(ver.id)) {
        knownVersionIdsRef.current.add(ver.id);
        newlyAdded.push(ver);
      }
    }
    const newestNewAi = newlyAdded
      .filter((ver) => ver.source === 'ai')
      .sort((a, b) => b.version_number - a.version_number)[0];
    if (newestNewAi && newestNewAi.id !== selectedVersionId) {
      setNewAiVersionNotice(newestNewAi);
    }
  }, [
    caseQuery.isPending,
    maskVersionsQuery.isPending,
    maskVersions,
    selectedVersionId,
  ]);

  // Chọn phiên bản khi mở ca: ưu tiên ?version=<mask_version_id>, ngược lại chọn bản mới nhất đúng 1 lần
  React.useEffect(() => {
    if (
      pendingInitialVersionIdRef.current !== null &&
      selectedVersionId === pendingInitialVersionIdRef.current
    ) {
      pendingInitialVersionIdRef.current = null;
    }

    if (pendingSelectLatestRef.current) {
      if (!latestFetchSettled) return;
      const latest = maskVersions[0] ?? null;
      pendingSelectLatestRef.current = false;
      initialSelectionDoneRef.current = true;
      pendingInitialVersionIdRef.current = latest?.id ?? null;
      setNewAiVersionNotice(null);
      loadedVersionKeyRef.current = null;
      setVersionLoadRevision((v) => v + 1);
      setSelectedVersionId(latest?.id ?? null);
      return;
    }

    if (
      requestedVersionParam &&
      lastHandledUrlVersionRef.current !== requestedVersionParam
    ) {
      const matched = maskVersions.find(
        (ver) => ver.id === requestedVersionParam,
      );
      if (matched) {
        lastHandledUrlVersionRef.current = requestedVersionParam;
        initialSelectionDoneRef.current = true;
        if (isDirty && selectedVersionId !== matched.id) {
          setPendingNavAction({
            type: 'switch-version',
            versionId: matched.id,
          });
          setDirtySwitchModalOpen(true);
        } else {
          if (selectedVersionId !== matched.id) {
            pendingInitialVersionIdRef.current = matched.id;
          }
          setSelectedVersionId(matched.id);
        }
        return;
      }
      if (!caseQuery.isPending && !maskVersionsQuery.isPending) {
        lastHandledUrlVersionRef.current = requestedVersionParam;
        if (!initialSelectionDoneRef.current) {
          initialSelectionDoneRef.current = true;
          if (!isDirty && selectedVersionId === null && maskVersions.length > 0) {
            const targetId = maskVersions[0]!.id;
            pendingInitialVersionIdRef.current = targetId;
            setSelectedVersionId(targetId);
          }
        }
      }
      return;
    }

    if (!initialSelectionDoneRef.current) {
      if (isDirty) {
        initialSelectionDoneRef.current = true;
        return;
      }
      if (
        caseQuery.data?.caseData.latest_mask_version_id &&
        maskVersions.length === 0 &&
        maskVersionsQuery.isPending
      ) {
        return;
      }
      if (maskVersions.length > 0 && selectedVersionId === null) {
        const targetId = maskVersions[0]!.id;
        initialSelectionDoneRef.current = true;
        pendingInitialVersionIdRef.current = targetId;
        setSelectedVersionId(targetId);
      } else if (!caseQuery.isPending && !maskVersionsQuery.isPending) {
        initialSelectionDoneRef.current = true;
      }
    }
  }, [
    maskVersions,
    selectedVersionId,
    latestFetchSettled,
    requestedVersionParam,
    caseQuery.isPending,
    caseQuery.data?.caseData.latest_mask_version_id,
    maskVersionsQuery.isPending,
    isDirty,
  ]);

  React.useEffect(() => {
    if (newAiVersionNotice && selectedVersionId === newAiVersionNotice.id) {
      setNewAiVersionNotice(null);
    }
  }, [newAiVersionNotice, selectedVersionId]);

  const selectedVersion: MaskVersionDto | null = React.useMemo(
    () => maskVersions.find((v) => v.id === selectedVersionId) ?? null,
    [maskVersions, selectedVersionId],
  );

  const availableModalities = React.useMemo(() => {
    if (fixtureMode) {
      return new Set<VolumeModality>(['flair', 't1ce']);
    }
    const vols = (caseQuery.data?.volumes ?? []).filter(
      (v) => !v.validation_status || v.validation_status === 'valid',
    );
    return new Set<VolumeModality>(vols.map((v) => v.modality));
  }, [fixtureMode, caseQuery.data?.volumes]);

  // Đồng bộ modality về xung hiện có trong Live API mode nếu xung đang chọn chưa tồn tại
  React.useEffect(() => {
    if (fixtureMode || !caseQuery.data) return;
    if (availableModalities.size > 0 && !availableModalities.has(modality)) {
      const fallbackMod: VolumeModality = availableModalities.has('flair')
        ? 'flair'
        : 't1ce';
      setModality(fallbackMod);
    }
  }, [fixtureMode, caseQuery.data, availableModalities, modality, setModality]);

  const referenceVolume = React.useMemo(() => {
    const vols = caseQuery.data?.volumes ?? [];
    const refId = caseQuery.data?.caseData.reference_volume_id;
    return (
      vols.find((v) => v.id === refId) ??
      vols.find((v) => v.modality === 'flair') ??
      vols[0] ??
      null
    );
  }, [caseQuery.data]);

  const activeVolume = React.useMemo(() => {
    const vols = caseQuery.data?.volumes ?? [];
    return vols.find((v) => v.modality === modality) ?? vols[0] ?? null;
  }, [caseQuery.data, modality]);

  const volumeGeometry: VolumeGeometry | null = React.useMemo(() => {
    const vol = activeVolume ?? referenceVolume;
    if (!vol?.shape || !vol.spacing_mm || !vol.affine) {
      return null;
    }
    return {
      shape: vol.shape,
      spacingMm: vol.spacing_mm,
      affine: vol.affine,
      orientationCode: vol.orientation ?? undefined,
    };
  }, [activeVolume, referenceVolume]);

  const activeShape: [number, number, number] = volumeGeometry?.shape ?? [
    240, 240, 155,
  ];
  const activeAffine = volumeGeometry?.affine ?? [
    [1, 0, 0, -120],
    [0, 1, 0, -120],
    [0, 0, 1, -78],
    [0, 0, 0, 1],
  ];
  const axialAxes = React.useMemo(
    () => resolveAxialSliceAxes(activeAffine, activeShape),
    [activeAffine, activeShape],
  );
  const coronalAxes = React.useMemo(
    () => resolvePlaneAxes('coronal', activeAffine, activeShape),
    [activeAffine, activeShape],
  );
  const sagittalAxes = React.useMemo(
    () => resolvePlaneAxes('sagittal', activeAffine, activeShape),
    [activeAffine, activeShape],
  );

  React.useEffect(() => {
    if (volumeGeometry) {
      const count = getAxialSliceCount(
        volumeGeometry.shape,
        volumeGeometry.affine,
      );
      if (count > 0) {
        setTotalSlices(count);
      }
    }
  }, [id, volumeGeometry, setTotalSlices]);

  const syncStoreFromEngine = React.useCallback(
    (sliceIdx: number) => {
      const engine = engineRef.current;
      syncEngineState({
        isDirty: engine.isDirty(),
        dirtySlices: Array.from(engine.getDirtySlices()),
        occupiedSlices: Array.from(engine.getOccupiedSlices()),
        canUndoCurrentSlice: engine.canUndo(sliceIdx),
        canRedoCurrentSlice: engine.canRedo(sliceIdx),
        historyLimitMessage: engine.getHistoryLimitMessage(),
      });
    },
    [syncEngineState],
  );

  const syncCrosshairForLoadedVolume = React.useCallback(
    (
      targetShape: readonly [number, number, number],
      targetAffine: number[][],
    ): number => {
      const resolvedAxial = resolveAxialSliceAxes(targetAffine, targetShape);
      const activeSlice = clampSliceIndex(
        useViewerStore.getState().currentSliceZeroBased,
        resolvedAxial.totalSlices,
      );
      const prevCrosshair = useViewerStore.getState().crosshairVoxel;
      const nextCrosshair: [number, number, number] =
        prevCrosshair &&
        prevCrosshair[0] >= 0 &&
        prevCrosshair[0] < targetShape[0] &&
        prevCrosshair[1] >= 0 &&
        prevCrosshair[1] < targetShape[1] &&
        prevCrosshair[2] >= 0 &&
        prevCrosshair[2] < targetShape[2]
          ? [prevCrosshair[0], prevCrosshair[1], prevCrosshair[2]]
          : [
              Math.floor(targetShape[0] / 2),
              Math.floor(targetShape[1] / 2),
              Math.floor(targetShape[2] / 2),
            ];
      nextCrosshair[resolvedAxial.axialAxis] = activeSlice;
      setCrosshairVoxel(nextCrosshair);
      return activeSlice;
    },
    [setCrosshairVoxel],
  );

  // Cập nhật trạng thái undo/redo khi chuyển lát
  React.useEffect(() => {
    if (!engineRef.current.isInitialized()) return;
    syncStoreFromEngine(currentSliceZeroBased);
  }, [currentSliceZeroBased, syncStoreFromEngine]);

  // Nạp dữ liệu MRI và mask tách biệt cache: đổi xung không tải lại mask, đổi mask không tải lại MRI
  React.useEffect(() => {
    if (!caseQuery.data || !volumeGeometry || isAccessOrNotFoundError) return;
    if (
      !initialSelectionDoneRef.current ||
      pendingSelectLatestRef.current ||
      (pendingInitialVersionIdRef.current !== null &&
        selectedVersionId !== pendingInitialVersionIdRef.current) ||
      (!isDirty &&
        selectedVersionId === null &&
        maskVersions.length > 0 &&
        loadedVersionKeyRef.current === null)
    ) {
      return;
    }

    const targetVerId = selectedVersion?.id ?? selectedVersionId ?? 'none';
    const versionKey = `${id}:${targetVerId}`;
    const needMaskLoad =
      !engineRef.current.isInitialized() ||
      loadedVersionKeyRef.current !== versionKey;

    if (fixtureMode) {
      const shapeKey = volumeGeometry.shape.join('x');
      const needFixtureMri =
        mriCacheMetaRef.current.caseId !== id ||
        mriCacheMetaRef.current.shapeKey !== shapeKey ||
        !mriBuffersRef.current.flair ||
        !mriBuffersRef.current.t1ce;

      if (!needFixtureMri && !needMaskLoad) {
        setVolumeLoadError(null);
        setVolumeLoadStatus('ready');
        setRenderRevision((v) => v + 1);
        return;
      }

      const abortController = new AbortController();
      let cancelled = false;

      const loadFixtureData = async () => {
        setVolumeLoadStatus('loading');
        setVolumeLoadError(null);

        try {
          if (needFixtureMri) {
            const synth = createSyntheticBrainVolumes(volumeGeometry.shape);
            mriBuffersRef.current = {
              flair: synth.flair,
              t1ce: synth.t1ce,
            };
            synthAiMaskRef.current = synth.aiMask;
            mriCacheMetaRef.current = {
              caseId: id,
              shapeKey,
              fileIds: { flair: 'fixture-flair', t1ce: 'fixture-t1ce' },
              parsedShape: [...volumeGeometry.shape],
              parsedAffine: volumeGeometry.affine.map((r) => [...r]),
            };
          }

          if (needMaskLoad) {
            let initialMask = createEmptyMaskBuffer(volumeGeometry.shape);
            if (selectedVersion) {
              const [savedBuf, meta] = await Promise.all([
                downloadProtectedFileBuffer(selectedVersion.file_id, {
                  signal: abortController.signal,
                  fixtureMode: true,
                }),
                fetchMaskVersionMetadata(selectedVersion.id, {
                  signal: abortController.signal,
                  fixtureMode: true,
                }).catch(() => null),
              ]);
              if (cancelled) return;
              setVersionMetadata(meta);
              if (savedBuf.byteLength > 0) {
                const parsedMask = await parseNiftiVolume(savedBuf);
                initialMask = parsedVolumeToUint8Mask(parsedMask);
              } else if (selectedVersion.source === 'ai') {
                if (
                  synthAiMaskRef.current &&
                  synthAiMaskRef.current.length === initialMask.length
                ) {
                  initialMask = new Uint8Array(synthAiMaskRef.current);
                } else {
                  const synth = createSyntheticBrainVolumes(volumeGeometry.shape);
                  synthAiMaskRef.current = synth.aiMask;
                  initialMask = new Uint8Array(synth.aiMask);
                }
              }
            } else {
              setVersionMetadata(null);
            }

            if (cancelled) return;
            engineRef.current.initialize(
              initialMask,
              volumeGeometry.shape,
              volumeGeometry.affine,
            );
            loadedVersionKeyRef.current = versionKey;
            loadedBaseVersionIdRef.current =
              selectedVersion?.id ?? selectedVersionId ?? null;
            setActiveVersionId(selectedVersion?.id ?? selectedVersionId ?? null);
          }

          const activeSlice = syncCrosshairForLoadedVolume(
            volumeGeometry.shape,
            volumeGeometry.affine,
          );
          syncStoreFromEngine(activeSlice);
          setRenderRevision((v) => v + 1);
          setVolumeLoadStatus('ready');
        } catch (err) {
          if (cancelled || isAbortError(err)) return;
          const normalized = normalizeApiError(err);
          setVolumeLoadStatus('error');
          setVolumeLoadError(normalized.message);
        }
      };

      void loadFixtureData();
      return () => {
        cancelled = true;
        abortController.abort();
      };
    }

    // Live API mode
    const volToFetch = activeVolume ?? referenceVolume;
    if (!volToFetch) {
      setVolumeLoadStatus('error');
      setVolumeLoadError('Ca chụp chưa có khối ảnh MRI hợp lệ.');
      return;
    }

    const isSameCaseCache = mriCacheMetaRef.current.caseId === id;
    if (!isSameCaseCache) {
      mriBuffersRef.current = { flair: null, t1ce: null };
      mriCacheMetaRef.current = {
        caseId: id,
        shapeKey: null,
        fileIds: { flair: null, t1ce: null },
        parsedShape: null,
        parsedAffine: null,
      };
    }

    const hasCachedMriForModality =
      mriCacheMetaRef.current.fileIds[volToFetch.modality] ===
        volToFetch.file_id &&
      mriBuffersRef.current[volToFetch.modality] !== null;
    const needMriLoad = !hasCachedMriForModality;

    if (!needMriLoad && !needMaskLoad) {
      setVolumeLoadError(null);
      setVolumeLoadStatus('ready');
      setRenderRevision((v) => v + 1);
      return;
    }

    const abortController = new AbortController();
    let cancelled = false;

    const loadLiveData = async () => {
      setVolumeLoadStatus('loading');
      setVolumeLoadError(null);

      try {
        let mriShape: [number, number, number] =
          mriCacheMetaRef.current.parsedShape ?? volumeGeometry.shape;
        let mriAffine: number[][] =
          mriCacheMetaRef.current.parsedAffine ?? volumeGeometry.affine;

        if (needMriLoad) {
          const mriArrayBuf = await downloadProtectedFileBuffer(
            volToFetch.file_id,
            {
              signal: abortController.signal,
              fixtureMode: false,
            },
          );
          const parsedMri = await parseNiftiVolume(mriArrayBuf);
          if (cancelled) return;

          mriBuffersRef.current = {
            ...mriBuffersRef.current,
            [volToFetch.modality]: parsedMri.data,
          };
          mriCacheMetaRef.current = {
            caseId: id,
            shapeKey: parsedMri.shape.join('x'),
            fileIds: {
              ...mriCacheMetaRef.current.fileIds,
              [volToFetch.modality]: volToFetch.file_id,
            },
            parsedShape: parsedMri.shape,
            parsedAffine: parsedMri.affine,
          };
          mriShape = parsedMri.shape;
          mriAffine = parsedMri.affine;
        }

        if (needMaskLoad) {
          let maskArr = createEmptyMaskBuffer(mriShape);
          if (selectedVersion) {
            const [maskArrayBuf, meta] = await Promise.all([
              downloadProtectedFileBuffer(selectedVersion.file_id, {
                signal: abortController.signal,
                fixtureMode: false,
              }),
              fetchMaskVersionMetadata(selectedVersion.id, {
                signal: abortController.signal,
                fixtureMode: false,
              }).catch(() => null),
            ]);
            if (cancelled) return;
            setVersionMetadata(meta);
            if (maskArrayBuf.byteLength > 0) {
              const parsedMask = await parseNiftiVolume(maskArrayBuf);
              if (
                parsedMask.shape[0] !== mriShape[0] ||
                parsedMask.shape[1] !== mriShape[1] ||
                parsedMask.shape[2] !== mriShape[2]
              ) {
                throw new Error(
                  'Kích thước lưới mask không khớp với khối ảnh MRI tham chiếu.',
                );
              }
              maskArr = parsedVolumeToUint8Mask(parsedMask);
            }
          } else {
            setVersionMetadata(null);
          }

          if (cancelled) return;
          engineRef.current.initialize(maskArr, mriShape, mriAffine);
          loadedVersionKeyRef.current = versionKey;
          loadedBaseVersionIdRef.current =
            selectedVersion?.id ?? selectedVersionId ?? null;
          setActiveVersionId(selectedVersion?.id ?? selectedVersionId ?? null);
        }

        const activeSlice = syncCrosshairForLoadedVolume(mriShape, mriAffine);
        syncStoreFromEngine(activeSlice);
        setRenderRevision((v) => v + 1);
        setVolumeLoadStatus('ready');
      } catch (err) {
        if (cancelled || isAbortError(err)) return;
        const normalized = normalizeApiError(err);
        setVolumeLoadStatus('error');
        setVolumeLoadError(normalized.message);
      }
    };

    void loadLiveData();

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [
    id,
    caseQuery.data,
    isAccessOrNotFoundError,
    volumeGeometry?.shape[0],
    volumeGeometry?.shape[1],
    volumeGeometry?.shape[2],
    selectedVersion?.id,
    selectedVersionId,
    maskVersions.length,
    maskVersionsQuery.isPending,
    activeVolume?.id,
    activeVolume?.file_id,
    modality,
    fixtureMode,
    versionLoadRevision,
    isDirty,
    setActiveVersionId,
    syncCrosshairForLoadedVolume,
    syncStoreFromEngine,
  ]);

  // Dọn dẹp buffer, tracked object URLs & reset viewer state khi unmount hoặc đổi ca
  React.useEffect(() => {
    return () => {
      engineRef.current.dispose();
      mriBuffersRef.current = { flair: null, t1ce: null };
      synthAiMaskRef.current = null;
      mriCacheMetaRef.current = {
        caseId: null,
        shapeKey: null,
        fileIds: { flair: null, t1ce: null },
        parsedShape: null,
        parsedAffine: null,
      };
      for (const url of trackedUrlsRef.current) {
        revokeTrackedObjectUrl(url);
      }
      trackedUrlsRef.current.clear();
      useViewerStore.getState().resetViewerState();
    };
  }, [id]);

  const editorCapability = React.useMemo(
    () => checkViewportEditorCapability(viewportWidth, volumeGeometry),
    [viewportWidth, volumeGeometry],
  );
  const canEditMask = editorCapability.canEdit && !reauthRequired && !isSaving;

  const isSinglePaneViewport = viewportWidth < DESKTOP_EDITOR_MIN_WIDTH_PX;
  const effectiveLayoutMode: ViewerLayoutMode = isSinglePaneViewport
    ? 'comparison'
    : layoutMode;

  const navigateToSlice = React.useCallback(
    (sliceIndex: number) => {
      if (engineRef.current.hasActiveStroke()) return;
      const effectiveTotal = Math.max(1, totalSlices || axialAxes.totalSlices);
      const clamped = clampSliceIndex(sliceIndex, effectiveTotal);
      setSliceIndex(clamped);
      const prevCrosshair = useViewerStore.getState().crosshairVoxel;
      const nextCrosshair: [number, number, number] = prevCrosshair
        ? [prevCrosshair[0], prevCrosshair[1], prevCrosshair[2]]
        : [
            Math.floor(activeShape[0] / 2),
            Math.floor(activeShape[1] / 2),
            Math.floor(activeShape[2] / 2),
          ];
      nextCrosshair[axialAxes.axialAxis] = clamped;
      setCrosshairVoxel(nextCrosshair);
    },
    [
      totalSlices,
      axialAxes.totalSlices,
      axialAxes.axialAxis,
      activeShape,
      setSliceIndex,
      setCrosshairVoxel,
    ],
  );

  const oneBasedSlice = toOneBasedSlice(currentSliceZeroBased, totalSlices);
  const adjacentSlices = getAdjacentSliceIndices(
    currentSliceZeroBased,
    totalSlices,
  );

  React.useEffect(() => {
    setSliceInputText(String(oneBasedSlice));
  }, [oneBasedSlice]);

  React.useEffect(() => {
    setMaximizedPaneId(null);
  }, [effectiveLayoutMode, isSinglePaneViewport]);

  const isAnyModalOpen =
    saveNoteModalOpen ||
    dirtySwitchModalOpen ||
    conflictModalOpen ||
    dirtyExportModalOpen ||
    dirtyPrintModalOpen;

  // Phím tắt chuyển lát (ArrowLeft/Right/Up/Down), Undo/Redo (Ctrl+Z / Ctrl+Y) & Phím tắt lâm sàng (V, B, E, 1, 2, 4, [, ], M, F, Esc)
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableElementFocused(e.target) || isAnyModalOpen) {
        return;
      }
      if (engineRef.current.hasActiveStroke()) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (!canEditMask) return;
        e.preventDefault();
        const changed = e.shiftKey
          ? engineRef.current.redo(currentSliceZeroBased)
          : engineRef.current.undo(currentSliceZeroBased);
        if (changed) {
          syncStoreFromEngine(currentSliceZeroBased);
          setRenderRevision((v) => v + 1);
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        if (!canEditMask) return;
        e.preventDefault();
        if (engineRef.current.redo(currentSliceZeroBased)) {
          syncStoreFromEngine(currentSliceZeroBased);
          setRenderRevision((v) => v + 1);
        }
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        navigateToSlice(currentSliceZeroBased - 1);
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        navigateToSlice(currentSliceZeroBased + 1);
        return;
      }

      if (e.key === 'Escape') {
        if (maximizedPaneId !== null) {
          e.preventDefault();
          setMaximizedPaneId(null);
          return;
        }
        if (isFullscreen) {
          e.preventDefault();
          setIsFullscreen(false);
          return;
        }
      }

      const keyLower = e.key.toLowerCase();
      if (keyLower === 'v') {
        e.preventDefault();
        setActiveTool('view');
        return;
      }
      if (keyLower === 'b') {
        if (canEditMask) {
          e.preventDefault();
          setActiveTool('brush');
        }
        return;
      }
      if (keyLower === 'e') {
        if (canEditMask) {
          e.preventDefault();
          setActiveTool('erase');
        }
        return;
      }
      if (e.key === '1') {
        if (canEditMask) {
          e.preventDefault();
          setActiveLabel(1);
        }
        return;
      }
      if (e.key === '2') {
        if (canEditMask) {
          e.preventDefault();
          setActiveLabel(2);
        }
        return;
      }
      if (e.key === '4') {
        if (canEditMask) {
          e.preventDefault();
          setActiveLabel(4);
        }
        return;
      }
      if (e.key === '[') {
        if (canEditMask) {
          e.preventDefault();
          setBrushRadius(useViewerStore.getState().brushRadius - 1);
        }
        return;
      }
      if (e.key === ']') {
        if (canEditMask) {
          e.preventDefault();
          setBrushRadius(useViewerStore.getState().brushRadius + 1);
        }
        return;
      }
      if (keyLower === 'm') {
        e.preventDefault();
        handleToggleMaskOverlay();
        return;
      }
      if (keyLower === 'f') {
        e.preventDefault();
        setIsFullscreen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    canEditMask,
    currentSliceZeroBased,
    navigateToSlice,
    syncStoreFromEngine,
    isAnyModalOpen,
    maximizedPaneId,
    isFullscreen,
    setActiveTool,
    setActiveLabel,
    setBrushRadius,
    handleToggleMaskOverlay,
  ]);

  const commitSliceInput = () => {
    const parsed = Number.parseInt(sliceInputText, 10);
    if (!Number.isFinite(parsed)) {
      setSliceInputText(String(oneBasedSlice));
      return;
    }
    const nextZero = toZeroBasedSlice(parsed, totalSlices);
    navigateToSlice(nextZero);
    setSliceInputText(String(toOneBasedSlice(nextZero, totalSlices)));
  };

  // Thao tác vẽ brush / erase trên lát axial hiện tại
  const applyBrushAtDisplayPoint = React.useCallback(
    (displayX: number, displayY: number) => {
      if (!volumeGeometry || !engineRef.current.isInitialized()) return;
      const voxel = displayPointToVoxelCoord(
        displayX,
        displayY,
        currentSliceZeroBased,
        volumeGeometry.affine,
        volumeGeometry.shape,
      );
      const indices = computeSliceBrushIndices(
        voxel,
        brushRadius,
        currentSliceZeroBased,
        volumeGeometry.affine,
        volumeGeometry.shape,
      );
       if (engineRef.current.extendStroke(indices, currentSliceZeroBased)) {
        syncStoreFromEngine(currentSliceZeroBased);
        setRenderRevision((v) => v + 1);
      }
    },
    [volumeGeometry, currentSliceZeroBased, brushRadius, syncStoreFromEngine],
  );

  const handleStrokeStart = React.useCallback(
    (displayX: number, displayY: number) => {
      if (!canEditMask || !volumeGeometry || activeTool === 'view') return;
      const targetVal: BraTSLabelId =
        activeTool === 'erase' ? 0 : activeLabel;
      engineRef.current.beginStroke(currentSliceZeroBased, targetVal);
      lastStrokePointRef.current = { x: displayX, y: displayY };
      applyBrushAtDisplayPoint(displayX, displayY);
    },
    [
      canEditMask,
      volumeGeometry,
      activeTool,
      activeLabel,
      currentSliceZeroBased,
      applyBrushAtDisplayPoint,
    ],
  );

  const handleStrokeMove = React.useCallback(
    (displayX: number, displayY: number) => {
      if (!canEditMask || !volumeGeometry || activeTool === 'view') return;
      const prev = lastStrokePointRef.current ?? { x: displayX, y: displayY };
      const points = interpolateDisplayStroke(prev, {
        x: displayX,
        y: displayY,
      });
      lastStrokePointRef.current = { x: displayX, y: displayY };

      let anyChanged = false;
      for (const pt of points) {
        const voxel = displayPointToVoxelCoord(
          pt.x,
          pt.y,
          currentSliceZeroBased,
          volumeGeometry.affine,
          volumeGeometry.shape,
        );
        const indices = computeSliceBrushIndices(
          voxel,
          brushRadius,
          currentSliceZeroBased,
          volumeGeometry.affine,
          volumeGeometry.shape,
        );
        if (engineRef.current.extendStroke(indices, currentSliceZeroBased)) {
          anyChanged = true;
        }
      }
      if (anyChanged) {
        syncStoreFromEngine(currentSliceZeroBased);
        setRenderRevision((v) => v + 1);
      }
    },
    [
      canEditMask,
      volumeGeometry,
      activeTool,
      currentSliceZeroBased,
      brushRadius,
      syncStoreFromEngine,
    ],
  );

  const handleStrokeEnd = React.useCallback(() => {
    lastStrokePointRef.current = null;
    if (engineRef.current.commitStroke()) {
      const sliceIdx = useViewerStore.getState().currentSliceZeroBased;
      if (isMountedRef.current) {
        syncStoreFromEngine(sliceIdx);
        setRenderRevision((v) => v + 1);
      }
    }
  }, [syncStoreFromEngine]);

  const handleUndo = () => {
    if (!canEditMask || engineRef.current.hasActiveStroke()) return;
    if (engineRef.current.undo(currentSliceZeroBased)) {
      syncStoreFromEngine(currentSliceZeroBased);
      setRenderRevision((v) => v + 1);
    }
  };

  const handleRedo = () => {
    if (!canEditMask || engineRef.current.hasActiveStroke()) return;
    if (engineRef.current.redo(currentSliceZeroBased)) {
      syncStoreFromEngine(currentSliceZeroBased);
      setRenderRevision((v) => v + 1);
    }
  };

  const prevMaskSlice = React.useMemo(
    () =>
      findNextMaskSlice(
        new Set(occupiedSlices),
        new Set(dirtySlices),
        currentSliceZeroBased,
        'prev',
      ),
    [occupiedSlices, dirtySlices, currentSliceZeroBased],
  );

  const nextMaskSlice = React.useMemo(
    () =>
      findNextMaskSlice(
        new Set(occupiedSlices),
        new Set(dirtySlices),
        currentSliceZeroBased,
        'next',
      ),
    [occupiedSlices, dirtySlices, currentSliceZeroBased],
  );

  // Thống kê thể tích live O(1) từ bộ đếm trong engine (không quét lại 8.93M voxel mỗi pointermove)
  const liveStats = React.useMemo(() => {
    if (!volumeGeometry || !engineRef.current.isInitialized()) return null;
    return engineRef.current.getVolumeStatistics(volumeGeometry.affine);
  }, [volumeGeometry, renderRevision]);

  const executeSavePayload = async (
    payload: PendingRetryPayload,
  ): Promise<MaskVersionDto | null> => {
    setIsSaving(true);
    try {
      const saved = await saveManualMaskVersion(
        id,
        {
          maskBlob: payload.maskBlob,
          referenceVolumeId: payload.referenceVolumeId,
          baseVersionId: payload.baseVersionId,
          note: payload.note,
          idempotencyKey: payload.idempotencyKey,
          fixtureMaskBytes: payload.serializedNiftiBytes,
          fixtureCounts: payload.counts,
          fixtureVolumesMm3: payload.volumesMm3,
        },
        { fixtureMode },
      );

      setPendingRetry(null);
      setSaveNoteModalOpen(false);
      setDirtySwitchModalOpen(false);
      engineRef.current.markSaved(payload.snapshot);
      syncStoreFromEngine(currentSliceZeroBased);

      localSavedVersionsRef.current.set(saved.id, saved);
      knownVersionIdsRef.current?.add(saved.id);
      loadedBaseVersionIdRef.current = saved.id;
      loadedVersionKeyRef.current = `${id}:${saved.id}`;
      setActiveVersionId(saved.id);
      setVersionMetadata(null);
      setSelectedVersionId(saved.id);

      queryClient.setQueryData<PaginatedResponse<MaskVersionDto> | null>(
        maskVersionsQueryKey,
        (old) => {
          const items = [
            saved,
            ...(old?.items ?? []).filter((item) => item.id !== saved.id),
          ].sort((a, b) => b.version_number - a.version_number);
          return {
            items,
            total: Math.max(old?.total ?? 0, items.length),
            page: 1,
            page_size: 100,
          };
        },
      );
      queryClient.setQueryData<typeof caseQuery.data>(caseQueryKey, (old) =>
        old
          ? {
              ...old,
              maskVersions: [
                saved,
                ...old.maskVersions.filter((item) => item.id !== saved.id),
              ].sort((a, b) => b.version_number - a.version_number),
            }
          : old,
      );

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: caseQueryKey, exact: true }),
        queryClient.invalidateQueries({
          queryKey: maskVersionsQueryKey,
          exact: true,
        }),
      ]);

      pushToast({
        variant: 'success',
        title: `Đã lưu phiên bản v${saved.version_number}`,
        description: 'Bản mask thủ công mới đã được ghi nhận an toàn.',
      });
      return saved;
    } catch (err) {
      if (isAbortError(err)) {
        return null;
      }

      if (err instanceof ApiClientError && err.status === 409) {
        if (err.code.toLowerCase() === 'mask_version_conflict') {
          setPendingRetry(null);
          setSaveNoteModalOpen(false);
          clearPendingSaveFollowUps();
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: caseQueryKey,
              exact: true,
            }),
            queryClient.invalidateQueries({
              queryKey: maskVersionsQueryKey,
              exact: true,
            }),
          ]);
          setConflictModalOpen(true);
          return null;
        }
      }

      const normalized = normalizeApiError(err);
      if (
        normalized.status === 0 ||
        normalized.status >= 500 ||
        normalized.code === 'network_error'
      ) {
        setPendingRetry(payload);
        setSaveNoteModalOpen(false);
        setDirtySwitchModalOpen(false);
      } else {
        setPendingRetry(null);
        setSaveNoteModalOpen(false);
        clearPendingSaveFollowUps();
      }

      pushToast({
        variant: 'error',
        title: 'Không thể lưu phiên bản mask',
        description: normalized.message,
      });
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  const handleConfirmSaveNote = async (note: string) => {
    if (!volumeGeometry || !referenceVolume || !engineRef.current.isInitialized()) {
      return;
    }
    const snapshot = engineRef.current.getWorkingMaskSnapshot();
    const stats = engineRef.current.getVolumeStatistics(volumeGeometry.affine);
    const normalizedBaseVersionId = loadedBaseVersionIdRef.current;

    const canReusePending =
      pendingRetry !== null &&
      pendingRetry.note.trim() === note.trim() &&
      pendingRetry.baseVersionId === normalizedBaseVersionId &&
      pendingRetry.referenceVolumeId === referenceVolume.id &&
      areUint8ArraysEqual(pendingRetry.snapshot, snapshot);

    let serializedNiftiBytes: Uint8Array;
    let maskBlob: Blob;
    let idempotencyKey: string;

    if (canReusePending && pendingRetry) {
      serializedNiftiBytes = pendingRetry.serializedNiftiBytes;
      maskBlob = pendingRetry.maskBlob;
      idempotencyKey = pendingRetry.idempotencyKey;
    } else {
      const gzBytes = await serializeNiftiMask(snapshot, volumeGeometry, {
        gzip: true,
      });
      const gzCopy = new Uint8Array(gzBytes.byteLength);
      gzCopy.set(gzBytes);
      serializedNiftiBytes = gzCopy;
      maskBlob = new Blob([gzCopy.buffer], { type: 'application/gzip' });
      idempotencyKey = createUuid();
    }

    const payload: PendingRetryPayload = {
      maskBlob,
      serializedNiftiBytes,
      idempotencyKey,
      referenceVolumeId: referenceVolume.id,
      baseVersionId: normalizedBaseVersionId,
      note,
      snapshot,
      counts: {
        '1': stats.counts[1],
        '2': stats.counts[2],
        '4': stats.counts[4],
      },
      volumesMm3: {
        '1': stats.volumesMm3[1],
        '2': stats.volumesMm3[2],
        '4': stats.volumesMm3[4],
      },
    };

    const saved = await executeSavePayload(payload);
    if (saved) {
      if (pendingNavAction) {
        const action = pendingNavAction;
        clearPendingSaveFollowUps();
        if (action.type === 'switch-version') {
          setSelectedVersionId(action.versionId);
        } else {
          navigate(action.to);
        }
      } else if (exportAfterSave) {
        setExportAfterSave(false);
        await handleExportSavedVersion(saved);
      } else if (printAfterSave) {
        setPrintAfterSave(false);
        flushSync(() => {
          setPrintTimestampIso(new Date().toISOString());
        });
        window.print();
      }
    }
  };

  const triggerBrowserPrint = React.useCallback(() => {
    flushSync(() => {
      setPrintTimestampIso(new Date().toISOString());
    });
    window.print();
  }, []);

  const handlePrintClick = () => {
    if (!selectedVersion) return;
    if (isDirty) {
      setDirtyPrintModalOpen(true);
      return;
    }
    triggerBrowserPrint();
  };

  const handleDownloadLocalDraft = async () => {
    if (!volumeGeometry || !engineRef.current.isInitialized()) return;
    const snapshot = engineRef.current.getWorkingMaskSnapshot();
    const gzBytes = await serializeNiftiMask(snapshot, volumeGeometry, {
      gzip: true,
    });
    const gzCopy = new Uint8Array(gzBytes.byteLength);
    gzCopy.set(gzBytes);
    const blob = new Blob([gzCopy.buffer], { type: 'application/gzip' });
    triggerBrowserBlobDownload(blob, `mask-draft-${id}.nii.gz`);
    pushToast({
      variant: 'info',
      title: 'Đã tải bản nháp cục bộ',
      description: `Tên tệp: mask-draft-${id}.nii.gz`,
    });
  };

  const handleExportSavedVersion = async (version: MaskVersionDto) => {
    activeExportControllerRef.current?.abort();
    const controller = new AbortController();
    activeExportControllerRef.current = controller;
    const exportEpoch = getSessionEpoch();
    try {
      let blob: Blob;
      if (fixtureMode && volumeGeometry && engineRef.current.isInitialized()) {
        const gzBytes = await serializeNiftiMask(
          engineRef.current.getBaseBuffer(),
          volumeGeometry,
          { gzip: true },
        );
        const gzCopy = new Uint8Array(gzBytes.byteLength);
        gzCopy.set(gzBytes);
        blob = new Blob([gzCopy.buffer], { type: 'application/gzip' });
      } else {
        blob = await downloadMaskVersionExport(version.id, {
          signal: controller.signal,
          fixtureMode,
        });
      }
      if (exportEpoch !== getSessionEpoch() || controller.signal.aborted) return;
      triggerBrowserBlobDownload(
        blob,
        `mask-case-${id}-v${version.version_number}.nii.gz`,
      );
    } catch (err) {
      if (isAbortError(err)) return;
      pushToast({
        variant: 'error',
        title: 'Không thể xuất tệp mask',
        description: normalizeApiError(err).message,
      });
    } finally {
      if (activeExportControllerRef.current === controller) {
        activeExportControllerRef.current = null;
      }
    }
  };

  const handleExportClick = () => {
    if (isDirty) {
      setDirtyExportModalOpen(true);
      return;
    }
    if (selectedVersion) {
      void handleExportSavedVersion(selectedVersion);
    } else {
      void handleDownloadLocalDraft();
    }
  };

  const handleVersionSelectChange = (nextVersionId: string) => {
    if (!nextVersionId || nextVersionId === selectedVersionId) return;
    if (isDirty) {
      setPendingNavAction({ type: 'switch-version', versionId: nextVersionId });
      setDirtySwitchModalOpen(true);
      return;
    }
    setPendingRetry(null);
    setSelectedVersionId(nextVersionId);
  };

  const handleLeaveClick = (e: React.MouseEvent, to: string) => {
    if (isDirty) {
      e.preventDefault();
      setPendingNavAction({ type: 'leave-page', to });
      setDirtySwitchModalOpen(true);
    }
  };

  const activeMriBuffer =
    modality === 't1ce'
      ? (mriBuffersRef.current.t1ce ?? mriBuffersRef.current.flair)
      : (mriBuffersRef.current.flair ?? mriBuffersRef.current.t1ce);

  const coronalSliceIndex = crosshairVoxel
    ? crosshairVoxel[coronalAxes.sliceAxis]
    : Math.floor(coronalAxes.totalSlices / 2);
  const sagittalSliceIndex = crosshairVoxel
    ? crosshairVoxel[sagittalAxes.sliceAxis]
    : Math.floor(sagittalAxes.totalSlices / 2);

  const selectCrosshairOnPlane = React.useCallback(
    (
      plane: SlicePlaneType,
      paneSliceIndex: number | null,
      displayX: number,
      displayY: number,
    ) => {
      if (paneSliceIndex === null) return;
      const voxel = planeDisplayPointToVoxelCoord(
        plane,
        displayX,
        displayY,
        paneSliceIndex,
        activeAffine,
        activeShape,
      );
      setCrosshairVoxel(voxel);
      const nextAxialSlice = voxel[axialAxes.axialAxis];
      if (
        nextAxialSlice !== currentSliceZeroBased &&
        !engineRef.current.hasActiveStroke()
      ) {
        setSliceIndex(nextAxialSlice);
      }
    },
    [
      activeAffine,
      activeShape,
      axialAxes.axialAxis,
      currentSliceZeroBased,
      setCrosshairVoxel,
      setSliceIndex,
    ],
  );

  const handleCrosshairSelect = React.useCallback(
    (displayX: number, displayY: number) => {
      selectCrosshairOnPlane('axial', currentSliceZeroBased, displayX, displayY);
    },
    [selectCrosshairOnPlane, currentSliceZeroBased],
  );

  const handleWheelSlice = React.useCallback(
    (delta: number) => {
      navigateToSlice(useViewerStore.getState().currentSliceZeroBased + delta);
    },
    [navigateToSlice],
  );

  const handleZoomDelta = React.useCallback(
    (delta: number) => {
      setZoomLevel(useViewerStore.getState().zoomLevel + delta);
    },
    [setZoomLevel],
  );

  const handlePanDelta = React.useCallback(
    (dx: number, dy: number) => {
      const prev = useViewerStore.getState().panOffset;
      setPanOffset({ x: prev.x + dx, y: prev.y + dy });
    },
    [setPanOffset],
  );

  const handleBrushRadiusDelta = React.useCallback(
    (delta: number) => {
      if (!canEditMask) return;
      setBrushRadius(useViewerStore.getState().brushRadius + delta);
    },
    [canEditMask, setBrushRadius],
  );

  const toggleMaximizePane = React.useCallback((paneId: string) => {
    setMaximizedPaneId((prev) => (prev === paneId ? null : paneId));
  }, []);

  const darkOutlineBtnClass =
    'border-slate-700 bg-slate-900/90 text-slate-100 hover:border-slate-600 hover:bg-slate-800 disabled:border-slate-800 disabled:bg-slate-900/40 disabled:text-slate-500';
  const darkSaveBtnClass =
    'border-emerald-500/60 bg-emerald-600 text-white hover:bg-emerald-500 disabled:border-slate-800 disabled:bg-slate-900/40 disabled:text-slate-500';

  // Chỉ sử dụng metadata khớp đúng phiên bản đang chọn để không bao giờ trộn số liệu giữa v1 và v2
  const matchedMetadata = React.useMemo(
    () =>
      selectedVersion &&
      versionMetadata &&
      versionMetadata.version_id === selectedVersion.id
        ? versionMetadata
        : null,
    [selectedVersion, versionMetadata],
  );

  const savedPrintSummary = React.useMemo(() => {
    if (!selectedVersion) return null;
    const caseData = caseQuery.data?.caseData;
    const studyDate =
      matchedMetadata?.study_date ?? caseData?.study_date ?? '—';
    const perLabel = BRATS_TUMOR_LABEL_IDS.map((lbl) => {
      const metaRow = matchedMetadata?.statistics.per_label.find(
        (item) => item.label === lbl,
      );
      const voxelCount =
        metaRow?.voxel_count ??
        (selectedVersion.label_voxel_counts?.[String(lbl)] ?? 0);
      const volumeMm3 =
        metaRow?.volume_mm3 ??
        (selectedVersion.label_volumes_mm3?.[String(lbl)] ?? 0);
      const volumeMl = metaRow?.volume_ml ?? volumeMm3 / 1000;
      return {
        label: lbl,
        shortName: BRATS_LABELS[lbl].shortName,
        description: BRATS_LABELS[lbl].description,
        voxelCount,
        volumeMm3,
        volumeMl,
      };
    });
    const totalSegmentedVoxels =
      matchedMetadata?.statistics.total_foreground_voxels ??
      perLabel.reduce((sum, row) => sum + row.voxelCount, 0);
    const totalSegmentedMm3 =
      matchedMetadata?.statistics.total_foreground_volume_mm3 ??
      perLabel.reduce((sum, row) => sum + row.volumeMm3, 0);
    const totalSegmentedMl =
      matchedMetadata?.statistics.total_foreground_volume_ml ??
      totalSegmentedMm3 / 1000;
    const compositeGroups = BRATS_COMPOSITE_GROUPS.map((grp) => {
      const metaGrp = matchedMetadata?.statistics.composite_groups.find(
        (item) => item.group === grp.key,
      );
      const serverMm3 = selectedVersion.composite_volumes_mm3?.[grp.key];
      const volumeMm3 =
        metaGrp?.volume_mm3 ??
        serverMm3 ??
        grp.includedLabels.reduce(
          (sum, lbl) =>
            sum + (selectedVersion.label_volumes_mm3?.[String(lbl)] ?? 0),
          0,
        );
      const volumeMl = metaGrp?.volume_ml ?? volumeMm3 / 1000;
      return {
        group: grp.key,
        label: grp.label,
        volumeMm3,
        volumeMl,
      };
    });
    const coverageNote =
      matchedMetadata?.coverage?.note ??
      (selectedVersion.source === 'ai' || selectedVersion.coverage_file_id
        ? 'Vùng ngoài phạm vi crop của mô hình AI chưa được đánh giá tự động.'
        : null);
    const shape =
      matchedMetadata?.geometry.shape ??
      (referenceVolume?.shape ? [...referenceVolume.shape] : activeShape);
    const spacingMm =
      matchedMetadata?.geometry.spacing_mm ??
      (referenceVolume?.spacing_mm
        ? [...referenceVolume.spacing_mm]
        : [1, 1, 1]);
    const orientation =
      matchedMetadata?.geometry.orientation ??
      referenceVolume?.orientation ??
      'RAS';

    return {
      caseId: matchedMetadata?.case_id ?? selectedVersion.case_id,
      patientCode: caseData?.patient_code ?? null,
      studyDate,
      versionId: selectedVersion.id,
      versionNumber: selectedVersion.version_number,
      source: selectedVersion.source,
      modelVersion:
        matchedMetadata?.model_version_id ?? selectedVersion.model_version_id,
      authorName:
        matchedMetadata?.created_by_name ??
        selectedVersion.created_by_name ??
        (selectedVersion.source === 'ai' ? 'Hệ thống AI' : 'Bác sĩ điều trị'),
      jobId: matchedMetadata?.job_id ?? selectedVersion.job_id,
      createdAt: selectedVersion.created_at,
      note: selectedVersion.note,
      sha256: matchedMetadata?.sha256 ?? selectedVersion.sha256,
      coverageNote,
      shape,
      spacingMm,
      orientation,
      perLabel,
      totalSegmentedVoxels,
      totalSegmentedMm3,
      totalSegmentedMl,
      compositeGroups,
    };
  }, [
    selectedVersion,
    matchedMetadata,
    caseQuery.data?.caseData,
    referenceVolume,
    activeShape,
  ]);

  const handleExportMetadataJson = async () => {
    if (!selectedVersion || !savedPrintSummary) return;
    if (isDirty) {
      setDirtyExportModalOpen(true);
      return;
    }
    try {
      const serverMeta =
        matchedMetadata ??
        (await fetchMaskVersionMetadata(selectedVersion.id, {
          fixtureMode,
        }).catch(() => null));
      const jsonPayload = serverMeta ?? {
        version_id: savedPrintSummary.versionId,
        case_id: savedPrintSummary.caseId,
        study_date: savedPrintSummary.studyDate,
        version_number: savedPrintSummary.versionNumber,
        source: savedPrintSummary.source,
        base_version_id: selectedVersion.base_version_id,
        reference_volume_id: selectedVersion.reference_volume_id,
        model_version_id: savedPrintSummary.modelVersion,
        job_id: savedPrintSummary.jobId,
        created_at: savedPrintSummary.createdAt,
        created_by_name: savedPrintSummary.authorName,
        sha256: savedPrintSummary.sha256,
        labels: {
          '0': BRATS_LABELS[0].shortName,
          '1': BRATS_LABELS[1].shortName,
          '2': BRATS_LABELS[2].shortName,
          '4': BRATS_LABELS[4].shortName,
        },
        coverage: {
          status: savedPrintSummary.source === 'ai' ? 'ai_evaluated' : 'manual',
          coverage_file_id: selectedVersion.coverage_file_id ?? null,
          note:
            savedPrintSummary.coverageNote ??
            'Thống kê áp dụng cho phiên bản mask đã lưu đang chọn.',
        },
        geometry: {
          shape: savedPrintSummary.shape,
          spacing_mm: savedPrintSummary.spacingMm,
          affine: referenceVolume?.affine ?? activeAffine,
          orientation: savedPrintSummary.orientation,
          units: 'mm',
        },
        statistics: {
          per_label: savedPrintSummary.perLabel.map((item) => ({
            label: item.label,
            name: item.shortName,
            voxel_count: item.voxelCount,
            volume_mm3: item.volumeMm3,
            volume_ml: item.volumeMl,
          })),
          composite_groups: savedPrintSummary.compositeGroups.map((item) => ({
            group: item.group,
            volume_mm3: item.volumeMm3,
            volume_ml: item.volumeMl,
          })),
          total_foreground_voxels: savedPrintSummary.totalSegmentedVoxels,
          total_foreground_volume_mm3: savedPrintSummary.totalSegmentedMm3,
          total_foreground_volume_ml: savedPrintSummary.totalSegmentedMl,
        },
      };
      const blob = new Blob([JSON.stringify(jsonPayload, null, 2)], {
        type: 'application/json',
      });
      triggerBrowserBlobDownload(
        blob,
        `mask-case-${id}-v${selectedVersion.version_number}-metadata.json`,
      );
    } catch (err) {
      if (isAbortError(err)) return;
      pushToast({
        variant: 'error',
        title: 'Không thể xuất JSON metadata',
        description: normalizeApiError(err).message,
      });
    }
  };

  if (caseQuery.isError && (!caseQuery.data || isAccessOrNotFoundError)) {
    return (
      <div className="flex flex-col gap-4">
        <Link
          to={`/doctor/cases/${id}`}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Quay lại ca chụp
        </Link>
        <ErrorState
          title="Không thể mở Viewer cho ca chụp này"
          error={caseQuery.error}
          onRetry={() => {
            void caseQuery.refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="mri-viewer-workspace"
      data-volume-status={volumeLoadStatus}
      data-fullscreen={isFullscreen ? 'true' : 'false'}
      className={cn(
        'flex flex-col gap-2.5 bg-[var(--viewer-bg)] text-[var(--viewer-text)] sm:gap-3',
        isFullscreen
          ? 'fixed inset-0 z-50 h-dvh w-screen overflow-y-auto rounded-none border-0 bg-[#0B1020] p-2.5 sm:p-3'
          : 'rounded-xl border border-[var(--viewer-border)] p-3 sm:p-3.5',
      )}
    >
      {/* Top toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-[var(--viewer-border)] bg-[var(--viewer-surface)] px-3 py-2 sm:px-3.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <Link
            to={`/doctor/cases/${id}`}
            onClick={(e) => handleLeaveClick(e, `/doctor/cases/${id}`)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-900/90 px-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-800 hover:text-white"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Chi tiết ca
          </Link>
          <span
            aria-hidden="true"
            className="hidden h-5 w-px bg-slate-700/80 sm:block"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-sm font-bold text-[var(--viewer-text)] sm:text-base">
                Trình xem &amp; chỉnh sửa Mask MRI
              </h1>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold',
                  editorCapability.canEdit
                    ? 'border-sky-500/40 bg-sky-950/80 text-sky-300'
                    : 'border-amber-500/40 bg-amber-950/80 text-amber-300',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-1.5 rounded-full',
                    editorCapability.canEdit ? 'bg-sky-400' : 'bg-amber-400',
                  )}
                />
                {editorCapability.canEdit ? 'Chế độ chỉnh sửa' : 'Chế độ chỉ đọc'}
              </span>
              {isDirty && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/50 bg-amber-950/90 px-2 py-0.5 text-[11px] font-semibold text-amber-200">
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-amber-400"
                  />
                  Có thay đổi chưa lưu
                </span>
              )}
            </div>
            <p className="break-all font-mono text-[11px] text-[var(--viewer-text-muted)] sm:break-normal">
              Ca: {id} · Lát {oneBasedSlice}/{totalSlices}
              <span className="sr-only"> (0-based: {currentSliceZeroBased})</span>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {maskVersions.length > 0 && (
            <label className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-950/90 pr-1 pl-2.5 text-xs text-slate-300">
              <span className="font-medium text-slate-400">Phiên bản:</span>
              <select
                aria-label="Chọn phiên bản mask"
                value={selectedVersionId ?? ''}
                onChange={(e) => handleVersionSelectChange(e.target.value)}
                className="h-6 cursor-pointer rounded-md border-0 bg-slate-900 px-2 text-xs font-semibold text-slate-100 focus:ring-1 focus:ring-sky-400 focus:outline-none"
              >
                {selectedVersionId === null && (
                  <option value="" disabled>
                    Bản nháp mới (chưa lưu)
                  </option>
                )}
                {maskVersions.map((ver) => (
                  <option key={ver.id} value={ver.id}>
                    v{ver.version_number} ·{' '}
                    {ver.source === 'ai' ? 'AI gốc' : 'Thủ công'}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div
            role="group"
            aria-label="Chọn xung MRI"
            className="inline-flex h-8 items-center gap-0.5 rounded-lg border border-slate-700/80 bg-slate-950/90 p-0.5"
          >
            {(['flair', 't1ce'] as const).map((mod) => {
              const isModDisabled =
                !fixtureMode &&
                Boolean(caseQuery.data) &&
                !availableModalities.has(mod);
              return (
                <button
                  key={mod}
                  type="button"
                  disabled={isModDisabled}
                  aria-pressed={modality === mod}
                  onClick={() => {
                    if (!isModDisabled) {
                      setModality(mod);
                    }
                  }}
                  className={cn(
                    'inline-flex h-7 cursor-pointer items-center justify-center rounded-md px-2.5 text-xs font-semibold uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                    modality === mod
                      ? 'bg-sky-600 text-white shadow-xs'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white',
                  )}
                >
                  {mod}
                </button>
              );
            })}
          </div>

          <div className="inline-flex items-center gap-1.5">
            <button
              type="button"
              aria-label={
                inspectorCollapsed ? 'Mở bảng thông số' : 'Thu gọn bảng thông số'
              }
              aria-pressed={!inspectorCollapsed}
              title={
                inspectorCollapsed
                  ? 'Hiện bảng thông số bên phải'
                  : 'Thu gọn bảng thông số bên phải để mở rộng vùng vẽ'
              }
              onClick={() => setInspectorCollapsed((prev) => !prev)}
              className={cn(
                'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors',
                inspectorCollapsed
                  ? 'border-sky-500/50 bg-sky-950/70 text-sky-200 hover:bg-sky-900/70'
                  : 'border-slate-700/80 bg-slate-900/90 text-slate-200 hover:border-slate-600 hover:bg-slate-800',
              )}
            >
              {inspectorCollapsed ? (
                <PanelRightOpen className="size-3.5 text-sky-400" aria-hidden="true" />
              ) : (
                <PanelRightClose className="size-3.5 text-slate-300" aria-hidden="true" />
              )}
              <span className="hidden xl:inline">
                {inspectorCollapsed ? 'Hiện thông số' : 'Ẩn thông số'}
              </span>
            </button>

            <button
              type="button"
              aria-pressed={isFullscreen}
              title={
                isFullscreen
                  ? 'Thoát chế độ toàn màn hình (Phím F / Esc)'
                  : 'Mở rộng toàn màn hình trạm làm việc (Phím F)'
              }
              onClick={() => setIsFullscreen((prev) => !prev)}
              className={cn(
                'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors',
                isFullscreen
                  ? 'border-sky-400 bg-sky-600 text-white hover:bg-sky-500'
                  : 'border-slate-700/80 bg-slate-900/90 text-slate-100 hover:border-slate-500 hover:bg-slate-800',
              )}
            >
              {isFullscreen ? (
                <Minimize2 className="size-3.5" aria-hidden="true" />
              ) : (
                <Maximize2 className="size-3.5" aria-hidden="true" />
              )}
              {isFullscreen ? 'Thu nhỏ' : 'Toàn màn hình'}
            </button>
          </div>
        </div>
      </div>

      {/* Read-only lock banner when viewport < 1024px or oblique */}
      {!editorCapability.canEdit && editorCapability.reason && (
        <Alert
          variant="warning"
          title="Chỉnh sửa mask đang tạm khóa"
          description={editorCapability.reason}
          className="border-amber-500/40 bg-amber-950/60 text-[var(--viewer-text)] [&>div>p]:text-[var(--viewer-text)]"
        />
      )}

      {/* History limit eviction warning */}
      {historyLimitMessage && (
        <Alert
          variant="info"
          title="Giới hạn bộ nhớ hoàn tác"
          description={historyLimitMessage}
          className="border-sky-500/40 bg-sky-950/60 text-[var(--viewer-text)] [&>div>p]:text-[var(--viewer-text)]"
        />
      )}

      {/* Idempotent retry banner on timeout / 5xx */}
      {pendingRetry && (
        <Alert
          variant="warning"
          title="Lưu phiên bản chưa nhận được xác nhận từ máy chủ"
          description="Hệ thống đã giữ nguyên gói dữ liệu và khóa Idempotency-Key. Bạn có thể thử gửi lại để tránh tạo trùng phiên bản."
          className="border-amber-500/40 bg-amber-950/60 text-[var(--viewer-text)] [&>div>p]:text-[var(--viewer-text)]"
          action={
            <Button
              size="sm"
              variant="primary"
              disabled={isSaving}
              onClick={() => {
                void executeSavePayload(pendingRetry);
              }}
            >
              Thử lại lưu (cùng khóa)
            </Button>
          }
        />
      )}

      {volumeLoadStatus === 'error' && volumeLoadError && (
        <Alert variant="error" title="Lỗi nạp dữ liệu ảnh" description={volumeLoadError} />
      )}

      {/* QA-MASK-06: Thông báo có kết quả AI mới mà không ghi đè bản nháp hoặc đổi phiên bản đang xem */}
      {newAiVersionNotice && (
        <Alert
          variant="info"
          title="Có kết quả AI mới"
          description={`Phiên bản v${newAiVersionNotice.version_number} từ mô hình AI vừa hoàn tất. Phiên bản đang xem${isDirty ? ' và bản nháp chỉnh sửa chưa lưu của bạn' : ''} được giữ nguyên, không tự động ghi đè.`}
          className="border-sky-500/40 bg-sky-950/60 text-[var(--viewer-text)] [&>div>p]:text-[var(--viewer-text)]"
          action={
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => handleVersionSelectChange(newAiVersionNotice.id)}
              >
                Mở v{newAiVersionNotice.version_number} (AI)
              </Button>
              <Button
                size="sm"
                variant="outline"
                className={darkOutlineBtnClass}
                onClick={() => setNewAiVersionNotice(null)}
              >
                Đóng
              </Button>
            </div>
          }
        />
      )}

      {/* Main workstation grid */}
      <div
        className={cn(
          'grid grid-cols-1 items-start gap-3',
          !inspectorCollapsed &&
            'lg:grid-cols-[minmax(0,1fr)_280px] xl:grid-cols-[minmax(0,1fr)_316px]',
        )}
      >
        {/* Viewport canvas + slice navigation */}
        <div className="flex min-w-0 flex-col gap-2.5">
          {/* Unified Painting Dock (2-tier structured clinical ribbon) */}
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--viewer-border)] bg-[var(--viewer-surface)] px-3 py-2">
            {/* Tier 1: Chế độ thao tác · Hoàn tác/Làm lại · Bố cục khung nhìn · Lưu & Xuất */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div
                role="group"
                aria-label="Công cụ tương tác"
                className="flex flex-wrap items-center gap-2"
              >
                {/* Cụm chuyển đổi công cụ (Segmented Tool Switcher) */}
                <div className="inline-flex items-center gap-0.5 rounded-lg border border-slate-700/80 bg-slate-950/90 p-0.5">
                  <button
                    type="button"
                    aria-pressed={!canEditMask || activeTool === 'view'}
                    title="Chế độ xem lát cắt và di chuyển tâm chữ thập (Phím tắt: V)"
                    onClick={() => setActiveTool('view')}
                    className={cn(
                      'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors',
                      !canEditMask || activeTool === 'view'
                        ? 'bg-sky-600 text-white shadow-xs'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white',
                    )}
                  >
                    <Eye className="size-3.5" aria-hidden="true" />
                    Xem lát
                  </button>

                  <button
                    type="button"
                    disabled={!canEditMask}
                    aria-pressed={canEditMask && activeTool === 'brush'}
                    title={
                      canEditMask
                        ? 'Tô nhãn đang chọn trên lát axial hiện tại (Phím tắt: B)'
                        : (editorCapability.reason ?? 'Phiên đang chờ xác thực lại')
                    }
                    onClick={() => setActiveTool('brush')}
                    className={cn(
                      'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                      canEditMask && activeTool === 'brush'
                        ? 'bg-sky-600 text-white shadow-xs'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white',
                    )}
                  >
                    {!canEditMask ? (
                      <Lock className="size-3.5" aria-hidden="true" />
                    ) : (
                      <Paintbrush className="size-3.5" aria-hidden="true" />
                    )}
                    Tô mask
                  </button>

                  <button
                    type="button"
                    disabled={!canEditMask}
                    aria-pressed={canEditMask && activeTool === 'erase'}
                    title={
                      canEditMask
                        ? 'Xóa nhãn về nền (0) cho tất cả nhãn tại các voxel chạm tới trên lát axial hiện tại (Phím tắt: E)'
                        : (editorCapability.reason ?? 'Phiên đang chờ xác thực lại')
                    }
                    onClick={() => setActiveTool('erase')}
                    className={cn(
                      'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                      canEditMask && activeTool === 'erase'
                        ? 'bg-rose-600 text-white shadow-xs'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white',
                    )}
                  >
                    <Eraser className="size-3.5" aria-hidden="true" />
                    Xóa mask
                  </button>
                </div>

                {/* Cụm Hoàn tác / Làm lại (Segmented History) */}
                <div className="inline-flex items-center gap-0.5 rounded-lg border border-slate-700/80 bg-slate-950/90 p-0.5">
                  <button
                    type="button"
                    disabled={!canEditMask || !canUndoCurrentSlice}
                    title="Hoàn tác nét vẽ trên lát hiện tại (Ctrl+Z)"
                    onClick={handleUndo}
                    className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Undo2 className="size-3.5" aria-hidden="true" />
                    Hoàn tác
                  </button>
                  <span
                    aria-hidden="true"
                    className="h-4 w-px bg-slate-800"
                  />
                  <button
                    type="button"
                    disabled={!canEditMask || !canRedoCurrentSlice}
                    title="Làm lại nét vẽ trên lát hiện tại (Ctrl+Shift+Z)"
                    onClick={handleRedo}
                    className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Redo2 className="size-3.5" aria-hidden="true" />
                    Làm lại
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* Cụm Bố cục khung nhìn (Segmented Layout Switcher) */}
                {!isSinglePaneViewport && (
                  <div
                    role="group"
                    aria-label="Bố cục khung nhìn"
                    className="inline-flex items-center gap-0.5 rounded-lg border border-slate-700/80 bg-slate-950/90 p-0.5"
                  >
                    {(
                      [
                        { id: 'comparison', label: 'Đối chiếu' },
                        { id: 'adjacent', label: 'Lát lân cận' },
                        { id: 'three-plane', label: 'Ba mặt phẳng' },
                      ] as const
                    ).map((layout) => (
                      <button
                        key={layout.id}
                        type="button"
                        aria-pressed={effectiveLayoutMode === layout.id}
                        onClick={() => setLayoutMode(layout.id)}
                        className={cn(
                          'inline-flex h-7 cursor-pointer items-center rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors',
                          effectiveLayoutMode === layout.id
                            ? 'bg-sky-600 text-white shadow-xs'
                            : 'text-slate-300 hover:bg-slate-800 hover:text-white',
                        )}
                      >
                        {layout.label}
                      </button>
                    ))}
                  </div>
                )}

                {/* Cụm Lưu phiên bản & Xuất (.nii.gz) */}
                <div className="inline-flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={!canEditMask || !isDirty || isSaving}
                    title="Lưu phiên bản mask thủ công mới"
                    onClick={() => {
                      clearPendingSaveFollowUps();
                      setSaveNoteModalOpen(true);
                    }}
                    className={cn(
                      'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed',
                      darkSaveBtnClass,
                    )}
                  >
                    <Save className="size-3.5" aria-hidden="true" />
                    Lưu phiên bản
                  </button>

                  <button
                    type="button"
                    onClick={handleExportClick}
                    title="Xuất tệp mask .nii.gz"
                    className={cn(
                      'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors',
                      darkOutlineBtnClass,
                    )}
                  >
                    <Download className="size-3.5" aria-hidden="true" />
                    Xuất (.nii.gz)
                  </button>
                </div>
              </div>
            </div>

            {/* Tier 2: Chọn nhanh nhãn tô · Cỡ cọ · Ẩn/Hiện lớp phủ mask */}
            <div
              role="group"
              aria-label="Chọn nhanh nhãn và cỡ cọ"
              className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/90 pt-2"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium text-slate-400">
                  Nhãn tô:
                </span>
                <div className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-950/90 p-0.5">
                  {BRATS_TUMOR_LABEL_IDS.map((labelId) => {
                    const spec = BRATS_LABELS[labelId];
                    const isSelected = activeLabel === labelId;
                    return (
                      <button
                        key={`dock-lbl-${labelId}`}
                        type="button"
                        disabled={!canEditMask}
                        aria-label={`Chọn nhanh nhãn ${labelId}`}
                        aria-pressed={isSelected}
                        title={`${spec.shortName} — ${spec.description} (Phím tắt: ${labelId})`}
                        onClick={() => {
                          setActiveLabel(labelId);
                          if (activeTool === 'view') {
                            setActiveTool('brush');
                          }
                        }}
                        className={cn(
                          'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                          isSelected
                            ? 'border-sky-400/80 bg-sky-950 text-white shadow-xs'
                            : 'border-transparent text-slate-300 hover:bg-slate-800/80 hover:text-white',
                        )}
                      >
                        <span
                          className="size-2.5 rounded-full border border-white/30"
                          style={{ backgroundColor: spec.hexColor ?? undefined }}
                          aria-hidden="true"
                        />
                        <span>Nhãn {labelId}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-slate-400">
                    Cỡ cọ:
                  </span>
                  <div className="inline-flex h-7 items-center rounded-lg border border-slate-700/80 bg-slate-950/90 px-1 text-xs">
                    <button
                      type="button"
                      aria-label="Giảm cỡ cọ"
                      disabled={!canEditMask || brushRadius <= 1}
                      title="Giảm bán kính cọ 1 pixel (Phím tắt: [)"
                      onClick={() => setBrushRadius(brushRadius - 1)}
                      className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-40"
                    >
                      -
                    </button>
                    <span
                      className="inline-flex min-w-[46px] items-center justify-center gap-1 px-1.5 font-mono text-[11px] font-semibold text-slate-200 tabular-nums"
                      title="Bán kính cọ vẽ hiện tại (Giữ Alt + Lăn chuột để chỉnh nhanh)"
                    >
                      <span
                        className="rounded-full border border-white/30"
                        style={{
                          width: `${Math.min(11, Math.max(5, brushRadius + 3))}px`,
                          height: `${Math.min(11, Math.max(5, brushRadius + 3))}px`,
                          backgroundColor:
                            activeTool === 'erase'
                              ? '#F87171'
                              : (BRATS_LABELS[activeLabel].hexColor ?? '#F59E0B'),
                        }}
                        aria-hidden="true"
                      />
                      {brushRadius}px
                    </span>
                    <button
                      type="button"
                      aria-label="Tăng cỡ cọ"
                      disabled={!canEditMask || brushRadius >= 20}
                      title="Tăng bán kính cọ 1 pixel (Phím tắt: ])"
                      onClick={() => setBrushRadius(brushRadius + 1)}
                      className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  aria-label="Ẩn/Hiện lớp phủ mask"
                  aria-pressed={maskOpacityPercent > 0}
                  title="Bật/tắt nhanh lớp phủ mask để đối chiếu nhu mô não gốc (Phím tắt: M)"
                  onClick={handleToggleMaskOverlay}
                  className={cn(
                    'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors',
                    maskOpacityPercent > 0
                      ? 'border-sky-500/50 bg-sky-950/80 text-sky-200 hover:bg-sky-900/70'
                      : 'border-slate-700/80 bg-slate-950/90 text-slate-400 hover:bg-slate-800',
                  )}
                >
                  {maskOpacityPercent > 0 ? (
                    <Eye className="size-3.5 text-sky-400" aria-hidden="true" />
                  ) : (
                    <EyeOff className="size-3.5 text-slate-400" aria-hidden="true" />
                  )}
                  <span>Mask ({maskOpacityPercent}%)</span>
                </button>
              </div>
            </div>
          </div>

          {/* Canvas panes theo bố cục */}

          {effectiveLayoutMode === 'comparison' && (
            <div
              className={cn(
                'grid gap-3',
                isSinglePaneViewport || maximizedPaneId !== null
                  ? 'grid-cols-1'
                  : 'grid-cols-2',
              )}
            >
              {!isSinglePaneViewport &&
                (maximizedPaneId === null ||
                  maximizedPaneId === 'pane-original') && (
                  <SliceCanvasPane
                    testId="pane-original"
                    title="MRI gốc (Chỉ đọc)"
                    plane="axial"
                    sliceIndex={currentSliceZeroBased}
                    shape={activeShape}
                    affine={activeAffine}
                    mriBuffer={activeMriBuffer}
                    maskBuffer={null}
                    showMask={false}
                    editable={false}
                    activeTool={activeTool}
                    activeLabel={activeLabel}
                    brushRadius={brushRadius}
                    maskOpacityPercent={maskOpacityPercent}
                    visibleLabels={visibleLabels}
                    windowLevel={windowLevel}
                    zoomLevel={zoomLevel}
                    panOffset={panOffset}
                    crosshairVoxel={crosshairVoxel}
                    renderRevision={renderRevision}
                    isFullscreen={isFullscreen}
                    isMaximized={maximizedPaneId === 'pane-original'}
                    onToggleMaximize={() => toggleMaximizePane('pane-original')}
                    onResetView={resetViewportTransform}
                    onSelectCrosshair={handleCrosshairSelect}
                    onWheelSlice={handleWheelSlice}
                    onZoomDelta={handleZoomDelta}
                    onPanDelta={handlePanDelta}
                    onBrushRadiusDelta={handleBrushRadiusDelta}
                  />
                )}

              {(maximizedPaneId === null ||
                maximizedPaneId === 'pane-axial-editable') && (
                <SliceCanvasPane
                  testId="pane-axial-editable"
                  title={
                    isSinglePaneViewport
                      ? 'MRI + Lớp phủ Mask (Chỉ đọc)'
                      : 'MRI + Lớp phủ Mask (Axial)'
                  }
                  plane="axial"
                  sliceIndex={currentSliceZeroBased}
                  shape={activeShape}
                  affine={activeAffine}
                  mriBuffer={activeMriBuffer}
                  maskBuffer={
                    engineRef.current.isInitialized()
                      ? engineRef.current.getWorkingBuffer()
                      : null
                  }
                  showMask={true}
                  editable={canEditMask && !isSinglePaneViewport}
                  activeTool={activeTool}
                  activeLabel={activeLabel}
                  brushRadius={brushRadius}
                  maskOpacityPercent={maskOpacityPercent}
                  visibleLabels={visibleLabels}
                  windowLevel={windowLevel}
                  zoomLevel={zoomLevel}
                  panOffset={panOffset}
                  crosshairVoxel={crosshairVoxel}
                  renderRevision={renderRevision}
                  isFullscreen={isFullscreen}
                  isMaximized={maximizedPaneId === 'pane-axial-editable'}
                  onToggleMaximize={
                    !isSinglePaneViewport
                      ? () => toggleMaximizePane('pane-axial-editable')
                      : undefined
                  }
                  onResetView={resetViewportTransform}
                  onStrokeStart={handleStrokeStart}
                  onStrokeMove={handleStrokeMove}
                  onStrokeEnd={handleStrokeEnd}
                  onSelectCrosshair={handleCrosshairSelect}
                  onWheelSlice={handleWheelSlice}
                  onZoomDelta={handleZoomDelta}
                  onPanDelta={handlePanDelta}
                  onBrushRadiusDelta={handleBrushRadiusDelta}
                />
              )}
            </div>
          )}

          {effectiveLayoutMode === 'adjacent' && (
            <div
              className={cn(
                'grid gap-3',
                maximizedPaneId !== null ? 'grid-cols-1' : 'grid-cols-3',
              )}
            >
              {adjacentSlices.map((adjSlice, slot) => {
                const paneId =
                  slot === 0
                    ? 'pane-adjacent-prev'
                    : slot === 1
                      ? 'pane-axial-editable'
                      : 'pane-adjacent-next';
                if (maximizedPaneId !== null && maximizedPaneId !== paneId) {
                  return null;
                }
                return (
                  <SliceCanvasPane
                    key={slot}
                    testId={paneId}
                    title={
                      slot === 0
                        ? 'Lát trước (k-1)'
                        : slot === 1
                          ? 'Lát hiện tại (k)'
                          : 'Lát sau (k+1)'
                    }
                    plane="axial"
                    sliceIndex={adjSlice}
                    shape={activeShape}
                    affine={activeAffine}
                    mriBuffer={activeMriBuffer}
                    maskBuffer={
                      engineRef.current.isInitialized()
                        ? engineRef.current.getWorkingBuffer()
                        : null
                    }
                    showMask={true}
                    editable={slot === 1 && canEditMask}
                    activeTool={activeTool}
                    activeLabel={activeLabel}
                    brushRadius={brushRadius}
                    maskOpacityPercent={maskOpacityPercent}
                    visibleLabels={visibleLabels}
                    windowLevel={windowLevel}
                    zoomLevel={zoomLevel}
                    panOffset={panOffset}
                    crosshairVoxel={crosshairVoxel}
                    renderRevision={renderRevision}
                    isFullscreen={isFullscreen}
                    isMaximized={maximizedPaneId === paneId}
                    onToggleMaximize={() => toggleMaximizePane(paneId)}
                    onResetView={resetViewportTransform}
                    onStrokeStart={slot === 1 ? handleStrokeStart : undefined}
                    onStrokeMove={slot === 1 ? handleStrokeMove : undefined}
                    onStrokeEnd={slot === 1 ? handleStrokeEnd : undefined}
                    onSelectCrosshair={(dx, dy) =>
                      selectCrosshairOnPlane('axial', adjSlice, dx, dy)
                    }
                    onWheelSlice={handleWheelSlice}
                    onZoomDelta={handleZoomDelta}
                    onPanDelta={handlePanDelta}
                    onBrushRadiusDelta={handleBrushRadiusDelta}
                  />
                );
              })}
            </div>
          )}

          {effectiveLayoutMode === 'three-plane' && (
            <div
              className={cn(
                'grid gap-3',
                maximizedPaneId !== null ? 'grid-cols-1' : 'grid-cols-3',
              )}
            >
              {(maximizedPaneId === null ||
                maximizedPaneId === 'pane-axial-editable') && (
                <SliceCanvasPane
                  testId="pane-axial-editable"
                  title="Mặt phẳng Axial (Sửa được)"
                  plane="axial"
                  sliceIndex={currentSliceZeroBased}
                  shape={activeShape}
                  affine={activeAffine}
                  mriBuffer={activeMriBuffer}
                  maskBuffer={
                    engineRef.current.isInitialized()
                      ? engineRef.current.getWorkingBuffer()
                      : null
                  }
                  showMask={true}
                  editable={canEditMask}
                  activeTool={activeTool}
                  activeLabel={activeLabel}
                  brushRadius={brushRadius}
                  maskOpacityPercent={maskOpacityPercent}
                  visibleLabels={visibleLabels}
                  windowLevel={windowLevel}
                  zoomLevel={zoomLevel}
                  panOffset={panOffset}
                  crosshairVoxel={crosshairVoxel}
                  renderRevision={renderRevision}
                  isFullscreen={isFullscreen}
                  isMaximized={maximizedPaneId === 'pane-axial-editable'}
                  onToggleMaximize={() =>
                    toggleMaximizePane('pane-axial-editable')
                  }
                  onResetView={resetViewportTransform}
                  onStrokeStart={handleStrokeStart}
                  onStrokeMove={handleStrokeMove}
                  onStrokeEnd={handleStrokeEnd}
                  onSelectCrosshair={handleCrosshairSelect}
                  onWheelSlice={handleWheelSlice}
                  onZoomDelta={handleZoomDelta}
                  onPanDelta={handlePanDelta}
                  onBrushRadiusDelta={handleBrushRadiusDelta}
                />
              )}

              {(maximizedPaneId === null ||
                maximizedPaneId === 'pane-coronal-readonly') && (
                <SliceCanvasPane
                  testId="pane-coronal-readonly"
                  title="Mặt phẳng Coronal (Chỉ đọc)"
                  plane="coronal"
                  sliceIndex={coronalSliceIndex}
                  shape={activeShape}
                  affine={activeAffine}
                  mriBuffer={activeMriBuffer}
                  maskBuffer={
                    engineRef.current.isInitialized()
                      ? engineRef.current.getWorkingBuffer()
                      : null
                  }
                  showMask={true}
                  editable={false}
                  activeTool={activeTool}
                  activeLabel={activeLabel}
                  brushRadius={brushRadius}
                  maskOpacityPercent={maskOpacityPercent}
                  visibleLabels={visibleLabels}
                  windowLevel={windowLevel}
                  zoomLevel={zoomLevel}
                  panOffset={panOffset}
                  crosshairVoxel={crosshairVoxel}
                  renderRevision={renderRevision}
                  isFullscreen={isFullscreen}
                  isMaximized={maximizedPaneId === 'pane-coronal-readonly'}
                  onToggleMaximize={() =>
                    toggleMaximizePane('pane-coronal-readonly')
                  }
                  onResetView={resetViewportTransform}
                  onSelectCrosshair={(dx, dy) =>
                    selectCrosshairOnPlane('coronal', coronalSliceIndex, dx, dy)
                  }
                  onWheelSlice={handleWheelSlice}
                  onZoomDelta={handleZoomDelta}
                  onPanDelta={handlePanDelta}
                  onBrushRadiusDelta={handleBrushRadiusDelta}
                />
              )}

              {(maximizedPaneId === null ||
                maximizedPaneId === 'pane-sagittal-readonly') && (
                <SliceCanvasPane
                  testId="pane-sagittal-readonly"
                  title="Mặt phẳng Sagittal (Chỉ đọc)"
                  plane="sagittal"
                  sliceIndex={sagittalSliceIndex}
                  shape={activeShape}
                  affine={activeAffine}
                  mriBuffer={activeMriBuffer}
                  maskBuffer={
                    engineRef.current.isInitialized()
                      ? engineRef.current.getWorkingBuffer()
                      : null
                  }
                  showMask={true}
                  editable={false}
                  activeTool={activeTool}
                  activeLabel={activeLabel}
                  brushRadius={brushRadius}
                  maskOpacityPercent={maskOpacityPercent}
                  visibleLabels={visibleLabels}
                  windowLevel={windowLevel}
                  zoomLevel={zoomLevel}
                  panOffset={panOffset}
                  crosshairVoxel={crosshairVoxel}
                  renderRevision={renderRevision}
                  isFullscreen={isFullscreen}
                  isMaximized={maximizedPaneId === 'pane-sagittal-readonly'}
                  onToggleMaximize={() =>
                    toggleMaximizePane('pane-sagittal-readonly')
                  }
                  onResetView={resetViewportTransform}
                  onSelectCrosshair={(dx, dy) =>
                    selectCrosshairOnPlane('sagittal', sagittalSliceIndex, dx, dy)
                  }
                  onWheelSlice={handleWheelSlice}
                  onZoomDelta={handleZoomDelta}
                  onPanDelta={handlePanDelta}
                  onBrushRadiusDelta={handleBrushRadiusDelta}
                />
              )}
            </div>
          )}

          {/* Slice navigation controls (Interactive Slice Scrubber) */}
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--viewer-border)] bg-[var(--viewer-surface)] px-3 py-2 sm:px-3.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <IconButton
                variant="dark"
                size="sm"
                aria-label="Lát trước"
                disabled={currentSliceZeroBased <= 0}
                onClick={() => navigateToSlice(currentSliceZeroBased - 1)}
                icon={<ChevronLeft className="size-4" />}
              />

              <div className="flex min-w-[180px] flex-1 flex-col gap-1">
                <div className="flex items-center justify-between text-xs text-[var(--viewer-text-muted)]">
                  <label htmlFor="viewer-slice-slider">
                    Thanh trượt lát cắt (1–{totalSlices})
                  </label>
                  <span className="tabular-nums font-semibold text-[var(--viewer-text)]">
                    Lát {oneBasedSlice} / {totalSlices}
                  </span>
                </div>
                <input
                  id="viewer-slice-slider"
                  type="range"
                  min={1}
                  max={Math.max(1, totalSlices)}
                  value={oneBasedSlice}
                  onChange={(e) =>
                    navigateToSlice(
                      toZeroBasedSlice(Number(e.target.value), totalSlices),
                    )
                  }
                  className="w-full accent-sky-500"
                />
                {/* Interactive Heatmap Scrubber: click trực tiếp để nhảy lát */}
                <div
                  data-testid="slice-heatmap-scrubber"
                  aria-hidden="true"
                  title="Nhấp vào thanh chỉ báo để nhảy nhanh tới lát cắt tương ứng"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    if (rect.width > 0) {
                      const ratio = Math.min(
                        1,
                        Math.max(0, (e.clientX - rect.left) / rect.width),
                      );
                      const targetSlice = Math.round(
                        ratio * Math.max(0, totalSlices - 1),
                      );
                      navigateToSlice(targetSlice);
                    }
                  }}
                  className="relative h-3 w-full cursor-pointer overflow-hidden rounded-md border border-slate-700/80 bg-slate-900/90"
                >
                  {occupiedSlices.map((s) => (
                    <span
                      key={`occ-${s}`}
                      style={{
                        left: `${(s / Math.max(1, totalSlices - 1)) * 100}%`,
                      }}
                      className="absolute top-0 h-full w-1 -translate-x-1/2 bg-emerald-400/80"
                    />
                  ))}
                  {dirtySlices.map((s) => (
                    <span
                      key={`dirty-${s}`}
                      style={{
                        left: `${(s / Math.max(1, totalSlices - 1)) * 100}%`,
                      }}
                      className="absolute top-0 h-full w-1.5 -translate-x-1/2 bg-amber-400"
                    />
                  ))}
                  <span
                    style={{
                      left: `${(currentSliceZeroBased / Math.max(1, totalSlices - 1)) * 100}%`,
                    }}
                    className="absolute top-0 h-full w-1 -translate-x-1/2 bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.9)]"
                  />
                </div>
              </div>

              <IconButton
                variant="dark"
                size="sm"
                aria-label="Lát kế tiếp"
                disabled={currentSliceZeroBased >= totalSlices - 1}
                onClick={() => navigateToSlice(currentSliceZeroBased + 1)}
                icon={<ChevronRight className="size-4" />}
              />

              <div className="flex items-center gap-1.5">
                <label
                  htmlFor="viewer-slice-input"
                  className="text-xs text-[var(--viewer-text-muted)]"
                >
                  Số lát:
                </label>
                <input
                  id="viewer-slice-input"
                  type="number"
                  min={1}
                  max={Math.max(1, totalSlices)}
                  value={sliceInputText}
                  onChange={(e) => setSliceInputText(e.target.value)}
                  onBlur={commitSliceInput}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      commitSliceInput();
                    }
                  }}
                  className="h-8 w-16 rounded-lg border border-slate-700 bg-slate-900/90 px-2 text-center text-xs font-semibold text-slate-100 tabular-nums focus:border-sky-400 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--viewer-border)] pt-1.5 text-xs">
              <div className="inline-flex items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-950/90 p-0.5">
                <button
                  type="button"
                  disabled={prevMaskSlice === null}
                  onClick={() => {
                    if (prevMaskSlice !== null) navigateToSlice(prevMaskSlice);
                  }}
                  className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <SkipBack className="size-3.5" aria-hidden="true" />
                  Lát có mask trước
                </button>
                <span aria-hidden="true" className="h-4 w-px bg-slate-800" />
                <button
                  type="button"
                  disabled={nextMaskSlice === null}
                  onClick={() => {
                    if (nextMaskSlice !== null) navigateToSlice(nextMaskSlice);
                  }}
                  className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Lát có mask sau
                  <SkipForward className="size-3.5" aria-hidden="true" />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--viewer-text-muted)]">
                <span className="inline-flex items-center gap-1">
                  <span className="size-2 rounded-full bg-emerald-400" /> Có mask
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="size-2 rounded-full bg-amber-400" /> Chưa lưu
                </span>
                <span>Lăn chuột: ±1 lát (Shift+Lăn: ±5 lát)</span>
                <span>Trống mask ≠ kết luận âm tính</span>
              </div>
            </div>
          </div>
        </div>

        {/* Side inspector: Labels, brush, contrast & stats */}
        <aside
          aria-label="Bảng thông số nhãn và cọ vẽ"
          className={cn(
            'flex flex-col gap-3 rounded-lg border border-[var(--viewer-border)] bg-[var(--viewer-surface)] p-3',
            inspectorCollapsed && 'hidden',
          )}
        >
          <div className="flex flex-col gap-1.5">
            <h2 className="text-xs font-bold tracking-wide text-[var(--viewer-text)] uppercase">
              Nhãn phân đoạn BraTS v1
            </h2>
            <p className="text-[11px] text-[var(--viewer-text-muted)]">
              Mỗi lớp luôn kèm mã số, tên nhãn và màu hiển thị.
            </p>
            <ul className="flex flex-col gap-1.5">
              {BRATS_TUMOR_LABEL_IDS.map((labelId) => {
                const spec = BRATS_LABELS[labelId];
                const isSelected = activeLabel === labelId;
                const isVisible = visibleLabels[labelId];
                return (
                  <li
                    key={labelId}
                    className={cn(
                      'flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 transition-colors',
                      isSelected
                        ? 'border-sky-400/80 bg-sky-950/60'
                        : 'border-[var(--viewer-border)] bg-[var(--viewer-bg)]',
                    )}
                  >
                    <button
                      type="button"
                      disabled={!canEditMask}
                      onClick={() => setActiveLabel(labelId)}
                      className="flex min-h-[28px] flex-1 cursor-pointer items-center gap-2 text-left text-xs font-semibold text-[var(--viewer-text)] disabled:opacity-60"
                    >
                      <span
                        className="size-3.5 shrink-0 rounded-sm border border-white/25"
                        style={{ backgroundColor: spec.hexColor ?? undefined }}
                        aria-hidden="true"
                      />
                      <span>{spec.shortName}</span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={isVisible}
                      onClick={() => toggleLabelVisibility(labelId)}
                      className={cn(
                        'inline-flex h-7 cursor-pointer items-center rounded-md border px-2 text-[11px] font-medium transition-colors',
                        isVisible
                          ? 'border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800'
                          : 'border-slate-800 bg-slate-950 text-slate-500 hover:bg-slate-900',
                      )}
                    >
                      {isVisible ? 'Đang hiện' : 'Đang ẩn'}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="flex flex-col gap-1.5 border-t border-[var(--viewer-border)] pt-2.5">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="viewer-opacity-slider">Độ mờ lớp phủ mask</label>
              <span className="tabular-nums font-semibold">
                {maskOpacityPercent}%
              </span>
            </div>
            <input
              id="viewer-opacity-slider"
              type="range"
              min={0}
              max={100}
              value={maskOpacityPercent}
              onChange={(e) => setMaskOpacityPercent(Number(e.target.value))}
              className="w-full accent-sky-500"
            />
            <div className="grid grid-cols-4 gap-1 pt-0.5">
              {([0, 40, 70, 100] as const).map((preset) => (
                <button
                  key={`opacity-preset-${preset}`}
                  type="button"
                  onClick={() => setMaskOpacityPercent(preset)}
                  className={cn(
                    'h-6 cursor-pointer rounded-md border font-mono text-[11px] font-medium transition-colors',
                    maskOpacityPercent === preset
                      ? 'border-sky-400 bg-sky-950/80 text-sky-300'
                      : 'border-slate-700/80 bg-slate-900/90 text-slate-300 hover:bg-slate-800',
                  )}
                >
                  {preset}%
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5 border-t border-[var(--viewer-border)] pt-2.5">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="viewer-brush-slider">Bán kính cọ (pixel)</label>
              <span className="tabular-nums font-semibold">
                {brushRadius} pixel
              </span>
            </div>
            <input
              id="viewer-brush-slider"
              type="range"
              min={1}
              max={20}
              disabled={!canEditMask}
              value={brushRadius}
              onChange={(e) => setBrushRadius(Number(e.target.value))}
              className="w-full accent-sky-500 disabled:opacity-50"
            />
            <div className="grid grid-cols-4 gap-1 pt-0.5">
              {([1, 3, 6, 12] as const).map((preset) => (
                <button
                  key={`brush-preset-${preset}`}
                  type="button"
                  disabled={!canEditMask}
                  onClick={() => setBrushRadius(preset)}
                  className={cn(
                    'h-6 cursor-pointer rounded-md border font-mono text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                    brushRadius === preset
                      ? 'border-sky-400 bg-sky-950/80 text-sky-300'
                      : 'border-slate-700/80 bg-slate-900/90 text-slate-300 hover:bg-slate-800',
                  )}
                >
                  {preset}px
                </button>
              ))}
            </div>
          </div>

          {/* Window / Level & Zoom */}
          <div className="flex flex-col gap-1.5 border-t border-[var(--viewer-border)] pt-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Tương phản &amp; Thu phóng</span>
              <button
                type="button"
                onClick={resetViewportTransform}
                className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-sky-400 hover:underline"
              >
                <RotateCcw className="size-3" /> Đặt lại
              </button>
            </div>
            <label className="flex items-center justify-between gap-2">
              <span className="shrink-0">Zoom: {zoomLevel.toFixed(2)}x</span>
              <input
                aria-label="Mức thu phóng"
                type="range"
                min={0.5}
                max={4}
                step={0.1}
                value={zoomLevel}
                onChange={(e) => setZoomLevel(Number(e.target.value))}
                className="min-w-[100px] max-w-[160px] flex-1 accent-sky-500"
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="shrink-0">Center: {windowLevel.center}</span>
              <input
                aria-label="Window Center"
                type="range"
                min={50}
                max={1200}
                step={10}
                value={windowLevel.center}
                onChange={(e) =>
                  setWindowLevel({
                    ...windowLevel,
                    center: Number(e.target.value),
                  })
                }
                className="min-w-[100px] max-w-[160px] flex-1 accent-sky-500"
              />
            </label>
          </div>

          {/* Thống kê thể tích & Nguồn phiên bản */}
          <div className="flex flex-col gap-1.5 border-t border-[var(--viewer-border)] pt-2.5 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-[var(--viewer-text)]">
                Thống kê thể tích
              </h3>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                  isDirty
                    ? 'bg-amber-900/70 text-amber-200'
                    : 'bg-slate-800 text-slate-300',
                )}
              >
                {isDirty ? 'Chưa lưu (ước tính)' : 'Số liệu máy chủ'}
              </span>
            </div>

            {/* Thanh tỷ lệ thể tích 3 màu (Stacked Volume Bar) */}
            {(() => {
              const labelVolumes = BRATS_TUMOR_LABEL_IDS.map((lbl) => ({
                lbl,
                mm3: isDirty
                  ? (liveStats?.volumesMm3[lbl] ?? 0)
                  : (selectedVersion?.label_volumes_mm3?.[String(lbl)] ??
                    liveStats?.volumesMm3[lbl] ??
                    0),
              }));
              const totalVol = labelVolumes.reduce((s, item) => s + item.mm3, 0);
              return (
                <div
                  aria-hidden="true"
                  className="flex h-2 w-full overflow-hidden rounded-full bg-slate-800"
                >
                  {labelVolumes.map(({ lbl, mm3 }) => (
                    <div
                      key={`vol-bar-${lbl}`}
                      style={{
                        width: `${totalVol > 0 ? (mm3 / totalVol) * 100 : 0}%`,
                        backgroundColor: BRATS_LABELS[lbl].hexColor ?? undefined,
                      }}
                      className="h-full transition-all"
                    />
                  ))}
                </div>
              );
            })()}

            {BRATS_TUMOR_LABEL_IDS.map((lbl) => {
              const mm3 = isDirty
                ? liveStats?.volumesMm3[lbl]
                : (selectedVersion?.label_volumes_mm3?.[String(lbl)] ??
                  liveStats?.volumesMm3[lbl] ??
                  0);
              return (
                <div key={lbl} className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 text-[var(--viewer-text-muted)]">
                    <span
                      className="size-2 rounded-full"
                      style={{
                        backgroundColor: BRATS_LABELS[lbl].hexColor ?? undefined,
                      }}
                      aria-hidden="true"
                    />
                    {BRATS_LABELS[lbl].shortName}
                  </span>
                  <span className="font-mono tabular-nums">
                    {formatVolumeSummary(mm3)}
                  </span>
                </div>
              );
            })}

            <div className="mt-1 flex items-center justify-between border-t border-[var(--viewer-border)] pt-2 font-semibold">
              <span className="text-[var(--viewer-text)]">
                Tổng phân đoạn (1+2+4)
              </span>
              <span className="font-mono tabular-nums text-[var(--viewer-text)]">
                {formatVolumeSummary(
                  BRATS_TUMOR_LABEL_IDS.reduce((sum, lbl) => {
                    const v = isDirty
                      ? (liveStats?.volumesMm3[lbl] ?? 0)
                      : (selectedVersion?.label_volumes_mm3?.[String(lbl)] ??
                        liveStats?.volumesMm3[lbl] ??
                        0);
                    return sum + v;
                  }, 0),
                )}
              </span>
            </div>

            <div className="mt-1 grid grid-cols-3 gap-1.5 border-t border-[var(--viewer-border)] pt-2">
              {BRATS_COMPOSITE_GROUPS.map((grp) => {
                const serverComposite = !isDirty
                  ? selectedVersion?.composite_volumes_mm3?.[grp.key]
                  : undefined;
                const mm3 =
                  serverComposite !== undefined
                    ? serverComposite
                    : grp.includedLabels.reduce((sum, lbl) => {
                        const v = isDirty
                          ? (liveStats?.volumesMm3[lbl] ?? 0)
                          : (selectedVersion?.label_volumes_mm3?.[
                              String(lbl)
                            ] ??
                            liveStats?.volumesMm3[lbl] ??
                            0);
                        return sum + v;
                      }, 0);
                return (
                  <div
                    key={grp.key}
                    className="flex flex-col rounded border border-slate-800 bg-slate-900/80 p-1.5 text-[11px]"
                    title={grp.note}
                  >
                    <span className="font-semibold text-sky-300">
                      {grp.key}
                    </span>
                    <span className="mt-0.5 font-mono text-[10px] text-slate-200 tabular-nums">
                      {formatVolumeSummary(mm3)}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Thông tin provenance & coverage */}
            <div className="mt-1 rounded border border-[var(--viewer-border)] bg-[var(--viewer-bg)] p-2 text-[11px] text-[var(--viewer-text-muted)]">
              {selectedVersion ? (
                <>
                  <p className="font-semibold text-[var(--viewer-text)]">
                    v{selectedVersion.version_number} ·{' '}
                    {selectedVersion.source === 'ai'
                      ? `AI gốc · ${selectedVersion.model_version_id ?? 'Model AI'}`
                      : `Thủ công · ${selectedVersion.created_by_name ?? 'Bác sĩ'}`}
                  </p>
                  <p>Tạo lúc: {formatDateTimeVN(selectedVersion.created_at)}</p>
                  {selectedVersion.note && (
                    <p className="mt-0.5 text-[var(--viewer-text)]">
                      Ghi chú: {selectedVersion.note}
                    </p>
                  )}
                  {(selectedVersion.source === 'ai' ||
                    matchedMetadata?.coverage?.note) && (
                    <p className="mt-1 text-amber-300/90">
                      {matchedMetadata?.coverage?.note ??
                        'Vùng ngoài phạm vi crop của mô hình AI chưa được đánh giá tự động.'}
                    </p>
                  )}
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={handlePrintClick}
                      title="In tóm tắt hoặc lưu PDF qua trình duyệt cho phiên bản đã lưu đang chọn"
                      className={cn(
                        'inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-colors',
                        darkOutlineBtnClass,
                      )}
                    >
                      <Printer className="size-3.5" aria-hidden="true" />
                      In / Lưu PDF
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void handleExportMetadataJson();
                      }}
                      title="Tải tệp JSON metadata kỹ thuật của phiên bản đang chọn"
                      className={cn(
                        'inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-colors',
                        darkOutlineBtnClass,
                      )}
                    >
                      <Download className="size-3.5" aria-hidden="true" />
                      JSON metadata
                    </button>
                  </div>
                  {isDirty && (
                    <p className="mt-1 text-[10px] text-amber-300">
                      Đang có chỉnh sửa chưa lưu: bản in chỉ xuất số liệu đã lưu của v{selectedVersion.version_number}.
                    </p>
                  )}
                </>
              ) : (
                <p>Tạo thủ công từ đầu (chưa có phiên bản mask trên máy chủ).</p>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* Modals */}
      <SaveMaskNoteModal
        open={saveNoteModalOpen}
        isSaving={isSaving}
        onClose={() => {
          setSaveNoteModalOpen(false);
          clearPendingSaveFollowUps();
        }}
        onConfirmSave={(note) => {
          void handleConfirmSaveNote(note);
        }}
      />

      <MaskConflictModal
        open={conflictModalOpen}
        onClose={() => setConflictModalOpen(false)}
        onDownloadDraft={() => {
          void handleDownloadLocalDraft();
        }}
        onDiscardAndLoadLatest={async () => {
          pendingSelectLatestRef.current = true;
          setLatestFetchSettled(false);
          setPendingRetry(null);
          engineRef.current.discardChanges();
          syncStoreFromEngine(currentSliceZeroBased);
          setConflictModalOpen(false);
          try {
            await Promise.all([
              queryClient.refetchQueries({ queryKey: caseQueryKey, exact: true }),
              queryClient.refetchQueries({
                queryKey: maskVersionsQueryKey,
                exact: true,
              }),
            ]);
          } finally {
            loadedVersionKeyRef.current = null;
            setLatestFetchSettled(true);
          }
        }}
      />

      <DirtySwitchModal
        open={dirtySwitchModalOpen && pendingNavAction !== null}
        title="Bạn có thay đổi mask chưa lưu"
        description="Nếu rời khỏi hoặc đổi phiên bản lúc này, các nét tô/xóa chưa lưu sẽ bị mất."
        isSaving={isSaving}
        onStay={() => {
          setDirtySwitchModalOpen(false);
          setPendingNavAction(null);
        }}
        onSaveAndProceed={() => {
          setDirtySwitchModalOpen(false);
          setSaveNoteModalOpen(true);
        }}
        onDiscardAndProceed={() => {
          const action = pendingNavAction;
          setDirtySwitchModalOpen(false);
          setPendingNavAction(null);
          setPendingRetry(null);
          engineRef.current.discardChanges();
          syncStoreFromEngine(currentSliceZeroBased);
          if (action?.type === 'switch-version') {
            loadedVersionKeyRef.current = null;
            setSelectedVersionId(action.versionId);
          } else if (action?.type === 'leave-page') {
            navigate(action.to);
          }
        }}
      />

      <DirtyExportModal
        open={dirtyExportModalOpen}
        isSaving={isSaving}
        onClose={() => setDirtyExportModalOpen(false)}
        onSaveFirst={() => {
          setDirtyExportModalOpen(false);
          setExportAfterSave(true);
          setSaveNoteModalOpen(true);
        }}
        onExportDraft={() => {
          setDirtyExportModalOpen(false);
          void handleDownloadLocalDraft();
        }}
      />

      {selectedVersion && (
        <DirtyPrintModal
          open={dirtyPrintModalOpen}
          versionNumber={selectedVersion.version_number}
          isSaving={isSaving}
          onClose={() => setDirtyPrintModalOpen(false)}
          onSaveThenPrint={() => {
            setDirtyPrintModalOpen(false);
            setPrintAfterSave(true);
            setSaveNoteModalOpen(true);
          }}
          onPrintSavedVersion={() => {
            setDirtyPrintModalOpen(false);
            triggerBrowserPrint();
          }}
        />
      )}

      {savedPrintSummary && (
        <article
          data-print-report="mask-version"
          data-testid="print-summary-report"
          className="hidden rounded-lg bg-white p-8 text-black print:block"
        >
          <header className="mb-6 border-b border-slate-300 pb-4">
            <h1 className="text-2xl font-bold">
              Báo cáo tóm tắt phiên bản Mask MRI
            </h1>
            <p className="mt-1 text-sm text-slate-700">
              Dữ liệu kết quả đã lưu của phiên bản v{savedPrintSummary.versionNumber} (không bao gồm chỉnh sửa nháp chưa lưu).
            </p>
          </header>

          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-slate-600">Mã ca chụp (Case ID)</dt>
              <dd className="break-all font-mono">{savedPrintSummary.caseId}</dd>
            </div>
            {savedPrintSummary.patientCode && (
              <div>
                <dt className="text-slate-600">Mã bệnh nhân</dt>
                <dd className="font-mono">{savedPrintSummary.patientCode}</dd>
              </div>
            )}
            <div>
              <dt className="text-slate-600">Ngày chụp</dt>
              <dd>
                {savedPrintSummary.studyDate !== '—'
                  ? `${formatStudyDate(savedPrintSummary.studyDate)} (${savedPrintSummary.studyDate})`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">Phiên bản &amp; Nguồn</dt>
              <dd>
                v{savedPrintSummary.versionNumber} ·{' '}
                {savedPrintSummary.source === 'ai'
                  ? 'AI tự động (AI gốc)'
                  : 'Chỉnh sửa thủ công'}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">Mô hình AI / Tác giả</dt>
              <dd>
                {savedPrintSummary.source === 'ai'
                  ? (savedPrintSummary.modelVersion ?? savedPrintSummary.authorName)
                  : savedPrintSummary.authorName}
              </dd>
            </div>
            <div>
              <dt className="text-slate-600">Thời điểm lưu phiên bản</dt>
              <dd>{formatDateTimeVN(savedPrintSummary.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-slate-600">Thời điểm xuất bản in</dt>
              <dd>{formatDateTimeVN(printTimestampIso)}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-slate-600">Ghi chú phiên bản</dt>
              <dd>{savedPrintSummary.note ?? 'Không có ghi chú'}</dd>
            </div>
          </dl>

          <section className="mt-6">
            <h2 className="mb-2 text-lg font-semibold">
              Hình học khối ảnh &amp; Phạm vi đánh giá (Coverage)
            </h2>
            <p className="text-sm">
              Kích thước lưới: {savedPrintSummary.shape.join(' × ')} · Spacing:{' '}
              {savedPrintSummary.spacingMm.join(' × ')} mm · Hướng:{' '}
              {savedPrintSummary.orientation}
            </p>
            {savedPrintSummary.coverageNote && (
              <p className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">
                Lưu ý coverage: {savedPrintSummary.coverageNote}
              </p>
            )}
          </section>

          <section className="mt-6">
            <h2 className="mb-2 text-lg font-semibold">
              Thống kê thể tích theo lớp nhãn (không chồng lấp)
            </h2>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-400 text-left">
                  <th className="py-2">Nhãn phân đoạn</th>
                  <th>Số voxel</th>
                  <th>Thể tích (mm³)</th>
                  <th>Thể tích (mL)</th>
                </tr>
              </thead>
              <tbody>
                {savedPrintSummary.perLabel.map((stat) => (
                  <tr key={stat.label} className="border-b border-slate-200">
                    <td className="py-2">
                      {stat.shortName} — {stat.description}
                    </td>
                    <td className="font-mono tabular-nums">
                      {stat.voxelCount.toLocaleString('en-US')}
                    </td>
                    <td className="font-mono tabular-nums">
                      {stat.volumeMm3.toFixed(2)} mm³
                    </td>
                    <td className="font-mono tabular-nums">
                      {stat.volumeMl.toFixed(3)} mL
                    </td>
                  </tr>
                ))}
                <tr className="border-b-2 border-slate-400 font-semibold">
                  <td className="py-2">
                    Tổng vùng phân đoạn (nhãn 1 + 2 + 4, không chồng lấp)
                  </td>
                  <td className="font-mono tabular-nums">
                    {savedPrintSummary.totalSegmentedVoxels.toLocaleString('en-US')}
                  </td>
                  <td className="font-mono tabular-nums">
                    {savedPrintSummary.totalSegmentedMm3.toFixed(2)} mm³
                  </td>
                  <td className="font-mono tabular-nums">
                    {savedPrintSummary.totalSegmentedMl.toFixed(3)} mL
                  </td>
                </tr>
              </tbody>
            </table>

            <div className="mt-4">
              <h3 className="mb-1 text-sm font-semibold">
                Nhóm vùng tham khảo BraTS (có chồng lấp, không cộng gộp thành tổng)
              </h3>
              <ul className="grid grid-cols-3 gap-2 text-xs">
                {savedPrintSummary.compositeGroups.map((grp) => (
                  <li
                    key={grp.group}
                    className="rounded border border-slate-300 p-2"
                  >
                    <span className="block font-semibold">{grp.label}</span>
                    <span className="font-mono tabular-nums">
                      {grp.volumeMm3.toFixed(2)} mm³ ({grp.volumeMl.toFixed(3)} mL)
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <footer className="mt-6 border-t border-slate-300 pt-3 text-xs text-slate-600">
            <p>
              SHA-256 mask:{' '}
              <span className="break-all font-mono">{savedPrintSummary.sha256}</span>
            </p>
            <p className="mt-1">
              Lưu ý chuyên môn: Tài liệu chỉ trình bày thông số kỹ thuật từ phiên bản mask đã lưu, không phải kết luận chẩn đoán lâm sàng.
            </p>
          </footer>
        </article>
      )}
    </div>
  );
}

export default ViewerWorkspacePage;
