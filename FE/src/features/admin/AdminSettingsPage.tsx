import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/app/auth-store';
import {
  fetchAdminSettings,
  updateAdminSettings,
} from '@/shared/api/endpoints';
import { normalizeApiError, normalizeErrorCode } from '@/shared/api/errors';
import { useQueryErrorToast } from '@/shared/api/useQueryErrorToast';
import type { AdminModelDto, AdminSettingsDto } from '@/shared/api/types';
import { formatDateTimeVN } from '@/shared/lib/datetime';
import {
  Alert,
  Button,
  CardSkeleton,
  ErrorState,
  Input,
  StatusBadge,
  useToast,
} from '@/shared/ui';

type NumericSettingKey =
  | 'max_upload_mib'
  | 'max_decompressed_mib'
  | 'default_doctor_quota_gib'
  | 'system_quota_gib';

const NUMERIC_SETTING_KEYS: readonly NumericSettingKey[] = [
  'max_upload_mib',
  'max_decompressed_mib',
  'default_doctor_quota_gib',
  'system_quota_gib',
];

function toNumericInputMap(
  settings: AdminSettingsDto,
): Record<NumericSettingKey, string> {
  return {
    max_upload_mib: String(settings.max_upload_mib),
    max_decompressed_mib: String(settings.max_decompressed_mib),
    default_doctor_quota_gib: String(settings.default_doctor_quota_gib),
    system_quota_gib: String(settings.system_quota_gib),
  };
}

function sameSettings(a: AdminSettingsDto, b: AdminSettingsDto): boolean {
  return (
    a.version === b.version &&
    a.accepting_jobs === b.accepting_jobs &&
    a.max_upload_mib === b.max_upload_mib &&
    a.max_decompressed_mib === b.max_decompressed_mib &&
    a.default_doctor_quota_gib === b.default_doctor_quota_gib &&
    a.system_quota_gib === b.system_quota_gib
  );
}

