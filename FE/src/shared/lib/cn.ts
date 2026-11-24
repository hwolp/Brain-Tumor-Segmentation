import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Gộp các lớp CSS và loại bỏ xung đột Tailwind một cách an toàn.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
