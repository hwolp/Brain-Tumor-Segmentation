import {
  ApiClientError,
  isAbortError,
  normalizeErrorCode,
  parseErrorEnvelope,
} from './errors';

export const API_BASE_URL = '/api/v1';

export interface AuthFailureEvent {
  status: number;
  code: string;
  error: ApiClientError;
}

type TokenProvider = () => string | null;
type SessionRefreshHandler = (
  failedWithToken: string | null,
) => Promise<string | null>;
type AuthFailureHandler = (event: AuthFailureEvent) => void | Promise<void>;

let getAccessTokenFn: TokenProvider = () => null;
let sessionRefreshHandler: SessionRefreshHandler | null = null;
let authFailureHandler: AuthFailureHandler | null = null;
let currentSessionEpoch = 0;

const SAFE_READ_METHODS = new Set(['GET', 'HEAD']);
const NON_REFRESHABLE_401_CODES = new Set([
  'login_failed',
  'invalid_credentials',
  'invalid_current_password',
  'refresh_reused',
  'csrf_origin_denied',
  'account_disabled',
  'account_locked',
]);

/**
 * Đăng ký hàm đọc access token từ bộ nhớ runtime (Zustand memory-only store).
 */
export function registerAccessTokenProvider(provider: TokenProvider): void {
  getAccessTokenFn = provider;
}

export function getAccessToken(): string | null {
  return getAccessTokenFn();
}

/**
 * Đăng ký hàm làm mới phiên (single-flight + multi-tab lock) khi gặp 401.
 */
export function registerSessionRefreshHandler(
  handler: SessionRefreshHandler | null,
): void {
  sessionRefreshHandler = handler;
}

/**
 * Đăng ký hàm xử lý khi tài khoản bị khóa, reuse token hoặc cần buộc đổi mật khẩu.
 */
export function registerAuthFailureHandler(
  handler: AuthFailureHandler | null,
): void {
  authFailureHandler = handler;
}

/**
 * Tăng epoch phiên khi đăng xuất hoặc đổi tài khoản để hủy bỏ response muộn từ phiên cũ.
 */
export function bumpSessionEpoch(): number {
  currentSessionEpoch += 1;
  return currentSessionEpoch;
}

export function getSessionEpoch(): number {
  return currentSessionEpoch;
}

function assertSessionEpoch(requestEpoch: number, skipAuth: boolean): void {
  if (!skipAuth && requestEpoch !== currentSessionEpoch) {
    throw new DOMException(
      'Phiên làm việc đã thay đổi trong lúc tải dữ liệu.',
      'AbortError',
    );
  }
}

export function isSafeReadMethod(method: string | undefined): boolean {
  return SAFE_READ_METHODS.has((method ?? 'GET').toUpperCase());
}

export function isNonRefreshable401Code(
  code: string | undefined | null,
): boolean {
  return NON_REFRESHABLE_401_CODES.has(normalizeErrorCode(code ?? ''));
}

/**
 * Thông báo cho auth store khi API trả về mã lỗi khóa tài khoản, reuse refresh token
 * hoặc bắt buộc đổi mật khẩu. Trả về true nếu lỗi đã thuộc nhóm xử lý phiên đặc biệt.
 */
export async function notifyAuthFailureFromError(
  apiError: ApiClientError,
): Promise<boolean> {
  const normalizedCode = normalizeErrorCode(apiError.code);

  if (
    normalizedCode === 'account_disabled' ||
    normalizedCode === 'account_locked'
  ) {
    if (authFailureHandler) {
      await authFailureHandler({
        status: apiError.status,
        code: normalizedCode,
        error: apiError,
      });
    }
    return true;
  }

  if (
    apiError.status === 403 &&
    normalizedCode === 'password_change_required'
  ) {
    if (authFailureHandler) {
      await authFailureHandler({
        status: apiError.status,
        code: normalizedCode,
        error: apiError,
      });
    }
    return true;
  }

  if (apiError.status === 401 && normalizedCode === 'refresh_reused') {
    if (authFailureHandler) {
      await authFailureHandler({
        status: 401,
        code: normalizedCode,
        error: apiError,
      });
    }
    return true;
  }

  return false;
}

