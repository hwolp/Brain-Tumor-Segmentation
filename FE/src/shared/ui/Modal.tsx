import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { IconButton } from './IconButton';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.hasAttribute('disabled') &&
      el.getAttribute('aria-hidden') !== 'true',
  );
}

const SIZE_CLASSES: Readonly<Record<'sm' | 'md' | 'lg', string>> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  isSubmitting?: boolean;
  showCloseButton?: boolean;
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  size?: 'sm' | 'md' | 'lg';
  role?: 'dialog' | 'alertdialog';
}

/**
 * Hộp thoại chuẩn tiếp cận:
 * - Giữ focus trong dialog (focus trap với Tab / Shift+Tab)
 * - Đóng bằng Escape khi không đang commit (`isSubmitting=false`)
 * - Trả focus về phần tử trigger sau khi đóng
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  isSubmitting = false,
  showCloseButton = true,
  closeOnEscape = true,
  closeOnBackdrop = true,
  initialFocusRef,
  size = 'md',
  role = 'dialog',
}: ModalProps) {
  const titleId = React.useId();
  const descId = React.useId();
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const previousActiveElementRef = React.useRef<HTMLElement | null>(null);
  const wasOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (open && !wasOpenRef.current) {
      wasOpenRef.current = true;
      previousActiveElementRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

      const panel = dialogRef.current;
      if (panel) {
        const target = initialFocusRef?.current;
        if (target && panel.contains(target)) {
          target.focus();
        } else {
          const focusables = getFocusableElements(panel);
          if (focusables[0]) {
            focusables[0].focus();
          } else {
            panel.focus();
          }
        }
      }
    } else if (!open && wasOpenRef.current) {
      wasOpenRef.current = false;
      const prev = previousActiveElementRef.current;
      previousActiveElementRef.current = null;
      if (prev && prev.isConnected) {
        prev.focus();
      }
    }
  }, [open, initialFocusRef]);

  React.useEffect(() => {
    return () => {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        const prev = previousActiveElementRef.current;
        previousActiveElementRef.current = null;
        if (prev && prev.isConnected) {
          prev.focus();
        }
      }
    };
  }, []);

  React.useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (isSubmitting || !closeOnEscape) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'Tab' && dialogRef.current) {
        const focusables = getFocusableElements(dialogRef.current);
        if (focusables.length === 0) {
          event.preventDefault();
          dialogRef.current.focus();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const current = document.activeElement;

        if (event.shiftKey) {
          if (current === first || !dialogRef.current.contains(current)) {
            event.preventDefault();
            last.focus();
          }
        } else if (current === last || !dialogRef.current.contains(current)) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, isSubmitting, closeOnEscape, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-3 sm:p-4 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (
          event.target === event.currentTarget &&
          closeOnBackdrop &&
          !isSubmitting
        ) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          'flex max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-2.5rem)] w-full flex-col overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-2xl outline-none',
          SIZE_CLASSES[size],
        )}
      >
        <div
          className={cn(
            'flex items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6',
            children ? 'pb-3' : 'pb-5',
          )}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <h2
              id={titleId}
              className="text-lg font-semibold leading-snug text-[var(--text-primary)]"
            >
              {title}
            </h2>
            {description && (
              <p
                id={descId}
                className="text-sm text-[var(--text-secondary)]"
              >
                {description}
              </p>
            )}
          </div>
          {showCloseButton && (
            <IconButton
              aria-label="Đóng hộp thoại"
              variant="ghost"
              size="sm"
              className="-mt-1 -mr-1.5 shrink-0"
              disabled={isSubmitting}
              onClick={() => {
                if (!isSubmitting) {
                  onClose();
                }
              }}
              icon={<X className="size-4" />}
            />
          )}
        </div>

        {children && (
          <div
            className={cn(
              'min-h-0 flex-1 overflow-y-auto px-5 py-2 text-sm text-[var(--text-primary)] sm:px-6',
              footer ? 'pb-5' : 'pb-5 sm:pb-6',
            )}
          >
            {children}
          </div>
        )}

        {footer && (
          <div className="flex flex-col-reverse gap-2.5 border-t border-slate-200/80 bg-slate-50/70 px-5 py-3.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:px-6 sm:py-4 [&>*]:w-full sm:[&>*]:w-auto">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
