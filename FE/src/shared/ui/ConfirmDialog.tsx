import * as React from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'primary' | 'destructive';
  isSubmitting?: boolean;
  children?: React.ReactNode;
}

/**
 * Hộp thoại xác nhận hành động quan trọng hoặc phá hủy dữ liệu.
 * Khi `isSubmitting=true`, chặn Escape và vô hiệu hóa các nút để tránh gửi trùng.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Xác nhận',
  cancelLabel = 'Hủy',
  variant = 'primary',
  isSubmitting = false,
  children,
}: ConfirmDialogProps) {
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      role="alertdialog"
      size="sm"
      isSubmitting={isSubmitting}
      closeOnEscape={!isSubmitting}
      closeOnBackdrop={!isSubmitting}
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button
            ref={cancelRef}
            variant="outline"
            disabled={isSubmitting}
            onClick={onClose}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'primary'}
            isLoading={isSubmitting}
            loadingText="Đang xử lý..."
            onClick={() => {
              void onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
