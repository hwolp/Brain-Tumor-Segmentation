import * as React from 'react';
import {
  ApiClientError,
  extractFieldErrors,
  normalizeApiError,
  normalizeErrorCode,
} from '@/shared/api/errors';
import {
  PATIENT_CODE_MAX_LENGTH,
  PATIENT_MIN_BIRTH_YEAR,
  PATIENT_NAME_MAX_LENGTH,
} from '@/shared/api/patientsCases';
import type {
  PatientCreateRequest,
  PatientDto,
  PatientSex,
} from '@/shared/api/types';
import {
  Alert,
  Button,
  FormField,
  Input,
  Modal,
  Select,
} from '@/shared/ui';

export interface PatientFormModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  initialPatient?: PatientDto | null;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (payload: PatientCreateRequest) => Promise<void>;
}

interface PatientFieldErrors {
  patient_code?: string;
  full_name?: string;
  birth_year?: string;
  sex?: string;
}

const VALID_SEX_VALUES = new Set<PatientSex>([
  'male',
  'female',
  'other',
  'unknown',
]);

export function PatientFormModal({
  open,
  mode,
  initialPatient,
  isSubmitting,
  onClose,
  onSubmit,
}: PatientFormModalProps) {
  const [patientCode, setPatientCode] = React.useState('');
  const [fullName, setFullName] = React.useState('');
  const [birthYear, setBirthYear] = React.useState('');
  const [sex, setSex] = React.useState<PatientSex>('unknown');
  const [fieldErrors, setFieldErrors] = React.useState<PatientFieldErrors>({});
  const [formError, setFormError] = React.useState<{
    message: string;
    requestId: string | null;
  } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && initialPatient) {
      setPatientCode(initialPatient.patient_code);
      setFullName(initialPatient.full_name);
      setBirthYear(String(initialPatient.birth_year));
      setSex(initialPatient.sex);
    } else {
      setPatientCode('');
      setFullName('');
      setBirthYear('');
      setSex('unknown');
    }
    setFieldErrors({});
    setFormError(null);
  }, [open, mode, initialPatient]);

  const currentYear = new Date().getFullYear();

  const validate = (): PatientCreateRequest | null => {
    const errors: PatientFieldErrors = {};
    const trimmedCode = patientCode.trim();
    const trimmedName = fullName.trim();

    if (!trimmedCode) {
      errors.patient_code = 'Vui lòng nhập mã bệnh nhân.';
    } else if (trimmedCode.length > PATIENT_CODE_MAX_LENGTH) {
      errors.patient_code = `Mã bệnh nhân không được vượt quá ${PATIENT_CODE_MAX_LENGTH} ký tự.`;
    }

    if (!trimmedName) {
      errors.full_name = 'Vui lòng nhập họ và tên bệnh nhân.';
    } else if (trimmedName.length > PATIENT_NAME_MAX_LENGTH) {
      errors.full_name = `Họ và tên không được vượt quá ${PATIENT_NAME_MAX_LENGTH} ký tự.`;
    }

    const parsedYear = Number(birthYear.trim());
    if (
      !birthYear.trim() ||
      !Number.isInteger(parsedYear) ||
      parsedYear < PATIENT_MIN_BIRTH_YEAR ||
      parsedYear > currentYear
    ) {
      errors.birth_year = `Năm sinh phải là số nguyên từ ${PATIENT_MIN_BIRTH_YEAR} đến ${currentYear}.`;
    }

    if (!VALID_SEX_VALUES.has(sex)) {
      errors.sex = 'Vui lòng chọn giới tính hợp lệ.';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return null;
    }

    return {
      patient_code: trimmedCode,
      full_name: trimmedName,
      birth_year: parsedYear,
      sex,
    };
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);

    const validPayload = validate();
    if (!validPayload) {
      return;
    }

    try {
      await onSubmit(validPayload);
    } catch (error) {
      const normalized = normalizeApiError(error);
      const code = normalizeErrorCode(normalized.code);
      const nextFieldErrors = extractFieldErrors(error);

      if (
        error instanceof ApiClientError &&
        (error.status === 409 ||
          code === 'patient_code_exists' ||
          code === 'patient_code_conflict') &&
        (code === 'patient_code_exists' ||
          code === 'patient_code_conflict' ||
          normalized.message.toLowerCase().includes('mã'))
      ) {
        nextFieldErrors.patient_code =
          nextFieldErrors.patient_code ?? normalized.message;
      }

      const hasFieldErrors = Object.keys(nextFieldErrors).length > 0;
      if (hasFieldErrors) {
        setFieldErrors(nextFieldErrors);
      }

      setFormError({
        message: hasFieldErrors
          ? 'Vui lòng kiểm tra và chỉnh sửa thông tin chưa hợp lệ bên dưới.'
          : normalized.message,
        requestId: normalized.requestId,
      });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        mode === 'create'
          ? 'Thêm hồ sơ bệnh nhân mới'
          : 'Cập nhật hồ sơ bệnh nhân'
      }
      isSubmitting={isSubmitting}
      closeOnEscape={!isSubmitting}
      closeOnBackdrop={!isSubmitting}
      footer={
        <>
          <Button variant="outline" disabled={isSubmitting} onClick={onClose}>
            Hủy
          </Button>
          <Button
            type="submit"
            form="patient-form"
            variant="primary"
            isLoading={isSubmitting}
            loadingText={
              mode === 'create' ? 'Đang tạo hồ sơ...' : 'Đang lưu...'
            }
          >
            {mode === 'create' ? 'Tạo hồ sơ' : 'Lưu thay đổi'}
          </Button>
        </>
      }
    >
      <form
        id="patient-form"
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
                ? 'Không thể tạo hồ sơ bệnh nhân'
                : 'Không thể cập nhật hồ sơ'
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

        <FormField
          id="patient-code-input"
          label="Mã bệnh nhân"
          required
          error={fieldErrors.patient_code}
        >
          {(controlProps) => (
            <Input
              {...controlProps}
              value={patientCode}
              onChange={(e) => {
                setPatientCode(e.target.value);
                if (fieldErrors.patient_code) {
                  setFieldErrors((prev) => ({
                    ...prev,
                    patient_code: undefined,
                  }));
                }
              }}
              placeholder="BN-2026-001"
              maxLength={PATIENT_CODE_MAX_LENGTH + 10}
              disabled={isSubmitting}
              hasError={Boolean(fieldErrors.patient_code)}
            />
          )}
        </FormField>

        <FormField
          id="patient-fullname-input"
          label="Họ và tên"
          required
          error={fieldErrors.full_name}
        >
          {(controlProps) => (
            <Input
              {...controlProps}
              value={fullName}
              onChange={(e) => {
                setFullName(e.target.value);
                if (fieldErrors.full_name) {
                  setFieldErrors((prev) => ({
                    ...prev,
                    full_name: undefined,
                  }));
                }
              }}
              placeholder="Nguyễn Văn A"
              disabled={isSubmitting}
              hasError={Boolean(fieldErrors.full_name)}
            />
          )}
        </FormField>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            id="patient-birthyear-input"
            label="Năm sinh"
            required
            error={fieldErrors.birth_year}
          >
            {(controlProps) => (
              <Input
                {...controlProps}
                type="number"
                inputMode="numeric"
                min={PATIENT_MIN_BIRTH_YEAR}
                max={currentYear}
                value={birthYear}
                onChange={(e) => {
                  setBirthYear(e.target.value);
                  if (fieldErrors.birth_year) {
                    setFieldErrors((prev) => ({
                      ...prev,
                      birth_year: undefined,
                    }));
                  }
                }}
                placeholder="1975"
                disabled={isSubmitting}
                hasError={Boolean(fieldErrors.birth_year)}
              />
            )}
          </FormField>

          <FormField
            id="patient-sex-select"
            label="Giới tính"
            required
            error={fieldErrors.sex}
          >
            {(controlProps) => (
              <Select
                {...controlProps}
                value={sex}
                onChange={(e) => {
                  setSex(e.target.value as PatientSex);
                  if (fieldErrors.sex) {
                    setFieldErrors((prev) => ({ ...prev, sex: undefined }));
                  }
                }}
                disabled={isSubmitting}
                hasError={Boolean(fieldErrors.sex)}
              >
                <option value="male">Nam</option>
                <option value="female">Nữ</option>
                <option value="other">Khác</option>
                <option value="unknown">Chưa rõ</option>
              </Select>
            )}
          </FormField>
        </div>
      </form>
    </Modal>
  );
}
