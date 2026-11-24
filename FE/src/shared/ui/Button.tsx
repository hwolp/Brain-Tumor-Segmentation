import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-pill)] px-4 py-2 text-sm font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.98] cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--color-accent)] text-[var(--color-accent-ink)] shadow-[var(--edge-light),var(--shadow-card)] hover:bg-[var(--color-accent-hi)]',
        secondary:
          'border border-[var(--color-rule)] bg-[var(--color-paper-2)] text-[var(--color-ink)] hover:bg-[var(--color-paper-3)]',
        outline:
          'border border-[var(--color-rule)] bg-[color-mix(in_oklab,var(--color-light)_84%,transparent)] text-[var(--color-ink)] shadow-[var(--edge-light)] hover:bg-[var(--color-light)]',
        ghost:
          'bg-transparent text-[var(--color-ink-2)] hover:bg-[var(--color-paper-2)] hover:text-[var(--color-ink)]',
        destructive:
          'bg-[var(--status-error)] text-white shadow-[var(--shadow-card)] hover:bg-red-800',
      },
      size: {
        sm: 'h-9 min-h-[36px] px-3.5 py-2 text-xs sm:text-sm',
        md: 'h-10 min-h-[40px] px-4 py-2 text-sm',
        lg: 'h-12 min-h-[48px] px-6 py-2.5 text-sm sm:text-base',
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
