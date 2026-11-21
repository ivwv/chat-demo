/**
 * 多端同步配置持久化：存入 localStorage，页面刷新后恢复并按 autoConnect 自动连接。
 */

export type SyncConfig = {
  /** 用户输入的 Worker 域名或地址，如 cf-wss-sync.ivwv.workers.dev */
  workerUrl: string;
  /** 房间同步密码：仅在本地经 PBKDF2 派生房间令牌与 E2EE 密钥，绝不上传服务端 */
  password: string;
  /** 当前浏览器在房间里的显示名称 */
  deviceName: string;
  /** 点击连接后自动置为 true，下次页面打开自动连接；手动断开后置为 false */
  autoConnect: boolean;
  /** 收到新会话时是否自动后台拉取小附件原件，大附件始终按需拉取 */
  autoSyncSmallFiles: boolean;
  /** 小附件自动拉取的体积上限（KB） */
  smallFileLimitKB: number;
  /** 是否同步自定义提示词 */
  syncCustomPrompts: boolean;
  /** 是否同步服务商配置（含 API Key，默认关闭） */
  syncProviders: boolean;
};

export type NormalizedSyncWorkerUrl = {
  host: string;
  httpBase: string;
  wsBase: string;
  sdkUrl: string;
  healthUrl: string;
};

const SYNC_CONFIG_KEY = "chat-demo:sync-config";
const ALLOWED_LIMIT_KB = [256, 512, 2048, 5120] as const;

export const detectDefaultDeviceName = (): string => {
  if (typeof navigator === "undefined") {
    return "Browser";
  }
  const ua = navigator.userAgent || "";
  const os = /Windows/i.test(ua)
    ? "Windows"
    : /Mac OS X/i.test(ua)
      ? "macOS"
      : /Android/i.test(ua)
        ? "Android"
        : /iPhone|iPad/i.test(ua)
          ? "iOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "Device";
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /Chrome\//i.test(ua)
      ? "Chrome"
      : /Firefox\//i.test(ua)
        ? "Firefox"
        : /Safari\//i.test(ua)
          ? "Safari"
          : "Web";
  return `${browser} on ${os}`;
};

/**
 * 规范化用户输入的 Worker 域名并拼接 SDK 与健康检查地址。
 * 仅允许 http(s)/ws(s) 协议，拦截非法或危险协议；无协议时本地地址补 http://，其余补 https://。
 */
export const normalizeSyncWorkerUrl = (input: string): NormalizedSyncWorkerUrl | null => {
  let raw = input.trim();
  if (!raw) {
    return null;
  }
  if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw)) {
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(raw);
    raw = `${isLocal ? "http://" : "https://"}${raw}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" &&
    parsed.protocol !== "http:" &&
    parsed.protocol !== "wss:" &&
    parsed.protocol !== "ws:"
  ) {
    return null;
  }
  if (!parsed.host) {
    return null;
  }
  const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const host = parsed.host.toLowerCase();
  const httpBase = `${secure ? "https:" : "http:"}//${host}`;
  const wsBase = `${secure ? "wss:" : "ws:"}//${host}`;
  return {
    host,
    httpBase,
    wsBase,
    sdkUrl: `${httpBase}/sdk/cf-wss-sync.min.js`,
    healthUrl: `${httpBase}/health`,
  };
};

export const defaultSyncConfig = (): SyncConfig => ({
  workerUrl: "",
  password: "",
  deviceName: detectDefaultDeviceName(),
  autoConnect: false,
  autoSyncSmallFiles: true,
  smallFileLimitKB: 512,
  syncCustomPrompts: true,
  syncProviders: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const loadSyncConfig = (): SyncConfig => {
  const defaults = defaultSyncConfig();
  try {
    const raw = localStorage.getItem(SYNC_CONFIG_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return defaults;
    }
    const limit =
      typeof parsed.smallFileLimitKB === "number" &&
      ALLOWED_LIMIT_KB.includes(parsed.smallFileLimitKB as (typeof ALLOWED_LIMIT_KB)[number])
        ? parsed.smallFileLimitKB
        : defaults.smallFileLimitKB;
    return {
      workerUrl: typeof parsed.workerUrl === "string" ? parsed.workerUrl : "",
      password: typeof parsed.password === "string" ? parsed.password : "",
      deviceName:
        typeof parsed.deviceName === "string" && parsed.deviceName.trim()
          ? parsed.deviceName
          : defaults.deviceName,
      autoConnect: parsed.autoConnect === true,
      autoSyncSmallFiles: parsed.autoSyncSmallFiles !== false,
      smallFileLimitKB: limit,
      syncCustomPrompts: parsed.syncCustomPrompts !== false,
      syncProviders: parsed.syncProviders === true,
    };
  } catch {
    return defaults;
  }
};

export const saveSyncConfig = (config: SyncConfig): void => {
  try {
    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // 存储不可用时仅在本次会话内存中生效
  }
};

/** 生成 16 位高熵随机房间密码 */
export const generateSyncPassword = (): string => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
};
