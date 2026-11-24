import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/shared/lib/cn';

const iconButtonVariants = cva(
  'relative inline-flex shrink-0 items-center justify-center rounded-[var(--radius-pill)] transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.98] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        ghost:
          'bg-transparent text-[var(--color-ink-2)] hover:bg-[var(--color-paper-2)] hover:text-[var(--color-ink)]',
        outline:
          'border border-[var(--color-rule)] bg-[color-mix(in_oklab,var(--color-light)_84%,transparent)] text-[var(--color-ink)] shadow-[var(--edge-light)] hover:bg-[var(--color-light)]',
        primary:
          'bg-[var(--color-accent)] text-[var(--color-accent-ink)] shadow-[var(--shadow-card)] hover:bg-[var(--color-accent-hi)]',
        dark:
          'border border-[var(--viewer-border)] bg-[var(--viewer-surface)] text-[var(--viewer-text)] hover:bg-[var(--viewer-raised)]',
      },
      size: {
        sm: 'size-8 min-h-[32px] min-w-[32px]',
        md: 'size-9 min-h-[36px] min-w-[36px]',
        lg: 'size-10 min-h-[40px] min-w-[40px]',
      },
    },
    defaultVariants: {
      variant: 'outline',
      size: 'md',
    },
  },
);

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {
  'aria-label': string;
  tooltip?: string;
  icon: React.ReactNode;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      'aria-label': ariaLabel,
      tooltip,
      icon,
      variant,
      size,
      type = 'button',
      className,
      ...props
    },
    ref,
  ) => {
    const effectiveTooltip = tooltip ?? ariaLabel;
    return (
      <button
        ref={ref}
        type={type}
        aria-label={ariaLabel}
        title={effectiveTooltip}
        className={cn(iconButtonVariants({ variant, size }), 'group', className)}
        {...props}
      >
        <span aria-hidden="true" className="inline-flex items-center justify-center">
          {icon}
        </span>
      </button>
    );
  },
);
IconButton.displayName = 'IconButton';
