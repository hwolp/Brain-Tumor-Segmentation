import * as React from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Brain,
  ChevronLeft,
  ChevronRight,
  Cpu,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  ShieldCheck,
  UserCircle,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { useAuthStore } from '@/app/auth-store';
import { ReauthModal } from '@/features/auth/ReauthModal';
import type { UserRole } from '@/shared/api/types';
import { cn } from '@/shared/lib/cn';
import {
  Alert,
  Button,
  ConfirmDialog,
  IconButton,
  StatusBadge,
} from '@/shared/ui';
import { useViewerStore } from '@/viewer-adapter/viewerStore';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
}

const DOCTOR_NAV_ITEMS: readonly NavItem[] = [
  { to: '/doctor', label: 'Tổng quan ca', icon: LayoutDashboard, end: true },
  { to: '/doctor/patients', label: 'Bệnh nhân', icon: Users },
  { to: '/doctor/profile', label: 'Tài khoản cá nhân', icon: UserCircle, end: true },
];

/**
 * Điều hướng dành riêng cho Admin: tuyệt đối không chứa liên kết tới hồ sơ bệnh nhân hay MRI viewer.
 */
const ADMIN_NAV_ITEMS: readonly NavItem[] = [
  { to: '/admin', label: 'Tổng quan hệ thống', icon: Activity, end: true },
  { to: '/admin/users', label: 'Tài khoản bác sĩ', icon: UserCog },
  { to: '/admin/jobs', label: 'Quản lý tác vụ AI', icon: Cpu },
  { to: '/admin/settings', label: 'Cấu hình vận hành', icon: Settings },
  { to: '/admin/audit-events', label: 'Nhật ký quản trị', icon: ShieldCheck },
];

export interface AppShellProps {
  role: UserRole;
}

