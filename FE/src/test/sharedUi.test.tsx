import * as React from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Bell } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/shared/api/errors';
import { clearSessionCache } from '@/shared/api/queryClient';
import {
  ConfirmDialog,
  DataTable,
  ErrorState,
  IconButton,
  Modal,
  Pagination,
  StatusBadge,
  ToastProvider,
  useToast,
} from '@/shared/ui';

function ModalHarness({ isSubmitting = false }: { isSubmitting?: boolean }) {
  const [open, setOpen] = React.useState(false);

  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Mở hộp thoại
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Xác nhận thông tin ca"
        description="Kiểm tra kỹ trước khi lưu."
        isSubmitting={isSubmitting}
        footer={
          <>
            <button type="button" onClick={() => setOpen(false)}>
              Đóng lại
            </button>
            <button type="button">Tiếp tục</button>
          </>
        }
      >
        <input aria-label="Ghi chú ngắn" />
      </Modal>
    </div>
  );
}

describe('Shared UI primitives accessibility & interaction', () => {
  it('Modal moves focus inside, traps Tab navigation, closes on Escape and returns focus to trigger', async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);

    const trigger = screen.getByRole('button', { name: 'Mở hộp thoại' });
    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Xác nhận thông tin ca' });
    expect(dialog).toBeInTheDocument();

    const closeIcon = screen.getByRole('button', { name: 'Đóng hộp thoại' });
    const noteInput = screen.getByLabelText('Ghi chú ngắn');
    const closeFooterBtn = screen.getByRole('button', { name: 'Đóng lại' });
    const continueBtn = screen.getByRole('button', { name: 'Tiếp tục' });

    expect(closeIcon).toHaveFocus();

    // Tab cycles inside dialog without escaping to trigger
    await user.tab();
    expect(noteInput).toHaveFocus();
    await user.tab();
    expect(closeFooterBtn).toHaveFocus();
    await user.tab();
    expect(continueBtn).toHaveFocus();
    await user.tab();
    expect(closeIcon).toHaveFocus();

    // Shift+Tab wraps backward to last focusable element inside modal
    await user.tab({ shift: true });
    expect(continueBtn).toHaveFocus();

    // Escape closes and returns focus back to trigger button
    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('dialog', { name: 'Xác nhận thông tin ca' }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('ConfirmDialog blocks Escape and disables buttons when isSubmitting=true', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onConfirm = vi.fn();

    render(
      <ConfirmDialog
        open
        onClose={onClose}
        onConfirm={onConfirm}
        title="Xóa ca chụp"
        description="Thao tác này không thể hoàn tác."
        confirmLabel="Xóa ca"
        isSubmitting
      />,
    );

    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    expect(screen.getByRole('button', { name: 'Hủy' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Đóng hộp thoại' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Đang xử lý...' })).toBeDisabled();
  });

  it('IconButton exposes aria-label + tooltip and StatusBadge always renders text', () => {
    render(
      <div>
        <IconButton
          aria-label="Xem thông báo"
          tooltip="Thông báo hệ thống"
          icon={<Bell className="size-4" />}
        />
        <StatusBadge label="Sẵn sàng chạy AI" tone="success" />
      </div>,
    );

    const iconBtn = screen.getByRole('button', { name: 'Xem thông báo' });
    expect(iconBtn).toHaveAttribute('title', 'Thông báo hệ thống');
    expect(screen.getByText('Sẵn sàng chạy AI')).toBeInTheDocument();
  });

  it('DataTable renders loading, empty, error with request_id, and paginated rows', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const columns = [
      { key: 'code', header: 'Mã', cell: (r: { id: string; code: string }) => r.code },
    ];

    const { rerender } = render(
      <DataTable
        columns={columns}
        data={[]}
        rowKey={(r) => r.id}
        isLoading
      />,
    );
    expect(screen.getByRole('status', { name: 'Đang tải danh sách' })).toHaveAttribute(
      'aria-busy',
      'true',
    );

    rerender(
      <DataTable
        columns={columns}
        data={[]}
        rowKey={(r) => r.id}
        emptyTitle="Không có bệnh nhân"
        emptyDescription="Danh sách trống."
      />,
    );
    expect(screen.getByText('Không có bệnh nhân')).toBeInTheDocument();

    rerender(
      <DataTable
        columns={columns}
        data={[]}
        rowKey={(r) => r.id}
        error={
          new ApiClientError({
            status: 500,
            code: 'internal_error',
            userMessage: 'Lỗi máy chủ khi tải bảng dữ liệu',
            requestId: 'req-table-500',
          })
        }
        onRetry={onRetry}
      />,
    );
    const tableAlert = screen.getByRole('alert');
    expect(tableAlert).toHaveTextContent('Lỗi máy chủ khi tải bảng dữ liệu');
    expect(tableAlert).toHaveTextContent('req-table-500');
    await user.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    const onPageChange = vi.fn();
    rerender(
      <div>
        <DataTable
          columns={columns}
          data={[{ id: '1', code: 'BN-001' }]}
          rowKey={(r) => r.id}
        />
        <Pagination page={1} total={45} onPageChange={onPageChange} />
      </div>,
    );
    expect(screen.getByText('BN-001')).toBeInTheDocument();
    expect(screen.getByText('Trang 1 / 3')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Trang sau' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('ErrorState displays Vietnamese text and Request ID cleanly', () => {
    render(
      <ErrorState
        message="Không thể tải thông tin ca."
        requestId="req-ui-789"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Không thể tải thông tin ca.');
    expect(screen.getByText('req-ui-789')).toBeInTheDocument();
  });

  it('Pagination keeps "Trang trước" enabled when page > totalPages and clamps step-back to totalPages', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();

    const { rerender } = render(
      <Pagination page={2} pageSize={20} total={20} onPageChange={onPageChange} />,
    );
    const prevBtn = screen.getByRole('button', { name: 'Trang trước' });
    expect(prevBtn).toBeEnabled();
    await user.click(prevBtn);
    expect(onPageChange).toHaveBeenCalledWith(1);

    onPageChange.mockClear();
    rerender(
      <Pagination page={5} pageSize={20} total={40} onPageChange={onPageChange} />,
    );
    await user.click(screen.getByRole('button', { name: 'Trang trước' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('ToastProvider clears active PII toasts immediately on clearSessionCache (logout / account switch)', async () => {
    const user = userEvent.setup();
    function ToastTriggerHarness() {
      const { pushToast } = useToast();
      return (
        <button
          type="button"
          onClick={() =>
            pushToast({
              variant: 'success',
              title: 'Đã tạo hồ sơ bệnh nhân',
              description: 'Nguyễn Văn Mật (BN-PII-999)',
              durationMs: 60_000,
            })
          }
        >
          Hiện toast PII
        </button>
      );
    }

    render(
      <ToastProvider>
        <ToastTriggerHarness />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Hiện toast PII' }));
    expect(screen.getByText('Nguyễn Văn Mật (BN-PII-999)')).toBeInTheDocument();

    await act(async () => {
      await clearSessionCache();
    });

    expect(
      screen.queryByText('Nguyễn Văn Mật (BN-PII-999)'),
    ).not.toBeInTheDocument();
  });
});
