import * as React from 'react';
import {
  extractFieldErrors,
  isAbortError,
  normalizeApiError,
  normalizeErrorCode,
} from '@/shared/api/errors';
import {
  CASE_NOTES_MAX_LENGTH,
  generateIdempotencyKey,
} from '@/shared/api/patientsCases';
import type { CaseCreateRequest, CaseDto } from '@/shared/api/types';
import { getTodayDateVN } from '@/shared/lib/datetime';
import {
  Alert,
  Button,
  FormField,
  Input,
  Modal,
  Textarea,
} from '@/shared/ui';

export interface PendingCreateAttempt {
  key: string;
  payload: CaseCreateRequest;
  errorMessage?: string;
  requestId?: string | null;
}

export interface CaseFormModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  initialCase?: CaseDto | null;
  isSubmitting: boolean;
  pendingAttempt?: PendingCreateAttempt | null;
  onPendingAttemptChange?: (attempt: PendingCreateAttempt | null) => void;
  needsReconcileConfirm?: boolean;
  onNeedsReconcileChange?: (needs: boolean) => void;
  onClose: () => void;
  onCreateSubmit?: (
    payload: CaseCreateRequest,
    idempotencyKey: string,
  ) => Promise<void>;
  onEditSubmit?: (payload: CaseCreateRequest) => Promise<void>;
  onConflictRefreshCases?: () => Promise<void> | void;
}