/**
 * Đồng bộ / làm mới access token qua cơ chế single-flight đã đăng ký.
 * Truyền `failedWithToken` để tránh xoay trùng refresh token nếu request khác vừa làm mới xong.
 */
export async function ensureFreshAccessToken(
  failedWithToken: string | null = getAccessTokenFn(),
): Promise<string | null> {
  if (!sessionRefreshHandler) {
    return getAccessTokenFn();
  }
  return sessionRefreshHandler(failedWithToken);
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: BodyInit | Record<string, unknown> | unknown[] | null;
  skipAuth?: boolean;
  skipRefreshOn401?: boolean;
}

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const {
    body,
    headers: customHeaders,
    skipAuth = false,
    skipRefreshOn401 = false,
    ...init
  } = options;

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = normalizedPath.startsWith(API_BASE_URL)
    ? normalizedPath
    : `${API_BASE_URL}${normalizedPath}`;

  const method = (init.method ?? 'GET').toUpperCase();
  const isSafeRead = isSafeReadMethod(method);

  let serializedBody: BodyInit | undefined;
  let defaultJsonContentType = false;
  if (body !== undefined && body !== null) {
    if (
      body instanceof FormData ||
      body instanceof Blob ||
      body instanceof URLSearchParams ||
      typeof body === 'string'
    ) {
      serializedBody = body;
    } else {
      defaultJsonContentType = true;
      serializedBody = JSON.stringify(body);
    }
  }

  const executeAttempt = async (
    hasRetriedAfterRefresh: boolean,
    overrideToken?: string | null,
  ): Promise<T> => {
    const requestEpoch = currentSessionEpoch;
    const headers = new Headers(customHeaders);
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }
    if (defaultJsonContentType && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    let usedToken: string | null = null;
    if (!skipAuth) {
      usedToken =
        overrideToken !== undefined ? overrideToken : getAccessTokenFn();
      if (usedToken) {
        headers.set('Authorization', `Bearer ${usedToken}`);
      } else {
        headers.delete('Authorization');
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        method,
        headers,
        body: serializedBody,
        credentials: init.credentials ?? 'include',
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new ApiClientError({
        status: 0,
        code: 'network_error',
        isNetworkError: true,
      });
    }

    // Bảo vệ chống response muộn từ request thuộc phiên cũ khôi phục dữ liệu sau logout / đổi tài khoản
    assertSessionEpoch(requestEpoch, skipAuth);

    const headerRequestId = response.headers.get('X-Request-ID');
    const retryAfterHeader = response.headers.get('Retry-After');

    if (!response.ok) {
      let parsedBody: unknown = null;
      const contentType = response.headers.get('Content-Type') ?? '';
      if (contentType.includes('application/json')) {
        try {
          parsedBody = await response.json();
        } catch {
          parsedBody = null;
        }
      }
      assertSessionEpoch(requestEpoch, skipAuth);
      const apiError = parseErrorEnvelope(
        parsedBody,
        response.status,
        headerRequestId,
        retryAfterHeader,
      );

      if (!skipAuth) {
        const handledAuthFailure = await notifyAuthFailureFromError(apiError);
        if (handledAuthFailure) {
          throw apiError;
        }

        if (response.status === 401) {
          const normalizedCode = normalizeErrorCode(apiError.code);
          if (
            !skipRefreshOn401 &&
            !NON_REFRESHABLE_401_CODES.has(normalizedCode) &&
            !hasRetriedAfterRefresh &&
            sessionRefreshHandler
          ) {
            const nextToken = await sessionRefreshHandler(usedToken);
            if (requestEpoch !== currentSessionEpoch) {
              throw new DOMException(
                'Phiên làm việc đã thay đổi trong lúc làm mới xác thực.',
                'AbortError',
              );
            }
            // Chỉ replay tối đa 1 lần cho request đọc an toàn (GET/HEAD); tuyệt đối không tự replay mutation
            if (isSafeRead && nextToken) {
              return executeAttempt(true, nextToken);
            }
          }
        }
      }

      throw apiError;
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    assertSessionEpoch(requestEpoch, skipAuth);
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  };

  return executeAttempt(false);
}