export function AdminSettingsPage() {
  const user = useAuthStore((s) => s.user);
  const fixtureMode = useAuthStore((s) => s.fixtureMode);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [draft, setDraft] = React.useState<AdminSettingsDto | null>(null);
  const [numericInputs, setNumericInputs] = React.useState<
    Record<NumericSettingKey, string>
  >({
    max_upload_mib: '',
    max_decompressed_mib: '',
    default_doctor_quota_gib: '',
    system_quota_gib: '',
  });
  const [saveError, setSaveError] = React.useState<{
    message: string;
    requestId: string | null;
  } | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['admin', user?.id ?? 'anon', 'settings', { fixtureMode }],
    queryFn: ({ signal }) => fetchAdminSettings({ signal, fixtureMode }),
  });

  React.useEffect(() => {
    if (settingsQuery.data) {
      setDraft(settingsQuery.data.settings);
      setNumericInputs(toNumericInputMap(settingsQuery.data.settings));
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (values: AdminSettingsDto) =>
      updateAdminSettings(values, { fixtureMode }),
    onSuccess: async (savedSettings) => {
      setDraft(savedSettings);
      setNumericInputs(toNumericInputMap(savedSettings));
      setSaveError(null);
      queryClient.setQueryData<{
        settings: AdminSettingsDto;
        models: AdminModelDto[];
      }>(
        ['admin', user?.id ?? 'anon', 'settings', { fixtureMode }],
        (old) => (old ? { ...old, settings: savedSettings } : undefined),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', user?.id ?? 'anon', 'settings'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', user?.id ?? 'anon', 'overview'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', user?.id ?? 'anon', 'audit-events'] }),
      ]);
      pushToast({
        variant: 'success',
        title: 'Đã lưu cấu hình vận hành',
        description: `Phiên bản cấu hình ${savedSettings.version} đã được áp dụng cho yêu cầu mới.`,
      });
    },
    onError: (error) => {
      const normalized = normalizeApiError(error);
      const code = normalizeErrorCode(normalized.code);
      setSaveError({
        message: normalized.message,
        requestId: normalized.requestId,
      });
      if (code === 'settings_version_conflict') {
        pushToast({
          variant: 'warning',
          title: 'Xung đột phiên bản cấu hình',
          description:
            'Cấu hình vừa được cập nhật ở phiên khác. Hệ thống đang tải lại phiên bản mới nhất.',
          requestId: normalized.requestId,
        });
        void settingsQuery.refetch();
      }
    },
  });

  useQueryErrorToast(settingsQuery.error, 'Không thể tải cấu hình hệ thống');

  const saved = settingsQuery.data?.settings;
  const models = settingsQuery.data?.models ?? [];
  const hasIncompleteNumericInput = NUMERIC_SETTING_KEYS.some((key) => {
    const raw = numericInputs[key].trim();
    return raw === '' || !Number.isFinite(Number(raw));
  });
  const isDirty = Boolean(
    draft &&
      saved &&
      (!sameSettings(draft, saved) ||
        NUMERIC_SETTING_KEYS.some(
          (key) => numericInputs[key].trim() !== String(saved[key]),
        )),
  );
  const updateNumber = (key: NumericSettingKey, value: string) => {
    setSaveError(null);
    setNumericInputs((prev) => ({ ...prev, [key]: value }));
    if (!draft || value.trim() === '') return;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      setDraft({ ...draft, [key]: parsed });
    }
  };

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <h1 className="text-2xl font-bold text-[var(--text-primary)]">
        Cấu hình vận hành &amp; Mô hình
      </h1>

      {settingsQuery.isPending && <CardSkeleton />}

      {settingsQuery.isError && !saved && (
        <ErrorState
          title="Không thể tải cấu hình hệ thống"
          error={settingsQuery.error}
          onRetry={() => void settingsQuery.refetch()}
        />
      )}

      {draft && saved && (
        <>
          {saveError && (
            <Alert
              variant="error"
              title="Không thể lưu cấu hình"
              description={saveError.message}
            >
              {saveError.requestId && (
                <span className="sr-only">
                  Mã yêu cầu: {saveError.requestId}
                </span>
              )}
            </Alert>
          )}

          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft && !hasIncompleteNumericInput) {
                saveMutation.mutate(draft);
              }
            }}
          >
            <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
              <h2 className="mb-4 text-base font-semibold text-[var(--text-primary)]">
                Nhận tác vụ và giới hạn dữ liệu
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label
                  className={
                    draft.accepting_jobs
                      ? 'flex min-h-14 cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--status-success-border)] bg-[var(--status-success-bg)]/50 px-4 py-3 transition-colors sm:col-span-2'
                      : 'flex min-h-14 cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-bg)]/50 px-4 py-3 transition-colors sm:col-span-2'
                  }
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      Nhận job AI mới
                    </span>
                    <span className="text-xs text-[var(--text-secondary)]">
                      {draft.accepting_jobs
                        ? 'Hệ thống đang mở tiếp nhận tác vụ phân đoạn mới từ bác sĩ.'
                        : 'Hệ thống đang tạm dừng nhận tác vụ phân đoạn mới.'}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={draft.accepting_jobs}
                    onChange={(event) => {
                      setSaveError(null);
                      setDraft({ ...draft, accepting_jobs: event.target.checked });
                    }}
                    className="size-5 shrink-0 cursor-pointer accent-[var(--action-primary)]"
                    aria-label="Nhận job AI mới"
                  />
                </label>

                <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="admin-max-upload">
                  Dung lượng tối đa mỗi tệp (MiB)
                  <Input
                    id="admin-max-upload"
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    required
                    value={numericInputs.max_upload_mib}
                    onChange={(event) => updateNumber('max_upload_mib', event.target.value)}
                  />
                </label>

                <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="admin-max-decompressed">
                  Dung lượng NIfTI sau giải nén (MiB)
                  <Input
                    id="admin-max-decompressed"
                    type="number"
                    min={1}
                    max={256}
                    step={1}
                    required
                    value={numericInputs.max_decompressed_mib}
                    onChange={(event) => updateNumber('max_decompressed_mib', event.target.value)}
                  />
                </label>
              </div>
            </section>

            <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
              <h2 className="mb-4 text-base font-semibold text-[var(--text-primary)]">
                Quota lưu trữ
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="admin-doctor-quota">
                  Mặc định mỗi bác sĩ (GiB)
                  <Input
                    id="admin-doctor-quota"
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    required
                    value={numericInputs.default_doctor_quota_gib}
                    onChange={(event) => updateNumber('default_doctor_quota_gib', event.target.value)}
                  />
                </label>

                <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="admin-system-quota">
                  Toàn hệ thống (GiB)
                  <Input
                    id="admin-system-quota"
                    type="number"
                    min={1}
                    max={1000}
                    step={1}
                    required
                    value={numericInputs.system_quota_gib}
                    onChange={(event) => updateNumber('system_quota_gib', event.target.value)}
                  />
                </label>
              </div>
            </section>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-[var(--text-secondary)]">
                Phiên bản {saved.version} · Cập nhật lúc {formatDateTimeVN(saved.updated_at)}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {isDirty && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={saveMutation.isPending}
                    onClick={() => {
                      setSaveError(null);
                      setDraft(saved);
                      setNumericInputs(toNumericInputMap(saved));
                    }}
                  >
                    Đặt lại
                  </Button>
                )}
                <Button
                  type="submit"
                  disabled={!isDirty || hasIncompleteNumericInput || saveMutation.isPending}
                  isLoading={saveMutation.isPending}
                  loadingText="Đang lưu..."
                >
                  Lưu cấu hình
                </Button>
              </div>
            </div>
          </form>

          <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-[var(--text-primary)]">
                Mô hình AI
              </h2>
              {models.some((model) => model.is_active) && (
                <StatusBadge label="Đã xác minh" tone="success" />
              )}
            </div>
            {models.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">
                Chưa có manifest model hợp lệ được đăng ký.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {models.map((model) => (
                  <li key={model.id} className="rounded-lg border border-[var(--border-default)] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{model.name} · {model.version}</p>
                      <StatusBadge
                        label={model.is_active ? 'Đang kích hoạt' : 'Chưa kích hoạt'}
                        tone={model.is_active ? 'success' : 'neutral'}
                      />
                    </div>
                    <p className="mt-1 font-mono text-xs text-[var(--text-secondary)]">
                      Input {model.expected_shape.join('×')} · {model.expected_spacing_mm.join('×')} mm
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-[var(--text-secondary)]">
                      Checkpoint SHA-256: {model.checkpoint_sha256}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