export function CaseFormModal({
  open,
  mode,
  initialCase,
  isSubmitting,
  pendingAttempt: controlledPendingAttempt,
  onPendingAttemptChange,
  needsReconcileConfirm: controlledNeedsReconcile,
  onNeedsReconcileChange,
  onClose,
  onCreateSubmit,
  onEditSubmit,
  onConflictRefreshCases,
}: CaseFormModalProps) {
  const [studyDate, setStudyDate] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [fieldErrors, setFieldErrors] = React.useState<{
    study_date?: string;
    notes?: string;
  }>({});
  const [formError, setFormError] = React.useState<{
    message: string;
    requestId: string | null;
    canRetrySameKey: boolean;
  } | null>(null);
  const [internalPendingAttempt, setInternalPendingAttempt] =
    React.useState<PendingCreateAttempt | null>(null);
  const [internalNeedsReconcile, setInternalNeedsReconcile] =
    React.useState(false);
  const [isReconciling, setIsReconciling] = React.useState(false);
  const [reconcileChecked, setReconcileChecked] = React.useState(false);

  const pendingAttempt =
    controlledPendingAttempt !== undefined
      ? controlledPendingAttempt
      : internalPendingAttempt;

  const needsReconcile =
    controlledNeedsReconcile !== undefined
      ? controlledNeedsReconcile
      : internalNeedsReconcile;

  const updatePendingAttempt = (next: PendingCreateAttempt | null) => {
    setInternalPendingAttempt(next);
    onPendingAttemptChange?.(next);
  };

  const updateNeedsReconcile = (next: boolean) => {
    setInternalNeedsReconcile(next);
    onNeedsReconcileChange?.(next);
  };

  const triggerReconcileRefresh = React.useCallback(async () => {
    if (!onConflictRefreshCases) return;
    setIsReconciling(true);
    try {
      await onConflictRefreshCases();
    } finally {
      setIsReconciling(false);
    }
  }, [onConflictRefreshCases]);

  const wasOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) {
      return;
    }
    wasOpenRef.current = true;

    if (mode === 'edit' && initialCase) {
      setStudyDate(initialCase.study_date);
      setNotes(initialCase.notes ?? '');
      setFormError(null);
      setReconcileChecked(false);
    } else if (mode === 'create' && controlledPendingAttempt) {
      setStudyDate(controlledPendingAttempt.payload.study_date);
      setNotes(controlledPendingAttempt.payload.notes ?? '');
      setFormError(
        controlledPendingAttempt.errorMessage
          ? {
              message: controlledPendingAttempt.errorMessage,
              requestId: controlledPendingAttempt.requestId ?? null,
              canRetrySameKey: true,
            }
          : null,
      );
      setReconcileChecked(false);
    } else {
      setStudyDate(getTodayDateVN());
      setNotes('');
      setFormError(null);
      setReconcileChecked(false);
      if (controlledPendingAttempt === undefined) {
        setInternalPendingAttempt(null);
      }
      if (controlledNeedsReconcile) {
        void triggerReconcileRefresh();
      }
    }
    setFieldErrors({});
  }, [
    open,
    mode,
    initialCase,
    controlledPendingAttempt,
    controlledNeedsReconcile,
    triggerReconcileRefresh,
  ]);

  const validate = (): CaseCreateRequest | null => {
    const errors: { study_date?: string; notes?: string } = {};
    const trimmedDate = studyDate.trim();
    const todayVn = getTodayDateVN();

    if (!trimmedDate) {
      errors.study_date = 'Vui lòng chọn ngày chụp.';
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
      errors.study_date = 'Ngày chụp không đúng định dạng YYYY-MM-DD.';
    } else if (trimmedDate > todayVn) {
      errors.study_date = `Ngày chụp không được ở tương lai (tối đa ${todayVn}).`;
    }

    if (notes.length > CASE_NOTES_MAX_LENGTH) {
      errors.notes = `Ghi chú không được vượt quá ${CASE_NOTES_MAX_LENGTH} ký tự.`;
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return null;
    }

    return {
      study_date: trimmedDate,
      notes: notes.trim() ? notes.trim() : null,
    };
  };

  const executeCreateAttempt = async (attempt: PendingCreateAttempt) => {
    if (!onCreateSubmit) return;
    setFormError(null);
    try {
      await onCreateSubmit(attempt.payload, attempt.key);
      updatePendingAttempt(null);
      updateNeedsReconcile(false);
      setReconcileChecked(false);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      const normalized = normalizeApiError(error);
      const code = normalizeErrorCode(normalized.code);
      const nextFields = extractFieldErrors(error);
      if (Object.keys(nextFields).length > 0) {
        setFieldErrors(nextFields);
      }

      if (code === 'idempotency_conflict' || code === 'case_deleted') {
        updatePendingAttempt(null);
        updateNeedsReconcile(false);
        setReconcileChecked(false);
        setFormError({
          message: normalized.message,
          requestId: normalized.requestId,
          canRetrySameKey: false,
        });
        await onConflictRefreshCases?.();
        return;
      }

      const isRetryableFailure =
        normalized.status === 0 || normalized.status >= 500;
      if (isRetryableFailure) {
        updatePendingAttempt({
          ...attempt,
          errorMessage: normalized.message,
          requestId: normalized.requestId,
        });
      } else {
        updatePendingAttempt(null);
      }

      setFormError({
        message: normalized.message,
        requestId: normalized.requestId,
        canRetrySameKey: isRetryableFailure,
      });
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);

    if (mode === 'create') {
      if (pendingAttempt) {
        await executeCreateAttempt(pendingAttempt);
        return;
      }
      if (needsReconcile && (isReconciling || !reconcileChecked)) {
        return;
      }
      const validPayload = validate();
      if (!validPayload) return;
      const attempt: PendingCreateAttempt = {
        key: generateIdempotencyKey(),
        payload: validPayload,
      };
      updatePendingAttempt(attempt);
      await executeCreateAttempt(attempt);
      return;
    }

    const validPayload = validate();
    if (!validPayload || !onEditSubmit) return;
    try {
      await onEditSubmit(validPayload);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      const normalized = normalizeApiError(error);
      const nextFields = extractFieldErrors(error);
      if (Object.keys(nextFields).length > 0) {
        setFieldErrors(nextFields);
      }
      setFormError({
        message: normalized.message,
        requestId: normalized.requestId,
        canRetrySameKey: false,
      });
    }
  };

  const handleFieldEdit = () => {
    if (pendingAttempt) {
      updatePendingAttempt(null);
      updateNeedsReconcile(true);
      setReconcileChecked(false);
      setFormError(null);
      void triggerReconcileRefresh();
    }
  };

  const isCreateSubmitDisabled =
    mode === 'create' &&
    !pendingAttempt &&
    needsReconcile &&
    (isReconciling || !reconcileChecked);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'create' ? 'Tạo ca chụp MRI mới' : 'Cập nhật thông tin ca chụp'}
      isSubmitting={isSubmitting}
      closeOnEscape={!isSubmitting}
      closeOnBackdrop={!isSubmitting}
      footer={
        <>
          <Button variant="outline" disabled={isSubmitting} onClick={onClose}>
            Hủy
          </Button>
          {formError?.canRetrySameKey && pendingAttempt ? (
            <Button
              type="button"
              variant="primary"
              isLoading={isSubmitting}
              loadingText="Đang thử lại..."
              onClick={() => {
                void executeCreateAttempt(pendingAttempt);
              }}
            >
              Thử lại với cùng khóa
            </Button>
          ) : (
            <Button
              type="submit"
              form="case-form"
              variant="primary"
              disabled={isCreateSubmitDisabled}
              isLoading={isSubmitting}
              loadingText={mode === 'create' ? 'Đang tạo ca...' : 'Đang lưu...'}
            >
              {mode === 'create' ? 'Tạo ca chụp' : 'Lưu thay đổi'}
            </Button>
          )}
        </>
      }
    >
      <form
        id="case-form"
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        className="flex flex-col gap-4"
        noValidate
      >
        {formError && (
          <Alert
            variant="error"
            title={
              mode === 'create'
                ? 'Không thể tạo ca chụp'
                : 'Không thể cập nhật ca chụp'
            }
            description={formError.message}
          >
            {formError.requestId && (
              <span className="sr-only">
                Mã tham chiếu: {formError.requestId}
              </span>
            )}
          </Alert>
        )}

        {mode === 'create' && needsReconcile && !pendingAttempt && (
          <Alert
            variant="warning"
            title="Cần đối soát danh sách ca trước khi tạo khóa mới"
            description={
              isReconciling
                ? 'Đang đồng bộ lại danh sách ca chụp của bệnh nhân...'
                : 'Kết quả lần gửi trước chưa chắc chắn. Hệ thống đã đồng bộ lại danh sách ca; vui lòng kiểm tra và xác nhận trước khi phát sinh khóa thao tác mới.'
            }
            action={
              onConflictRefreshCases ? (
                <div className="flex flex-col items-start gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isReconciling}
                    onClick={() => {
                      void triggerReconcileRefresh();
                    }}
                  >
                    {isReconciling ? 'Đang đồng bộ...' : 'Làm mới danh sách ca'}
                  </Button>
                  <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-[var(--text-primary)]">
                    <input
                      type="checkbox"
                      checked={reconcileChecked}
                      disabled={isReconciling || isSubmitting}
                      onChange={(e) => setReconcileChecked(e.target.checked)}
                      className="size-4 accent-[var(--action-primary)]"
                    />
                    Tôi đã kiểm tra danh sách ca chụp và xác nhận muốn tạo ca mới
                  </label>
                </div>
              ) : undefined
            }
          />
        )}

        <FormField
          id="case-study-date-input"
          label="Ngày chụp"
          required
          error={fieldErrors.study_date}
        >
          {(controlProps) => (
            <Input
              {...controlProps}
              type="date"
              max={getTodayDateVN()}
              value={studyDate}
              onChange={(e) => {
                setStudyDate(e.target.value);
                if (fieldErrors.study_date) {
                  setFieldErrors((prev) => ({
                    ...prev,
                    study_date: undefined,
                  }));
                }
                handleFieldEdit();
              }}
              disabled={isSubmitting}
              hasError={Boolean(fieldErrors.study_date)}
            />
          )}
        </FormField>

        <FormField
          id="case-notes-input"
          label="Ghi chú lâm sàng"
          error={fieldErrors.notes}
        >
          {(controlProps) => (
            <Textarea
              {...controlProps}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                if (fieldErrors.notes) {
                  setFieldErrors((prev) => ({ ...prev, notes: undefined }));
                }
                handleFieldEdit();
              }}
              placeholder="Nhập ghi chú lâm sàng (tùy chọn)..."
              disabled={isSubmitting}
              hasError={Boolean(fieldErrors.notes)}
            />
          )}
        </FormField>
      </form>
    </Modal>
  );
}
