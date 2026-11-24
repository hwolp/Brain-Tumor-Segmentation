import { create } from 'zustand';
import {
  apiRequest,
  bumpSessionEpoch,
  getSessionEpoch,
  registerAccessTokenProvider,
  registerAuthFailureHandler,
  registerSessionRefreshHandler,
} from '@/shared/api/client';
import { ApiClientError, normalizeErrorCode } from '@/shared/api/errors';
import { FIXTURE_USERS } from '@/shared/api/fixtures';
import { clearSessionCache } from '@/shared/api/queryClient';
import type {
  AuthTokenResponseDto,
  UserDto,
  UserRole,
} from '@/shared/api/types';
import { useViewerStore } from '@/viewer-adapter/viewerStore';
import {
  broadcastAuthEvent,
  ensureAuthBroadcastChannel,
  registerAuthBroadcastListener,
  runWithRefreshLock,
  type SessionRevokeReason,
} from './sessionCoordinator';

export type AuthStatus =
  | 'bootstrapping'
  | 'anonymous'
  | 'authenticated'
  | 'must_change_password';

export interface AuthNotice {
  variant: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
}

export interface ClearSessionOptions {
  notice?: AuthNotice | null;
  broadcastLogout?: boolean;
  broadcastReason?: SessionRevokeReason;
  previousUserId?: string | null;
  skipEpochBump?: boolean;
  suppressReturnTo?: boolean;
}

export interface ReauthResult {
  user: UserDto;
  switchedAccount: boolean;
}

const trackedObjectUrls = new Set<string>();

/**
 * Đăng ký object URL (blob:) được tạo trong phiên để tự động thu hồi khi logout/đổi tài khoản.
 */
export function registerTrackedObjectUrl(url: string): string {
  trackedObjectUrls.add(url);
  return url;
}

export function revokeTrackedObjectUrl(url: string): void {
  if (trackedObjectUrls.has(url)) {
    trackedObjectUrls.delete(url);
    if (typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }
  }
}

export function revokeAllTrackedObjectUrls(): void {
  for (const url of trackedObjectUrls) {
    if (typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }
  }
  trackedObjectUrls.clear();
}

export function getTrackedObjectUrlCount(): number {
  return trackedObjectUrls.size;
}

function getEnvFixtureDefault(): boolean {
  return import.meta.env.VITE_USE_FIXTURES === 'true';
}

export function getDefaultRouteForUser(user: UserDto | null): string {
  if (!user) return '/login';
  if (user.must_change_password) return '/change-password';
  return user.role === 'admin' ? '/admin' : '/doctor';
}

