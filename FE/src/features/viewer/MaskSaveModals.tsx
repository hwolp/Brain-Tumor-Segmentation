import * as React from 'react';
import { Alert, Button, Modal, Textarea } from '@/shared/ui';

export interface SaveMaskNoteModalProps {
  open: boolean;
  isSaving: boolean;
  onClose: () => void;
  onConfirmSave: (note: string) => void;
}

export function SaveMaskNoteModal({
  open,
  isSaving,
  onClose,
  onConfirmSave,
}: SaveMaskNoteModalProps) {
  const [note, setNote] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setNote('');
    }
  }, [open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;
    onConfirmSave(note.slice(0, 2000));
  };

  return (
    <Modal
      open={open}
      onClose={isSaving ? () => {} : onClose}
      isSubmitting={isSaving}
      title="Lưu phiên bản mask mới"
      description="Phiên bản mask thủ công sẽ được tạo mới độc lập và liên kết lịch sử với phiên bản gốc hiện tại."
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={isSaving}
            onClick={onClose}
          >
            Hủy
          </Button>
          <Button
            type="submit"
            form="mask-save-note-form"
            variant="primary"
            disabled={isSaving}
          >
            {isSaving ? 'Đang lưu...' : 'Xác nhận lưu phiên bản'}
          </Button>
        </>
      }
    >
      <form
        id="mask-save-note-form"
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label
              htmlFor="mask-save-note-input"
              className="text-sm font-medium text-[var(--text-primary)]"
            >
              Ghi chú phiên bản
            </label>
            <span className="font-mono text-xs text-[var(--text-secondary)] tabular-nums">
              {note.length} / 2000
            </span>
          </div>
          <Textarea
            id="mask-save-note-input"
            rows={3}
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Nhập ghi chú chuyên môn về các vùng ranh giới đã hiệu chỉnh (tùy chọn)..."
          />
        </div>
      </form>
    </Modal>
  );
}

export interface MaskConflictModalProps {
  open: boolean;
  onDownloadDraft: () => void;
  onDiscardAndLoadLatest: () => void;
  onClose: () => void;
}

export function MaskConflictModal({
  open,
  onDownloadDraft,
  onDiscardAndLoadLatest,
  onClose,
}: MaskConflictModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Xung đột phiên bản mask (409)"
      description="Đã có phiên bản mask mới hơn được lưu trên máy chủ sau khi bạn mở bản hiện tại. Hệ thống không tự động ghi đè hoặc gộp."
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Ở lại trình chỉnh sửa
          </Button>
          <Button type="button" variant="secondary" onClick={onDownloadDraft}>
            Tải bản nháp về máy (.nii.gz)
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onDiscardAndLoadLatest}
          >
            Bỏ bản nháp &amp; mở phiên bản mới nhất
          </Button>
        </>
      }
    >
      <Alert
        variant="warning"
        title="Bản nháp của bạn vẫn đang được giữ an toàn trong bộ nhớ"
        description="Bạn có thể tải bản nháp hiện tại về máy (.nii.gz) để đối chiếu, hoặc bỏ bản nháp để mở phiên bản mới nhất từ máy chủ."
      />
    </Modal>
  );
}

export interface DirtySwitchModalProps {
  open: boolean;
  title: string;
  description: string;
  isSaving: boolean;
  onStay: () => void;
  onSaveAndProceed: () => void;
  onDiscardAndProceed: () => void;
}

export function DirtySwitchModal({
  open,
  title,
  description,
  isSaving,
  onStay,
  onSaveAndProceed,
  onDiscardAndProceed,
}: DirtySwitchModalProps) {
  return (
    <Modal
      open={open}
      onClose={isSaving ? () => {} : onStay}
      isSubmitting={isSaving}
      title={title}
      description={description}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={isSaving}
            onClick={onStay}
          >
            Ở lại
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={isSaving}
            onClick={onDiscardAndProceed}
          >
            Bỏ thay đổi
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={isSaving}
            onClick={onSaveAndProceed}
          >
            {isSaving ? 'Đang lưu...' : 'Lưu rồi chuyển'}
          </Button>
        </>
      }
    />
  );
}

export interface DirtyExportModalProps {
  open: boolean;
  isSaving: boolean;
  onClose: () => void;
  onSaveFirst: () => void;
  onExportDraft: () => void;
}

export function DirtyExportModal({
  open,
  isSaving,
  onClose,
  onSaveFirst,
  onExportDraft,
}: DirtyExportModalProps) {
  return (
    <Modal
      open={open}
      onClose={isSaving ? () => {} : onClose}
      isSubmitting={isSaving}
      title="Có thay đổi mask chưa lưu"
      description="Bạn đang có chỉnh sửa chưa lưu. Bạn muốn lưu thành phiên bản chính thức trước khi xuất, hay xuất bản nháp cục bộ?"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={isSaving}
            onClick={onClose}
          >
            Hủy
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={isSaving}
            onClick={onExportDraft}
          >
            Xuất bản nháp cục bộ (.nii.gz)
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={isSaving}
            onClick={onSaveFirst}
          >
            {isSaving ? 'Đang lưu...' : 'Lưu phiên bản rồi xuất'}
          </Button>
        </>
      }
    />
  );
}

export interface DirtyPrintModalProps {
  open: boolean;
  versionNumber: number;
  isSaving: boolean;
  onClose: () => void;
  onSaveThenPrint: () => void;
  onPrintSavedVersion: () => void;
}

export function DirtyPrintModal({
  open,
  versionNumber,
  isSaving,
  onClose,
  onSaveThenPrint,
  onPrintSavedVersion,
}: DirtyPrintModalProps) {
  return (
    <Modal
      open={open}
      onClose={isSaving ? () => {} : onClose}
      isSubmitting={isSaving}
      title="Có thay đổi mask chưa lưu"
      description={`Trang in / lưu PDF chỉ trình bày số liệu của phiên bản đã lưu (v${versionNumber}) và không trộn các chỉnh sửa chưa lưu. Bạn muốn lưu phiên bản mới trước khi in hay in đúng phiên bản đã lưu v${versionNumber}?`}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={isSaving}
            onClick={onClose}
          >
            Hủy
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={isSaving}
            onClick={onPrintSavedVersion}
          >
            In bản đã lưu (v{versionNumber})
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={isSaving}
            onClick={onSaveThenPrint}
          >
            {isSaving ? 'Đang lưu...' : 'Lưu phiên bản rồi in'}
          </Button>
        </>
      }
    />
  );
}