export function AppShell({ role }: AppShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const fixtureMode = useAuthStore((s) => s.fixtureMode);
  const logout = useAuthStore((s) => s.logout);
  const isViewerDirty = useViewerStore((s) => s.isDirty);

  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);
  const [isLoggingOut, setIsLoggingOut] = React.useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = React.useState(false);
  const [pendingNavPath, setPendingNavPath] = React.useState<string | null>(
    null,
  );

  const navItems = role === 'admin' ? ADMIN_NAV_ITEMS : DOCTOR_NAV_ITEMS;
  const workspaceTitle =
    role === 'admin' ? 'Quản trị hệ thống' : 'Trạm làm việc Bác sĩ';

  React.useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [mobileMenuOpen]);

  const performLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logout();
      setLogoutConfirmOpen(false);
      navigate('/login', { replace: true, state: null });
    } finally {
      setIsLoggingOut(false);
    }
  };

  const handleLogoutClick = () => {
    if (isViewerDirty || useViewerStore.getState().isDirty) {
      setLogoutConfirmOpen(true);
      return;
    }
    void performLogout();
  };

  const handleNavClick = (
    event: React.MouseEvent<HTMLAnchorElement>,
    targetPath: string,
    onItemClick?: () => void,
  ) => {
    if (location.pathname === targetPath) {
      onItemClick?.();
      return;
    }
    if (isViewerDirty || useViewerStore.getState().isDirty) {
      event.preventDefault();
      setMobileMenuOpen(false);
      setPendingNavPath(targetPath);
      return;
    }
    onItemClick?.();
  };

  const handleConfirmDiscardAndNavigate = () => {
    const target = pendingNavPath;
    setPendingNavPath(null);
    useViewerStore.getState().resetViewerState();
    if (target) {
      navigate(target);
    }
  };

  const renderNavLinks = (isCompact: boolean, onItemClick?: () => void) => (
    <ul className="flex flex-col gap-1">
      {navItems.map((item) => {
        const Icon = item.icon;
        return (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              onClick={(event) => handleNavClick(event, item.to, onItemClick)}
              title={isCompact ? item.label : undefined}
              className={({ isActive }) =>
                cn(
                  'flex h-9 min-h-[36px] items-center gap-2.5 rounded-[var(--radius-pill)] border px-3.5 text-sm font-medium transition-colors duration-150 ease-[var(--ease-out)]',
                  isCompact && 'justify-center px-2',
                  isActive
                    ? 'border-[var(--color-accent)]/25 bg-[var(--color-accent-soft)] text-[var(--color-accent-hi)] shadow-[var(--edge-light)]'
                    : 'border-transparent text-[var(--color-ink-2)] hover:bg-[var(--color-paper-2)] hover:text-[var(--color-ink)]',
                )
              }
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {!isCompact && <span className="truncate">{item.label}</span>}
              {isCompact && <span className="sr-only">{item.label}</span>}
            </NavLink>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="flex min-h-dvh w-full bg-[var(--color-paper)] text-[var(--color-ink)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-[var(--radius-pill)] focus:bg-[var(--color-accent)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--color-accent-ink)]"
      >
        Chuyển đến nội dung chính
      </a>

      {/* Desktop sidebar */}
      <aside
        data-print-hidden="true"
        aria-label="Điều hướng chính"
        className={cn(
          'hidden lg:flex lg:flex-col lg:shrink-0 lg:border-r lg:border-[var(--color-rule)] lg:bg-[color-mix(in_oklab,var(--color-light)_84%,transparent)] transition-[width] duration-150',
          collapsed ? 'lg:w-[72px]' : 'lg:w-64',
        )}
      >
        <div
          className={cn(
            'flex h-16 items-center border-b border-[var(--color-rule-2)]',
            collapsed ? 'justify-center px-2' : 'justify-between px-4',
          )}
        >
          {!collapsed && (
            <div className="flex min-w-0 items-center gap-2.5">
              <Brain
                className="size-5 shrink-0 text-[var(--color-accent)]"
                aria-hidden="true"
              />
              <span className="font-display truncate text-base font-medium text-[var(--color-ink)]">
                TDA-SegUNet
              </span>
            </div>
          )}
          <IconButton
            aria-label={collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'}
            aria-expanded={!collapsed}
            variant="ghost"
            onClick={() => setCollapsed((v) => !v)}
            icon={
              collapsed ? (
                <ChevronRight className="size-4" />
              ) : (
                <ChevronLeft className="size-4" />
              )
            }
          />
        </div>

        <nav className="flex-1 overflow-y-auto p-3" aria-label="Menu vai trò">
          {renderNavLinks(collapsed)}
        </nav>

        <div
          className={cn(
            'border-t border-[var(--border-default)] py-3',
            collapsed ? 'px-2' : 'px-4',
          )}
        >
          <div className={cn('flex items-center gap-2', collapsed && 'justify-center')}>
            <StatusBadge
              label={role === 'admin' ? 'Admin' : 'Bác sĩ'}
              tone={role === 'admin' ? 'warning' : 'info'}
              showIcon={!collapsed}
            />
          </div>
        </div>
      </aside>

      {/* Mobile / Tablet drawer */}
      {mobileMenuOpen && (
        <div
          data-print-hidden="true"
          className="fixed inset-0 z-40 flex lg:hidden"
        >
          <div
            className="fixed inset-0 bg-slate-900/50"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <aside
            aria-label="Menu điều hướng di động"
            className="relative z-10 flex w-72 max-w-[85vw] flex-col border-r border-[var(--border-default)] bg-[var(--bg-surface)]"
          >
            <div className="flex h-16 items-center justify-between border-b border-[var(--border-default)] px-4">
              <div className="flex items-center gap-2.5">
                <Brain
                  className="size-5 text-[var(--action-primary)]"
                  aria-hidden="true"
                />
                <span className="text-base font-semibold text-[var(--text-primary)]">
                  TDA-SegUNet
                </span>
              </div>
              <IconButton
                aria-label="Đóng menu điều hướng"
                variant="ghost"
                onClick={() => setMobileMenuOpen(false)}
                icon={<X className="size-4" />}
              />
            </div>
            <nav className="flex-1 overflow-y-auto p-3">
              {renderNavLinks(false, () => setMobileMenuOpen(false))}
            </nav>
          </aside>
        </div>
      )}

      {/* Main content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-print-hidden="true"
          className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-[var(--color-rule)] bg-[color-mix(in_oklab,var(--color-light)_80%,transparent)] px-4 py-2 sm:px-6 lg:h-16 lg:flex-nowrap lg:py-0"
        >
          <div className="flex items-center gap-3">
            <IconButton
              aria-label="Mở menu điều hướng"
              aria-expanded={mobileMenuOpen}
              variant="outline"
              className="lg:hidden"
              onClick={() => setMobileMenuOpen(true)}
              icon={<Menu className="size-4" />}
            />
            <span className="text-sm font-medium text-[var(--text-primary)]">
              {workspaceTitle}
            </span>
          </div>

          <div className="ml-auto flex flex-wrap items-center justify-end gap-2 sm:gap-3">
            {user && (
              <div className="hidden leading-tight sm:flex sm:flex-col sm:items-end">
                <span className="text-sm font-medium leading-tight text-[var(--text-primary)]">
                  {user.display_name}
                </span>
                <span className="text-xs leading-tight text-[var(--text-secondary)]">
                  @{user.username}
                </span>
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              isLoading={isLoggingOut}
              loadingText="Đang thoát..."
              onClick={handleLogoutClick}
            >
              <LogOut className="size-4" aria-hidden="true" />
              Đăng xuất
            </Button>
          </div>
        </header>

        {fixtureMode && (
          <div
            data-print-hidden="true"
            className="mx-auto w-full max-w-[1600px] px-4 pt-4 sm:px-6"
          >
            <Alert
              variant="warning"
              title="Đang bật chế độ dữ liệu mẫu (Fixture Mode)"
              description="Dữ liệu hiển thị là fixture cục bộ phục vụ phát triển/kiểm thử P1, không phải dữ liệu từ máy chủ PostgreSQL/FastAPI."
            />
          </div>
        )}

        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1600px] flex-1 p-4 outline-none sm:p-6"
        >
          <Outlet />
        </main>
      </div>

      <ConfirmDialog
        open={pendingNavPath !== null}
        onClose={() => setPendingNavPath(null)}
        onConfirm={handleConfirmDiscardAndNavigate}
        title="Xác nhận bỏ thay đổi và rời trang"
        description="Bạn đang có chỉnh sửa mask chưa lưu. Quay lại để lưu hoặc bỏ thay đổi và rời khỏi trang hiện tại?"
        cancelLabel="Quay lại để lưu"
        confirmLabel="Bỏ thay đổi và rời trang"
        variant="destructive"
      />

      <ConfirmDialog
        open={logoutConfirmOpen}
        onClose={() => setLogoutConfirmOpen(false)}
        onConfirm={performLogout}
        title="Xác nhận bỏ thay đổi và đăng xuất"
        description="Bạn đang có chỉnh sửa mask chưa lưu. Quay lại để lưu hoặc bỏ thay đổi và đăng xuất?"
        cancelLabel="Quay lại để lưu"
        confirmLabel="Bỏ thay đổi và đăng xuất"
        variant="destructive"
        isSubmitting={isLoggingOut}
      />

      <ReauthModal />
    </div>
  );
}