export function isAllowedReturnPath(
  path: string | undefined | null,
  role: UserRole,
): boolean {
  if (!path || !path.startsWith('/') || path.startsWith('//')) {
    return false;
  }
  const pathname = path.split(/[?#]/)[0] ?? '';
  if (role === 'doctor') {
    return pathname === '/doctor' || pathname.startsWith('/doctor/');
  }
  if (role === 'admin') {
    return pathname === '/admin' || pathname.startsWith('/admin/');
  }
  return false;
}

function buildTerminationNotice(reason: SessionRevokeReason): AuthNotice {
  switch (reason) {
    case 'account_disabled':
      return {
        variant: 'error',
        title: 'Tài khoản đã bị khóa',
        message:
          'Tài khoản của bạn đã bị khóa hoặc vô hiệu hóa. Mọi phiên đăng nhập và dữ liệu tạm đã được dọn sạch.',
      };
    case 'refresh_reused':
      return {
        variant: 'warning',
        title: 'Phiên làm việc đã bị thu hồi',
        message:
          'Phát hiện bất thường khi làm mới phiên đăng nhập. Vui lòng đăng nhập lại để bảo vệ tài khoản.',
      };
    case 'password_changed':
      return {
        variant: 'success',
        title: 'Đổi mật khẩu thành công',
        message:
          'Đổi mật khẩu thành công. Vui lòng đăng nhập lại bằng mật khẩu mới.',
      };
    case 'revoked':
      return {
        variant: 'warning',
        title: 'Phiên làm việc đã bị thu hồi',
        message:
          'Phiên đăng nhập của bạn đã bị thu hồi. Vui lòng đăng nhập lại.',
      };
    case 'expired':
    default:
      return {
        variant: 'warning',
        title: 'Phiên đăng nhập đã hết hạn',
        message:
          'Phiên làm việc đã hết hạn hoặc không còn hợp lệ. Vui lòng đăng nhập lại.',
      };
  }
}

export interface AuthState {
  status: AuthStatus;
  user: UserDto | null;
  accessToken: string | null;
  bootstrapError: ApiClientError | null;
  fixtureMode: boolean;
  reauthRequired: boolean;
  reauthUserId: string | null;
  reauthUsername: string | null;
  reauthReason: string | null;
  authNotice: AuthNotice | null;
  logoutSyncPending: boolean;
  suppressReturnTo: boolean;
  setFixtureMode: (enabled: boolean) => void;
  setAuthNotice: (notice: AuthNotice | null) => void;
  clearAuthNotice: () => void;
  bootstrapSession: () => Promise<void>;
  refreshSession: (failedWithToken?: string | null) => Promise<string | null>;
  login: (username: string, password: string) => Promise<UserDto>;
  loginWithFixture: (role: UserRole) => Promise<UserDto>;
  reauthenticate: (
    password: string,
    usernameOverride?: string,
  ) => Promise<ReauthResult>;
  completePasswordChange: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
  retryServerLogout: () => Promise<boolean>;
  clearLocalSession: (options?: ClearSessionOptions) => Promise<void>;
  handleRefreshRejected: (reason: SessionRevokeReason) => Promise<void>;
  handleSessionTerminated: (params: {
    reason: SessionRevokeReason;
    broadcast: boolean;
  }) => Promise<void>;
}

let activeBootstrapPromise: Promise<void> | null = null;
let activeRefreshPromise: Promise<string | null> | null = null;
let activeLogoutAbortController: AbortController | null = null;

function abortPendingServerLogout(): void {
  if (activeLogoutAbortController) {
    activeLogoutAbortController.abort();
    activeLogoutAbortController = null;
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'bootstrapping',
  user: null,
  accessToken: null,
  bootstrapError: null,
  fixtureMode: getEnvFixtureDefault(),
  reauthRequired: false,
  reauthUserId: null,
  reauthUsername: null,
  reauthReason: null,
  authNotice: null,
  logoutSyncPending: false,
  suppressReturnTo: false,

  setFixtureMode: (enabled) => set({ fixtureMode: enabled }),
  setAuthNotice: (authNotice) => set({ authNotice }),
  clearAuthNotice: () => set({ authNotice: null, logoutSyncPending: false }),

  bootstrapSession: async () => {
    ensureAuthBroadcastChannel();

    if (activeBootstrapPromise) {
      return activeBootstrapPromise;
    }

    const current = get();
    if (current.fixtureMode) {
      set((state) => ({
        status: state.user
          ? state.user.must_change_password
            ? 'must_change_password'
            : 'authenticated'
          : 'anonymous',
        bootstrapError: null,
      }));
      return;
    }

    set({ status: 'bootstrapping', bootstrapError: null });

    activeBootstrapPromise = (async () => {
      const bootstrapEpoch = getSessionEpoch();
      try {
        await runWithRefreshLock(async () => {
          if (getSessionEpoch() !== bootstrapEpoch) {
            return;
          }

          const refreshed = await apiRequest<AuthTokenResponseDto>(
            '/auth/refresh',
            {
              method: 'POST',
              skipAuth: true,
              skipRefreshOn401: true,
            },
          );

          if (getSessionEpoch() !== bootstrapEpoch) {
            return;
          }

          const nextUser =
            refreshed.user ??
            (await apiRequest<UserDto>('/auth/me', {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${refreshed.access_token}`,
              },
              skipAuth: true,
            }));

          if (getSessionEpoch() !== bootstrapEpoch) {
            return;
          }

          set({
            accessToken: refreshed.access_token,
            user: nextUser,
            status: nextUser.must_change_password
              ? 'must_change_password'
              : 'authenticated',
            bootstrapError: null,
            reauthRequired: false,
            reauthUserId: null,
            reauthUsername: null,
            reauthReason: null,
            logoutSyncPending: false,
            suppressReturnTo: false,
          });
        });
      } catch (error) {
        if (getSessionEpoch() !== bootstrapEpoch) {
          return;
        }
        if (
          error instanceof ApiClientError &&
          (error.status === 401 || error.status === 403)
        ) {
          const code = normalizeErrorCode(error.code);
          let notice: AuthNotice | null = get().authNotice;
          const isDisabled =
            code === 'account_disabled' || code === 'account_locked';
          if (isDisabled) {
            notice = buildTerminationNotice('account_disabled');
          } else if (code === 'refresh_reused') {
            notice = buildTerminationNotice('refresh_reused');
          }

          set((state) => ({
            status: 'anonymous',
            user: null,
            accessToken: null,
            bootstrapError: null,
            reauthRequired: false,
            reauthUserId: null,
            reauthUsername: null,
            reauthReason: null,
            authNotice: notice,
            suppressReturnTo: isDisabled ? true : state.suppressReturnTo,
          }));
          return;
        }

        const apiErr =
          error instanceof ApiClientError
            ? error
            : new ApiClientError({
                status: 0,
                code: 'network_error',
                isNetworkError: true,
              });

        set({
          status: 'bootstrapping',
          user: null,
          accessToken: null,
          bootstrapError: apiErr,
        });
      } finally {
        activeBootstrapPromise = null;
      }
    })();

    return activeBootstrapPromise;
  },

  refreshSession: async (failedWithToken = null) => {
    ensureAuthBroadcastChannel();

    if (get().fixtureMode) {
      return get().accessToken;
    }

    const currentToken = get().accessToken;
    if (failedWithToken && currentToken && currentToken !== failedWithToken) {
      return currentToken;
    }

    if (activeRefreshPromise) {
      return activeRefreshPromise;
    }

    activeRefreshPromise = (async () => {
      const refreshEpoch = getSessionEpoch();
      try {
        return await runWithRefreshLock(async () => {
          if (getSessionEpoch() !== refreshEpoch) {
            return null;
          }
          const tokenAfterLock = get().accessToken;
          if (
            failedWithToken &&
            tokenAfterLock &&
            tokenAfterLock !== failedWithToken
          ) {
            return tokenAfterLock;
          }

          const previousUserId = get().user?.id ?? get().reauthUserId;
          const refreshed = await apiRequest<AuthTokenResponseDto>(
            '/auth/refresh',
            {
              method: 'POST',
              skipAuth: true,
              skipRefreshOn401: true,
            },
          );

          if (getSessionEpoch() !== refreshEpoch) {
            return null;
          }

          const nextUser =
            refreshed.user ??
            (await apiRequest<UserDto>('/auth/me', {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${refreshed.access_token}`,
              },
              skipAuth: true,
            }));

          if (getSessionEpoch() !== refreshEpoch) {
            return null;
          }

          if (previousUserId && previousUserId !== nextUser.id) {
            await get().clearLocalSession({
              suppressReturnTo: true,
              notice: {
                variant: 'warning',
                title: 'Tài khoản làm việc đã thay đổi',
                message:
                  'Phiên trình duyệt thuộc về tài khoản khác. Dữ liệu cũ đã được xóa, vui lòng đăng nhập lại.',
              },
            });
            return null;
          }

          set({
            accessToken: refreshed.access_token,
            user: nextUser,
            status: nextUser.must_change_password
              ? 'must_change_password'
              : 'authenticated',
            bootstrapError: null,
            reauthRequired: false,
            reauthUserId: null,
            reauthUsername: null,
            reauthReason: null,
            suppressReturnTo: false,
          });

          broadcastAuthEvent({
            type: 'refresh_succeeded',
            userId: nextUser.id,
          });

          return refreshed.access_token;
        });
      } catch (error) {
        if (getSessionEpoch() !== refreshEpoch) {
          return null;
        }
        if (error instanceof ApiClientError) {
          const code = normalizeErrorCode(error.code);
          if (code === 'account_disabled' || code === 'account_locked') {
            await get().handleSessionTerminated({
              reason: 'account_disabled',
              broadcast: true,
            });
            return null;
          }
          if (error.status === 401 || error.status === 403) {
            const reason: SessionRevokeReason =
              code === 'refresh_reused' ? 'refresh_reused' : 'expired';
            await get().handleRefreshRejected(reason);
            return null;
          }
        }
        throw error;
      } finally {
        activeRefreshPromise = null;
      }
    })();

    return activeRefreshPromise;
  },

  handleRefreshRejected: async (reason) => {
    const state = get();
    const hasDraft = useViewerStore.getState().isDirty;
    const reauthUid = state.user?.id ?? state.reauthUserId;
    const reauthUname = state.user?.username ?? state.reauthUsername;

    if (
      hasDraft &&
      reauthUid &&
      reason !== 'account_disabled' &&
      reason !== 'password_changed'
    ) {
      set({
        accessToken: null,
        reauthRequired: true,
        reauthUserId: reauthUid,
        reauthUsername: reauthUname,
        reauthReason:
          reason === 'refresh_reused'
            ? 'Phiên làm việc đã bị thu hồi do xung đột khóa làm mới. Vui lòng đăng nhập lại đúng tài khoản bác sĩ hiện tại để giữ bản nháp mask chưa lưu.'
            : 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại đúng tài khoản bác sĩ hiện tại để tiếp tục và giữ nguyên bản nháp mask trong bộ nhớ.',
      });
      return;
    }

    await get().handleSessionTerminated({ reason, broadcast: true });
  },

  handleSessionTerminated: async ({ reason, broadcast }) => {
    const previousUserId = get().user?.id ?? get().reauthUserId ?? null;
    await get().clearLocalSession({
      notice: buildTerminationNotice(reason),
      broadcastReason: broadcast ? reason : undefined,
      previousUserId,
      suppressReturnTo:
        reason === 'account_disabled' || reason === 'password_changed',
    });
  },

  login: async (username: string, password: string) => {
    abortPendingServerLogout();
    if (get().status === 'anonymous') {
      bumpSessionEpoch();
    }
    ensureAuthBroadcastChannel();
    const { fixtureMode } = get();

    if (fixtureMode) {
      const normalized = username.trim().toLowerCase();
      const role: UserRole = normalized.includes('admin') ? 'admin' : 'doctor';
      return get().loginWithFixture(role);
    }

    const response = await apiRequest<AuthTokenResponseDto>('/auth/login', {
      method: 'POST',
      skipAuth: true,
      skipRefreshOn401: true,
      body: { username, password },
    });

    bumpSessionEpoch();
    revokeAllTrackedObjectUrls();
    await clearSessionCache();

    set({
      accessToken: response.access_token,
      user: response.user,
      status: response.user.must_change_password
        ? 'must_change_password'
        : 'authenticated',
      bootstrapError: null,
      reauthRequired: false,
      reauthUserId: null,
      reauthUsername: null,
      reauthReason: null,
      authNotice: null,
      logoutSyncPending: false,
      suppressReturnTo: false,
    });

    broadcastAuthEvent({
      type: 'user_changed',
      userId: response.user.id,
    });

    return response.user;
  },

  loginWithFixture: async (role: UserRole) => {
    abortPendingServerLogout();
    if (!get().fixtureMode) {
      throw new Error(
        'Không thể đăng nhập bằng dữ liệu mẫu khi Fixture Mode đang tắt.',
      );
    }
    ensureAuthBroadcastChannel();
    const targetUser = FIXTURE_USERS[role];
    bumpSessionEpoch();
    revokeAllTrackedObjectUrls();
    await clearSessionCache();
    set({
      accessToken: `fixture-token-${role}`,
      user: targetUser,
      status: targetUser.must_change_password
        ? 'must_change_password'
        : 'authenticated',
      bootstrapError: null,
      reauthRequired: false,
      reauthUserId: null,
      reauthUsername: null,
      reauthReason: null,
      authNotice: null,
      logoutSyncPending: false,
      suppressReturnTo: false,
    });
    broadcastAuthEvent({
      type: 'user_changed',
      userId: targetUser.id,
    });
    return targetUser;
  },

  reauthenticate: async (password: string, usernameOverride?: string) => {
    abortPendingServerLogout();
    const state = get();
    const previousUserId = state.reauthUserId ?? state.user?.id ?? null;
    const targetUsername = (
      usernameOverride ??
      state.reauthUsername ??
      state.user?.username ??
      ''
    ).trim();

    if (state.fixtureMode) {
      const role: UserRole = targetUsername.toLowerCase().includes('admin')
        ? 'admin'
        : 'doctor';
      const targetUser = FIXTURE_USERS[role];
      const switchedAccount = Boolean(
        previousUserId && targetUser.id !== previousUserId,
      );
      if (switchedAccount) {
        bumpSessionEpoch();
        revokeAllTrackedObjectUrls();
        await clearSessionCache();
        broadcastAuthEvent({ type: 'user_changed', userId: targetUser.id });
      }
      set({
        accessToken: `fixture-token-${role}`,
        user: targetUser,
        status: targetUser.must_change_password
          ? 'must_change_password'
          : 'authenticated',
        reauthRequired: false,
        reauthUserId: null,
        reauthUsername: null,
        reauthReason: null,
        bootstrapError: null,
        authNotice: null,
        suppressReturnTo: false,
      });
      return { user: targetUser, switchedAccount };
    }

    let response: AuthTokenResponseDto;
    try {
      response = await apiRequest<AuthTokenResponseDto>('/auth/login', {
        method: 'POST',
        skipAuth: true,
        skipRefreshOn401: true,
        body: { username: targetUsername, password },
      });
    } catch (error) {
      if (error instanceof ApiClientError) {
        const code = normalizeErrorCode(error.code);
        if (code === 'account_disabled' || code === 'account_locked') {
          await get().handleSessionTerminated({
            reason: 'account_disabled',
            broadcast: true,
          });
        }
      }
      throw error;
    }

    const switchedAccount = Boolean(
      previousUserId && response.user.id !== previousUserId,
    );

    if (switchedAccount) {
      // Đổi tài khoản khác -> lập tức hủy bản nháp và xóa toàn bộ dữ liệu người trước
      bumpSessionEpoch();
      revokeAllTrackedObjectUrls();
      await clearSessionCache();
      broadcastAuthEvent({
        type: 'user_changed',
        userId: response.user.id,
      });
    } else {
      // Cùng bác sĩ -> giữ nguyên draft mask trong RAM, chỉ cấp access token mới
      broadcastAuthEvent({
        type: 'refresh_succeeded',
        userId: response.user.id,
      });
    }

    set({
      accessToken: response.access_token,
      user: response.user,
      status: response.user.must_change_password
        ? 'must_change_password'
        : 'authenticated',
      reauthRequired: false,
      reauthUserId: null,
      reauthUsername: null,
      reauthReason: null,
      bootstrapError: null,
      authNotice: null,
      logoutSyncPending: false,
      suppressReturnTo: false,
    });

    return { user: response.user, switchedAccount };
  },

  completePasswordChange: async (
    currentPassword: string,
    newPassword: string,
  ) => {
    const previousUserId = get().user?.id ?? null;
    if (!get().fixtureMode) {
      await apiRequest<void>('/auth/change-password', {
        method: 'POST',
        body: {
          current_password: currentPassword,
          new_password: newPassword,
        },
      });
    }
    await get().clearLocalSession({
      notice: buildTerminationNotice('password_changed'),
      broadcastReason: 'password_changed',
      previousUserId,
      suppressReturnTo: true,
    });
  },

  logout: async () => {
    const { fixtureMode, user, accessToken } = get();
    const previousUserId = user?.id ?? null;
    const logoutEpoch = bumpSessionEpoch();

    await get().clearLocalSession({
      notice: null,
      broadcastLogout: true,
      previousUserId,
      skipEpochBump: true,
      suppressReturnTo: true,
    });

    if (getSessionEpoch() !== logoutEpoch) {
      return;
    }

    if (fixtureMode) {
      set({ logoutSyncPending: false });
      return;
    }

    abortPendingServerLogout();
    const controller = new AbortController();
    activeLogoutAbortController = controller;
    const timeoutId = globalThis.setTimeout(() => controller.abort(), 5000);
    let serverRevokeConfirmed = true;
    try {
      const headers: Record<string, string> = {};
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }
      await apiRequest<void>('/auth/logout', {
        method: 'POST',
        headers,
        skipAuth: true,
        skipRefreshOn401: true,
        signal: controller.signal,
      });
    } catch {
      serverRevokeConfirmed = false;
    } finally {
      globalThis.clearTimeout(timeoutId);
      if (activeLogoutAbortController === controller) {
        activeLogoutAbortController = null;
      }
    }

    if (getSessionEpoch() !== logoutEpoch) {
      return;
    }

    if (!serverRevokeConfirmed) {
      set({
        logoutSyncPending: true,
        authNotice: {
          variant: 'warning',
          title: 'Chưa thể xác nhận đăng xuất với máy chủ',
          message:
            'Dữ liệu phiên cục bộ đã được xóa sạch, nhưng máy chủ chưa xác nhận thu hồi cookie phiên. Nếu dùng máy dùng chung, hãy thử thu hồi lại hoặc đóng trình duyệt.',
        },
      });
    } else {
      set({ logoutSyncPending: false });
    }
  },

  retryServerLogout: async () => {
    const retryEpoch = getSessionEpoch();
    if (get().status !== 'anonymous') {
      return false;
    }
    if (get().fixtureMode) {
      if (getSessionEpoch() === retryEpoch && get().status === 'anonymous') {
        set({ logoutSyncPending: false, authNotice: null });
      }
      return true;
    }
    // Chỉ dùng HttpOnly cookie bts_refresh (credentials: 'include'), không giữ lại Bearer token trong bộ nhớ sau khi logout đã xóa cục bộ.
    abortPendingServerLogout();
    const controller = new AbortController();
    activeLogoutAbortController = controller;
    const timeoutId = globalThis.setTimeout(() => controller.abort(), 5000);
    try {
      await apiRequest<void>('/auth/logout', {
        method: 'POST',
        skipAuth: true,
        skipRefreshOn401: true,
        signal: controller.signal,
      });
      if (getSessionEpoch() !== retryEpoch || get().status !== 'anonymous') {
        return false;
      }
      set({
        logoutSyncPending: false,
        authNotice: {
          variant: 'info',
          title: 'Đã thu hồi phiên trên máy chủ',
          message:
            'Máy chủ đã xác nhận thu hồi cookie phiên làm việc an toàn.',
        },
      });
      return true;
    } catch {
      if (getSessionEpoch() !== retryEpoch || get().status !== 'anonymous') {
        return false;
      }
      set({
        logoutSyncPending: true,
        authNotice: {
          variant: 'warning',
          title: 'Vẫn chưa thể xác nhận thu hồi phiên trên máy chủ',
          message:
            'Kết nối tới máy chủ vẫn gián đoạn. Vui lòng thử lại khi có mạng hoặc đóng trình duyệt.',
        },
      });
      return false;
    } finally {
      globalThis.clearTimeout(timeoutId);
      if (activeLogoutAbortController === controller) {
        activeLogoutAbortController = null;
      }
    }
  },

  clearLocalSession: async (options) => {
    const previousUserId =
      options?.previousUserId ?? get().user?.id ?? get().reauthUserId ?? null;
    if (!options?.skipEpochBump) {
      bumpSessionEpoch();
    }
    revokeAllTrackedObjectUrls();
    set((state) => ({
      accessToken: null,
      user: null,
      status: 'anonymous',
      bootstrapError: null,
      reauthRequired: false,
      reauthUserId: null,
      reauthUsername: null,
      reauthReason: null,
      suppressReturnTo: options?.suppressReturnTo ?? false,
      authNotice:
        options?.notice !== undefined ? options.notice : state.authNotice,
    }));
    await clearSessionCache();

    if (options?.broadcastLogout) {
      broadcastAuthEvent({ type: 'logged_out', userId: previousUserId });
    } else if (options?.broadcastReason) {
      broadcastAuthEvent({
        type: 'session_revoked',
        userId: previousUserId,
        reason: options.broadcastReason,
      });
    }
  },
}));

