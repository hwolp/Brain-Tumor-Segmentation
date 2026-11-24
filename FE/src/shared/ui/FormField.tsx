import * as React from 'react';
import { cn } from '@/shared/lib/cn';

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  hasError?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, hasError = false, ...props }, ref) => {
    return (
      <input
        ref={ref}
        aria-invalid={hasError || undefined}
        className={cn(
          'box-border flex h-10 min-h-[40px] w-full min-w-0 max-w-full rounded-lg border bg-[var(--bg-surface)] px-3.5 py-2 text-sm text-[var(--text-primary)] placeholder:text-slate-400 transition-[border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:bg-[var(--bg-muted)] disabled:opacity-60',
          hasError
            ? 'border-[var(--status-error)] focus:border-[var(--status-error)] focus-visible:border-[var(--status-error)] focus-visible:ring-[var(--status-error)]/15'
            : 'border-[var(--border-default)] hover:border-slate-400 focus:border-[var(--action-primary)] focus-visible:border-[var(--action-primary)] focus-visible:ring-[var(--action-primary)]/15',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  hasError?: boolean;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, hasError = false, children, ...props }, ref) => {
    return (
      <select
        ref={ref}
        aria-invalid={hasError || undefined}
        className={cn(
          'box-border flex h-10 min-h-[40px] w-full min-w-0 max-w-full rounded-lg border bg-[var(--bg-surface)] py-2 pr-8 pl-3.5 text-sm text-[var(--text-primary)] transition-[border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:bg-[var(--bg-muted)] disabled:opacity-60',
          hasError
            ? 'border-[var(--status-error)] focus:border-[var(--status-error)] focus-visible:border-[var(--status-error)] focus-visible:ring-[var(--status-error)]/15'
            : 'border-[var(--border-default)] hover:border-slate-400 focus:border-[var(--action-primary)] focus-visible:border-[var(--action-primary)] focus-visible:ring-[var(--action-primary)]/15',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);
Select.displayName = 'Select';

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  hasError?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, hasError = false, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        aria-invalid={hasError || undefined}
        className={cn(
          'box-border flex min-h-[96px] w-full min-w-0 max-w-full rounded-lg border bg-[var(--bg-surface)] px-3.5 py-2 text-sm text-[var(--text-primary)] placeholder:text-slate-400 transition-[border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:bg-[var(--bg-muted)] disabled:opacity-60',
          hasError
            ? 'border-[var(--status-error)] focus:border-[var(--status-error)] focus-visible:border-[var(--status-error)] focus-visible:ring-[var(--status-error)]/15'
            : 'border-[var(--border-default)] hover:border-slate-400 focus:border-[var(--action-primary)] focus-visible:border-[var(--action-primary)] focus-visible:ring-[var(--action-primary)]/15',
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export interface FormFieldProps {
  id: string;
  label: string;
  required?: boolean;
  helperText?: string;
  error?: string | null;
  className?: string;
  children: (controlProps: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': true | undefined;
  }) => React.ReactNode;
}

/**
 * FormField chuẩn tiếp cận: gắn label explicit `htmlFor`, hỗ trợ `helperText`,
 * mô tả lỗi qua `aria-describedby` + `aria-invalid`.
 */
export function FormField({
  id,
  label,
  required = false,
  helperText,
  error,
  className,
  children,
}: FormFieldProps) {
  const helperId = helperText ? `${id}-helper` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy =
    [errorId, helperId].filter(Boolean).join(' ') || undefined;

  return (
    <div
      data-invalid={error ? 'true' : undefined}
      className={cn('flex min-w-0 flex-col gap-1.5', className)}
    >
      <label
        htmlFor={id}
        className="text-sm font-medium text-[var(--text-primary)]"
      >
        {label}
        {required && (
          <>
            <span className="ml-1 text-[var(--status-error)]" aria-hidden="true">
              *
            </span>
            <span className="sr-only"> (bắt buộc)</span>
          </>
        )}
      </label>

      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}

      {helperText && (
        <p id={helperId} className="text-xs text-[var(--text-secondary)]">
          {helperText}
        </p>
      )}

      {error && (
        <p
          id={errorId}
          role="alert"
          className="text-sm font-medium text-[var(--status-error)]"
        >
          {error}
        </p>
      )}
    </div>
  );
}
