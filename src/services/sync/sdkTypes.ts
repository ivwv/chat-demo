/**
 * 外部动态加载的 cf-wss-sync 浏览器 IIFE SDK（window.CfWssSync）类型声明。
 * 与 cf-sync-relay 仓库 sdk/src/index.js 的公共 API 保持一致。
 */

export type SyncPeerRole = "sender" | "receiver" | "duplex";

export type SyncPeerInfo = {
  peerId: string;
  shortId: number;
  role: SyncPeerRole;
  name: string;
  joinedAt: number;
};

export type WorkerHealthInfo = {
  ok: boolean;
  service: string;
  version: string;
  protocolVersion?: number;
  storage?: string;
  maxFrameBytes?: number;
  maxPeersPerRoom?: number;
};

export type SyncQuotaStats = {
  sentFrames: number;
  receivedFrames: number;
  sentBytes: number;
  receivedBytes: number;
  estimatedDoRequests: number;
};

export type SyncClientOptions = {
  workerUrl: string;
  password: string;
  role?: SyncPeerRole;
  deviceName?: string;
  deviceId?: string;
  sessionKey?: string;
  storageMode?: "opfs-first" | "memory-only";
  chunkSize?: number;
  windowSize?: number;
  ackBatchSize?: number;
  bundleSmallFiles?: boolean;
  autoAcceptFiles?: boolean;
  autoReconnect?: boolean;
  heartbeatIntervalMs?: number;
};

export type SyncDataEvent = {
  fromPeerId: string;
  fromShortId: number;
  fromName: string;
  channel: string;
  data: unknown;
  dataType: "json" | "text" | "binary";
  timestamp: number;
};

export type SyncReceiveTaskHandle = {
  transferId: string;
  fileId: string;
  readonly status: "running" | "paused" | "completed" | "cancelled";
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  cancel: () => Promise<void>;
};

export type SyncFileOffer = {
  transferId: string;
  fileId: string;
  fromPeerId: string;
  fromShortId: number;
  fromName: string;
  name: string;
  relativePath: string;
  mimeType: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  meta: Record<string, unknown>;
  canResume: boolean;
  resumedBytes: number;
  accept: (options?: {
    fileHandle?: FileSystemFileHandle | null;
  }) => Promise<SyncReceiveTaskHandle>;
  reject: (reason?: string) => Promise<void>;
};

export type SyncTransferProgress = {
  transferId: string;
  fileId: string | null;
  direction: "send" | "receive";
  fileName: string;
  relativePath?: string;
  peerId?: string;
  transferredBytes: number;
  totalBytes: number;
  percent: number;
  speedBps: number;
  etaSeconds: number;
};

export type SyncReceivedFile = {
  transferId: string;
  fileId: string;
  fromPeerId: string;
  fromName: string;
  name: string;
  relativePath: string;
  mimeType: string;
  size: number;
  meta: Record<string, unknown>;
  storageType: "opfs" | "memory" | "file-handle";
  skipped: boolean;
  verified: boolean;
  contentHash: string | null;
  getFile: () => Promise<File>;
  saveToDisk: () => Promise<void>;
  cleanup: () => Promise<void>;
};

export type SyncSendTask = {
  transferIds: string[];
  readonly status: "running" | "paused" | "completed" | "cancelled";
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  cancel: () => Promise<void>;
  wait: () => Promise<void>;
};

export type SyncClientEventMap = {
  connected: { self: SyncPeerInfo; peers: SyncPeerInfo[]; maxFrameBytes: number };
  disconnected: { code: number; reason: string; willReconnect: boolean };
  reconnecting: { attempt: number; delayMs: number };
  "peers-change": SyncPeerInfo[];
  data: SyncDataEvent;
  "file-offer": SyncFileOffer;
  progress: SyncTransferProgress;
  "file-received": SyncReceivedFile;
  "transfer-cancelled": { transferId: string; direction: "send" | "receive"; reason: string };
  "quota-stats": SyncQuotaStats;
  error: Error & { code?: string };
};

export interface SyncClientInstance {
  readonly connected: boolean;
  readonly self: SyncPeerInfo | null;
  readonly peers: SyncPeerInfo[];
  on<K extends keyof SyncClientEventMap>(
    event: K,
    listener: (payload: SyncClientEventMap[K]) => void,
  ): () => void;
  off<K extends keyof SyncClientEventMap>(
    event: K,
    listener: (payload: SyncClientEventMap[K]) => void,
  ): void;
  connect(): Promise<{ self: SyncPeerInfo; peers: SyncPeerInfo[]; maxFrameBytes: number }>;
  disconnect(): Promise<void>;
  sendData(data: unknown, options?: { channel?: string; targets?: string[] | "*" }): Promise<void>;
  sendFiles(
    files: File[],
    options?: {
      targets?: string[] | "*";
      meta?: Record<string, unknown>;
      chunkSize?: number;
      bundleSmallFiles?: boolean;
    },
  ): Promise<SyncSendTask>;
  getQuotaStats(): SyncQuotaStats;
}

export interface CfWssSyncGlobal {
  SyncClient: new (options: SyncClientOptions) => SyncClientInstance;
  checkWorkerHealth: (workerUrl: string) => Promise<WorkerHealthInfo>;
}

declare global {
  interface Window {
    CfWssSync?: CfWssSyncGlobal;
  }
}
