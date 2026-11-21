import { normalizeSyncWorkerUrl, type NormalizedSyncWorkerUrl } from "./config.js";
import type { CfWssSyncGlobal, WorkerHealthInfo } from "./sdkTypes.js";

const SDK_SCRIPT_ATTR = "data-cf-wss-sync-sdk";
const SDK_LOAD_TIMEOUT_MS = 12_000;

export type SdkLoadErrorCode =
  | "invalidUrl"
  | "insecureContext"
  | "loadFailed"
  | "timeout"
  | "invalidSdk"
  | "healthFailed";

export class SdkLoadError extends Error {
  constructor(
    readonly code: SdkLoadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SdkLoadError";
  }
}

let loadedSdkUrl: string | null = null;
let pendingLoad: { url: string; promise: Promise<CfWssSyncGlobal> } | null = null;

export const isWebCryptoAvailable = (): boolean =>
  typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.subtle !== "undefined";

const isValidSdk = (sdk: unknown): sdk is CfWssSyncGlobal =>
  typeof sdk === "object" &&
  sdk !== null &&
  typeof (sdk as CfWssSyncGlobal).SyncClient === "function";

const removeInjectedScripts = () => {
  const nodes = document.querySelectorAll(`script[${SDK_SCRIPT_ATTR}]`);
  nodes.forEach((node) => node.remove());
};

const injectSdkScript = (sdkUrl: string): Promise<CfWssSyncGlobal> =>
  new Promise((resolve, reject) => {
    removeInjectedScripts();
    const script = document.createElement("script");
    script.src = sdkUrl;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.setAttribute(SDK_SCRIPT_ATTR, sdkUrl);

    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      script.remove();
      reject(new SdkLoadError("timeout", `Timed out loading SDK from ${sdkUrl}`));
    }, SDK_LOAD_TIMEOUT_MS);

    const cleanup = () => {
      window.clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
    };

    script.onload = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (isValidSdk(window.CfWssSync)) {
        loadedSdkUrl = sdkUrl;
        resolve(window.CfWssSync);
      } else {
        script.remove();
        reject(
          new SdkLoadError("invalidSdk", `SDK loaded from ${sdkUrl} did not expose CfWssSync`),
        );
      }
    };

    script.onerror = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      script.remove();
      reject(new SdkLoadError("loadFailed", `Failed to load SDK from ${sdkUrl}`));
    };

    document.head.appendChild(script);
  });

/**
 * 动态加载 `${httpBase}/sdk/cf-wss-sync.min.js`。
 * 同一域名复用已加载实例；用户更换 Worker 域名时移除旧脚本并重新加载新域名产物。
 */
export const loadCfWssSyncSdk = async (
  workerUrl: string,
): Promise<{ sdk: CfWssSyncGlobal; normalized: NormalizedSyncWorkerUrl }> => {
  const normalized = normalizeSyncWorkerUrl(workerUrl);
  if (!normalized) {
    throw new SdkLoadError("invalidUrl", "Invalid Worker URL");
  }
  if (!isWebCryptoAvailable()) {
    throw new SdkLoadError("insecureContext", "WebCrypto requires HTTPS or localhost");
  }
  if (loadedSdkUrl === normalized.sdkUrl && isValidSdk(window.CfWssSync)) {
    return { sdk: window.CfWssSync, normalized };
  }
  if (pendingLoad && pendingLoad.url === normalized.sdkUrl) {
    const sdk = await pendingLoad.promise;
    return { sdk, normalized };
  }
  const promise = injectSdkScript(normalized.sdkUrl);
  pendingLoad = { url: normalized.sdkUrl, promise };
  try {
    const sdk = await promise;
    return { sdk, normalized };
  } finally {
    if (pendingLoad?.promise === promise) {
      pendingLoad = null;
    }
  }
};

/** 探测 Worker `/health` 接口，校验服务是否在线且为 cf-wss-sync 服务 */
export const probeSyncWorkerHealth = async (workerUrl: string): Promise<WorkerHealthInfo> => {
  const normalized = normalizeSyncWorkerUrl(workerUrl);
  if (!normalized) {
    throw new SdkLoadError("invalidUrl", "Invalid Worker URL");
  }
  let response: Response;
  try {
    response = await fetch(normalized.healthUrl, { method: "GET", cache: "no-store" });
  } catch (error) {
    throw new SdkLoadError(
      "healthFailed",
      error instanceof Error ? error.message : "Network error",
    );
  }
  if (!response.ok) {
    throw new SdkLoadError("healthFailed", `HTTP ${response.status}`);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new SdkLoadError("healthFailed", "Invalid JSON response from /health");
  }
  if (
    typeof data !== "object" ||
    data === null ||
    (data as WorkerHealthInfo).ok !== true ||
    typeof (data as WorkerHealthInfo).service !== "string"
  ) {
    throw new SdkLoadError("healthFailed", "Unexpected /health payload");
  }
  return data as WorkerHealthInfo;
};
