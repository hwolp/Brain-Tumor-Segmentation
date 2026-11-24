import * as React from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/app/auth-store';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { queryClient as defaultQueryClient } from '@/shared/api/queryClient';
import { ToastProvider } from '@/shared/ui';

export interface AppProvidersProps {
  children: React.ReactNode;
  client?: QueryClient;
  autoBootstrap?: boolean;
}

export function AppProviders({
  children,
  client = defaultQueryClient,
  autoBootstrap = true,
}: AppProvidersProps) {
  const bootstrapSession = useAuthStore((s) => s.bootstrapSession);

  React.useEffect(() => {
    if (autoBootstrap) {
      void bootstrapSession();
    }
  }, [autoBootstrap, bootstrapSession]);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
