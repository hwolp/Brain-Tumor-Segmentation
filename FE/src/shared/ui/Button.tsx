import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150 cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--action-primary)] text-[var(--action-primary-foreground)] hover:bg-[var(--action-primary-hover)]',
        secondary:
          'bg-[var(--bg-muted)] text-[var(--text-primary)] border border-[var(--border-default)] hover:bg-slate-200/70',
        outline:
          'border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-muted)]',
        ghost:
          'bg-transparent text-[var(--text-primary)] hover:bg-[var(--bg-muted)]',
        destructive:
          'bg-[var(--status-error)] text-white hover:bg-red-800',
      },
      size: {
        sm: 'h-9 min-h-[36px] px-3 py-1.5 text-xs sm:text-sm',
        md: 'h-10 min-h-[40px] px-4 py-2 text-sm',
        lg: 'h-11 min-h-[44px] px-5 py-2.5 text-sm sm:text-base',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  isLoading?: boolean;
  loadingText?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      type = 'button',
      isLoading = false,
      loadingText,
      disabled,
      children,
      ...props
    },
    ref,
  ) => {
    const isDisabled = Boolean(disabled || isLoading);
    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={isLoading || undefined}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      >
        {isLoading && (
          <Loader2 className="size-4 animate-spin shrink-0" aria-hidden="true" />
        )}
        <span className="inline-flex items-center justify-center gap-2">
          {isLoading && loadingText ? loadingText : children}
        </span>
      </button>
    );
  },
);
Button.displayName = 'Button';
