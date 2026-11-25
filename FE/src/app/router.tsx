import * as React from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { AppShell } from '@/app/AppShell';
import { getDefaultRouteForUser, useAuthStore } from '@/app/auth-store';
import { AdminAuditEventsPage } from '@/features/admin/AdminAuditEventsPage';
import { AdminBenchmarksPage } from '@/features/admin/AdminBenchmarksPage';
import { AdminJobsPage } from '@/features/admin/AdminJobsPage';
import { AdminOverviewPage } from '@/features/admin/AdminOverviewPage';
import { AdminSettingsPage } from '@/features/admin/AdminSettingsPage';
import { AdminUsersPage } from '@/features/admin/AdminUsersPage';
import { ChangePasswordPage } from '@/features/auth/ChangePasswordPage';
import { ForbiddenPage } from '@/features/auth/ForbiddenPage';
import { LoginPage } from '@/features/auth/LoginPage';
import { NotFoundPage } from '@/features/auth/NotFoundPage';
import { CaseDetailPage } from '@/features/cases/CaseDetailPage';
import { DoctorOverviewPage } from '@/features/cases/DoctorOverviewPage';
import { DoctorProfilePage } from '@/features/cases/DoctorProfilePage';
import { PatientDetailPage } from '@/features/patients/PatientDetailPage';
import { PatientsListPage } from '@/features/patients/PatientsListPage';
import type { UserRole } from '@/shared/api/types';
import { CardSkeleton, ErrorState } from '@/shared/ui';

const LazyViewerWorkspacePage = React.lazy(
  () => import('@/features/viewer/ViewerWorkspacePage'),
);

function BootstrapLoadingScreen() {
  return (
    <main
      role="status"
      aria-live="polite"
      className="flex min-h-dvh items-center justify-center bg-[var(--bg-canvas)] p-6"
    >
      <div className="w-full max-w-md">
        <CardSkeleton />
        <p className="mt-3 text-center text-sm text-[var(--text-secondary)]">
          Đang kiểm tra phiên đăng nhập...
        </p>
      </div>
    </main>
  );
}

function ViewerLoadingFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[420px] flex-col items-center justify-center gap-3 rounded-xl border border-[var(--viewer-border)] bg-[var(--viewer-bg)] p-6 text-[var(--viewer-text)]"
    >
      <p className="text-sm font-medium">
        Đang tải module Viewer MRI (NiiVue)...
      </p>
    </div>
  );
}

function BootstrapRetryScreen() {
  const bootstrapError = useAuthStore((s) => s.bootstrapError);
  const bootstrapSession = useAuthStore((s) => s.bootstrapSession);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--bg-canvas)] p-6">
      <div className="w-full max-w-md">
        <ErrorState
          title="Không thể kiểm tra phiên làm việc"
          error={bootstrapError}
          onRetry={() => {
            void bootstrapSession();
          }}
        />
      </div>
    </main>
  );
}

function AuthGuard({
  children,
  allowMustChangePassword = false,
}: {
  children: React.ReactNode;
  allowMustChangePassword?: boolean;
}) {
  const location = useLocation();
  const status = useAuthStore((s) => s.status);
  const bootstrapError = useAuthStore((s) => s.bootstrapError);
  const suppressReturnTo = useAuthStore(
    (s) => s.suppressReturnTo || s.logoutSyncPending,
  );

  if (status === 'bootstrapping') {
    if (bootstrapError) {
      return <BootstrapRetryScreen />;
    }
    return <BootstrapLoadingScreen />;
  }

  if (status === 'anonymous') {
    const shouldKeepFrom =
      !suppressReturnTo && location.pathname !== '/change-password';
    return (
      <Navigate
        to="/login"
        state={shouldKeepFrom ? { from: location } : undefined}
        replace
      />
    );
  }

  if (status === 'must_change_password' && !allowMustChangePassword) {
    return <Navigate to="/change-password" replace />;
  }

  return <>{children}</>;
}

function GuestRoute({ children }: { children: React.ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const bootstrapError = useAuthStore((s) => s.bootstrapError);

  if (status === 'bootstrapping') {
    if (bootstrapError) {
      return <BootstrapRetryScreen />;
    }
    return <BootstrapLoadingScreen />;
  }

  if (status === 'must_change_password') {
    return <Navigate to="/change-password" replace />;
  }

  if (status === 'authenticated' && user) {
    return <Navigate to={getDefaultRouteForUser(user)} replace />;
  }

  return <>{children}</>;
}

function RoleGuard({
  allowedRole,
  children,
}: {
  allowedRole: UserRole;
  children: React.ReactNode;
}) {
  const user = useAuthStore((s) => s.user);
  if (!user || user.role !== allowedRole) {
    return <Navigate to="/403" replace />;
  }
  return <>{children}</>;
}

function RoleHomeRedirect() {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const bootstrapError = useAuthStore((s) => s.bootstrapError);

  if (status === 'bootstrapping') {
    if (bootstrapError) {
      return <BootstrapRetryScreen />;
    }
    return <BootstrapLoadingScreen />;
  }

  return <Navigate to={getDefaultRouteForUser(user)} replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RoleHomeRedirect />} />

      <Route
        path="/login"
        element={
          <GuestRoute>
            <LoginPage />
          </GuestRoute>
        }
      />

      <Route
        path="/change-password"
        element={
          <AuthGuard allowMustChangePassword>
            <ChangePasswordPage />
          </AuthGuard>
        }
      />

      <Route path="/403" element={<ForbiddenPage />} />

      <Route
        path="/doctor"
        element={
          <AuthGuard>
            <RoleGuard allowedRole="doctor">
              <AppShell role="doctor" />
            </RoleGuard>
          </AuthGuard>
        }
      >
        <Route index element={<DoctorOverviewPage />} />
        <Route path="patients" element={<PatientsListPage />} />
        <Route path="patients/:id" element={<PatientDetailPage />} />
        <Route path="cases/:id" element={<CaseDetailPage />} />
        <Route
          path="cases/:id/viewer"
          element={
            <React.Suspense fallback={<ViewerLoadingFallback />}>
              <LazyViewerWorkspacePage />
            </React.Suspense>
          }
        />
        <Route path="profile" element={<DoctorProfilePage />} />
      </Route>

      <Route
        path="/admin"
        element={
          <AuthGuard>
            <RoleGuard allowedRole="admin">
              <AppShell role="admin" />
            </RoleGuard>
          </AuthGuard>
        }
      >
        <Route index element={<AdminOverviewPage />} />
        <Route path="users" element={<AdminUsersPage />} />
        <Route path="jobs" element={<AdminJobsPage />} />
        <Route path="benchmarks" element={<AdminBenchmarksPage />} />
        <Route path="settings" element={<AdminSettingsPage />} />
        <Route path="audit-events" element={<AdminAuditEventsPage />} />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
