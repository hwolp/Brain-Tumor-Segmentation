export const AUTH_REFRESH_LOCK_NAME = 'bts-auth-refresh';
export const AUTH_BROADCAST_CHANNEL_NAME = 'bts-auth-channel';

export type SessionRevokeReason =
  | 'expired'
  | 'refresh_reused'
  | 'account_disabled'
  | 'password_changed'
  | 'revoked';

export type AuthBroadcastPayload =
  | {
      type: 'refresh_succeeded';
      userId: string;
      tabId: string;
      timestamp: number;
    }
  | {
      type: 'logged_out';
      userId: string | null;
      tabId: string;
      timestamp: number;
    }
  | {
      type: 'session_revoked';
      userId: string | null;
      reason: SessionRevokeReason;
      tabId: string;
      timestamp: number;
    }
  | {
      type: 'user_changed';
      userId: string;
      tabId: string;
      timestamp: number;
    };

export type AuthBroadcastInput =
  | { type: 'refresh_succeeded'; userId: string }
  | { type: 'logged_out'; userId: string | null }
  | { type: 'session_revoked'; userId: string | null; reason: SessionRevokeReason }
  | { type: 'user_changed'; userId: string };

type BroadcastListener = (payload: AuthBroadcastPayload) => void;

function createTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const LOCAL_TAB_ID = createTabId();

let channelInstance: BroadcastChannel | null = null;
let channelConstructorRef: typeof BroadcastChannel | undefined;
let registeredListener: BroadcastListener | null = null;

function isValidBroadcastPayload(data: unknown): data is AuthBroadcastPayload {
  if (!data || typeof data !== 'object') return false;
  const candidate = data as Record<string, unknown>;
  if (typeof candidate.type !== 'string' || typeof candidate.tabId !== 'string') {
    return false;
  }
  // Phòng vệ bổ sung: bỏ qua mọi message không hợp lệ hoặc bị gắn token lạ
  if ('access_token' in candidate || 'refresh_token' in candidate || 'token' in candidate) {
    return false;
  }
  return (
    candidate.type === 'refresh_succeeded' ||
    candidate.type === 'logged_out' ||
    candidate.type === 'session_revoked' ||
    candidate.type === 'user_changed'
  );
}

/**
 * Tuần tự hóa thao tác xoay refresh cookie giữa các tab bằng Web Locks API (nếu trình duyệt hỗ trợ).
 */
export async function runWithRefreshLock<T>(task: () => Promise<T>): Promise<T> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.locks &&
    typeof navigator.locks.request === 'function'
  ) {
    return navigator.locks.request(AUTH_REFRESH_LOCK_NAME, async () => task());
  }
  return task();
}

export function getLocalTabId(): string {
  return LOCAL_TAB_ID;
}

export function ensureAuthBroadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') {
    return null;
  }
  if (channelInstance && channelConstructorRef === BroadcastChannel) {
    return channelInstance;
  }
  closeAuthBroadcastChannel();

  const ch = new BroadcastChannel(AUTH_BROADCAST_CHANNEL_NAME);
  ch.onmessage = (event: MessageEvent) => {
    const payload = event.data;
    if (!isValidBroadcastPayload(payload)) return;
    if (payload.tabId === LOCAL_TAB_ID) return;
    registeredListener?.(payload);
  };
  channelInstance = ch;
  channelConstructorRef = BroadcastChannel;
  return ch;
}

export function registerAuthBroadcastListener(
  listener: BroadcastListener | null,
): void {
  registeredListener = listener;
  if (listener) {
    ensureAuthBroadcastChannel();
  }
}

export function closeAuthBroadcastChannel(): void {
  if (channelInstance) {
    try {
      channelInstance.close();
    } catch {
      // Bỏ qua lỗi đóng channel
    }
    channelInstance = null;
    channelConstructorRef = undefined;
  }
}

/**
 * Phát tín hiệu điều phối trạng thái phiên sang các tab khác.
 * Tuyệt đối chỉ truyền metadata (type, userId, reason), không bao giờ gửi access/refresh token.
 */
export function broadcastAuthEvent(input: AuthBroadcastInput): void {
  const ch = ensureAuthBroadcastChannel();
  if (!ch) return;

  let payload: AuthBroadcastPayload;
  const base = { tabId: LOCAL_TAB_ID, timestamp: Date.now() };

  switch (input.type) {
    case 'refresh_succeeded':
      payload = {
        ...base,
        type: 'refresh_succeeded',
        userId: input.userId,
      };
      break;
    case 'logged_out':
      payload = {
        ...base,
        type: 'logged_out',
        userId: input.userId,
      };
      break;
    case 'session_revoked':
      payload = {
        ...base,
        type: 'session_revoked',
        userId: input.userId,
        reason: input.reason,
      };
      break;
    case 'user_changed':
      payload = {
        ...base,
        type: 'user_changed',
        userId: input.userId,
      };
      break;
  }

  try {
    ch.postMessage(payload);
  } catch {
    // Bỏ qua nếu kênh đã đóng
  }
}