// Kết nối token provider, refresh single-flight & auth failure handlers từ bộ nhớ runtime
registerAccessTokenProvider(() => useAuthStore.getState().accessToken);
registerSessionRefreshHandler((failedWithToken) =>
  useAuthStore.getState().refreshSession(failedWithToken),
);
registerAuthFailureHandler(async (event) => {
  const store = useAuthStore.getState();
  if (event.code === 'account_disabled' || event.code === 'account_locked') {
    await store.handleSessionTerminated({
      reason: 'account_disabled',
      broadcast: true,
    });
    return;
  }
  if (event.code === 'refresh_reused') {
    await store.handleRefreshRejected('refresh_reused');
    return;
  }
  if (event.code === 'password_change_required') {
    const currentUser = store.user;
    if (currentUser) {
      useAuthStore.setState({
        user: { ...currentUser, must_change_password: true },
        status: 'must_change_password',
      });
    }
  }
});

registerAuthBroadcastListener((payload) => {
  const state = useAuthStore.getState();
  if (state.fixtureMode) {
    return;
  }

  if (payload.type === 'logged_out') {
    if (
      state.status !== 'anonymous' ||
      state.user !== null ||
      state.reauthRequired ||
      useViewerStore.getState().isDirty
    ) {
      void state.clearLocalSession({
        suppressReturnTo: true,
        notice: {
          variant: 'info',
          title: 'Đã đăng xuất ở tab khác',
          message:
            'Phiên làm việc đã được đăng xuất ở một tab khác. Bộ nhớ đệm và dữ liệu tạm đã được dọn sạch.',
        },
      });
    }
    return;
  }

  if (payload.type === 'session_revoked') {
    if (
      payload.reason !== 'account_disabled' &&
      payload.reason !== 'password_changed' &&
      useViewerStore.getState().isDirty &&
      (state.user || state.reauthUserId)
    ) {
      void state.handleRefreshRejected(payload.reason);
      return;
    }
    if (
      state.status !== 'anonymous' ||
      state.user !== null ||
      state.reauthRequired ||
      useViewerStore.getState().isDirty
    ) {
      void state.handleSessionTerminated({
        reason: payload.reason,
        broadcast: false,
      });
    }
    return;
  }

  if (payload.type === 'user_changed' || payload.type === 'refresh_succeeded') {
    const currentUserId = state.user?.id ?? state.reauthUserId;
    if (currentUserId && payload.userId && currentUserId !== payload.userId) {
      void state.clearLocalSession({
        suppressReturnTo: true,
        notice: {
          variant: 'warning',
          title: 'Tài khoản làm việc đã thay đổi',
          message:
            payload.type === 'user_changed'
              ? 'Một tab khác đã đăng nhập bằng tài khoản khác. Phiên hiện tại đã được làm sạch để bảo vệ dữ liệu.'
              : 'Một tab khác đã chuyển tài khoản. Phiên hiện tại đã được làm sạch.',
        },
      });
    } else if (
      state.reauthRequired &&
      state.reauthUserId &&
      state.reauthUserId === payload.userId
    ) {
      void state.refreshSession().catch(() => {
        // Nếu refresh chưa sẵn sàng, giữ ReauthModal cho bác sĩ xác thực lại
      });
    }
  }
});
