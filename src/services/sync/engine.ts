import { create } from "zustand";
import { createId } from "../../utils/id.js";
import * as db from "../chat/db.js";
import { getVisibleMessages, normalizeSession } from "../chat/branches.js";
import {
  applySyncedDeletion,
  applySyncedSession,
  getCachedSession,
  getStreamingReplyId,
  onLocalChatMutation,
  useChatStore,
  type LocalChatMutation,
} from "../chat/store.js";
import type { Message, Session } from "../chat/types.js";
import {
  mergeSyncedCustomPrompts,
  onLocalPromptsMutation,
  readCustomPrompts,
  type CustomPrompt,
} from "../prompts.js";
import {
  mergeSyncedProviders,
  onLocalProvidersMutation,
  useProviders,
} from "../providers/store.js";
import type { ProviderConfig } from "../providers/types.js";
import { loadSyncConfig, saveSyncConfig, type SyncConfig } from "./config.js";
import {
  buildMessageFingerprints,
  buildSessionManifestEntry,
  collectSessionFiles,
  defaultSessionSyncMeta,
  diffSessionMessagesForRemote,
  extractSessionHeader,
  isSyncableMessage,
  mergeSessionPatch,
  resolveTombstone,
  sanitizeMessageForSync,
  type SessionSyncMeta,
  type SyncSessionHeader,
  type SyncSessionManifestEntry,
} from "./merge.js";
import { loadCfWssSyncSdk, SdkLoadError } from "./sdkLoader.js";
import type {
  SyncClientInstance,
  SyncFileOffer,
  SyncPeerInfo,
  SyncQuotaStats,
  SyncReceivedFile,
  SyncTransferProgress,
} from "./sdkTypes.js";

const SYNC_CHANNEL = "chat-sync";
const BLOB_CHANNEL = "chat-blob";
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PULL_COALESCE_MS = 160;
const FULL_REQ_BATCH_SIZE = 6;
const BLOB_LOOKUP_TIMEOUT_MS = 4000;
const BLOB_AGGREGATE_MS = 160;
const MAX_AUTO_BLOB_CONCURRENT = 3;
const MAX_LOGS = 60;

export type SyncConnectionStatus =
  | "disconnected"
  | "loading-sdk"
  | "connecting"
  | "connected"
  | "reconnecting";

export type SyncLogEntry = {
  id: number;
  time: number;
  text: string;
  tone: "info" | "ok" | "warn" | "err";
};

export type SyncBranchNotice = {
  id: number;
  sessionId: string;
  fromName: string;
};

export type SyncStoreState = {
  config: SyncConfig;
  status: SyncConnectionStatus;
  reconnectingAttempt: number;
  reconnectingDelayMs: number;
  self: SyncPeerInfo | null;
  peers: SyncPeerInfo[];
  syncing: boolean;
  lastSyncedAt: number | null;
  lastError: { code?: string; message: string } | null;
  /** 正在拉取的附件进度：fileId -> 0..100 */
  downloadingFiles: Record<string, number>;
  /** 已通过同步写入 IndexedDB 的附件版本号，供 MessageFile 订阅自动刷新 */
  fileVersions: Record<string, number>;
  /** 已同步的会话计数 */
  sessionCount: number;
  /** 当前浏览会话合入新分支时的轻提示信号 */
  branchNotice: SyncBranchNotice | null;
  logs: SyncLogEntry[];
  quota: SyncQuotaStats | null;
};

type PrefsSyncMeta = {
  customPromptsUpdatedAt: number;
  providersUpdatedAt: number;
};

type SyncManifestMessage = {
  type: "SYNC_MANIFEST";
  replicaId: string;
  sessions: Record<string, SyncSessionManifestEntry>;
  tombstones: Record<string, number>;
  customPromptsUpdatedAt?: number;
  providersUpdatedAt?: number;
  replyNeeded?: boolean;
};

type SyncSessionFullReq = {
  type: "SYNC_SESSION_FULL_REQ";
  sessionIds: string[];
};

type SyncSessionFullRes = {
  type: "SYNC_SESSION_FULL_RES";
  header: SyncSessionHeader;
  messages: Message[];
};

type SyncSessionDiffReq = {
  type: "SYNC_SESSION_DIFF_REQ";
  sessionId: string;
  fingerprints: Record<string, string>;
};

type SyncSessionDiffRes = {
  type: "SYNC_SESSION_DIFF_RES";
  header: SyncSessionHeader;
  messages: Message[];
};

type SyncLivePatch = {
  type: "SYNC_LIVE_PATCH";
  header: SyncSessionHeader;
  messages: Message[];
};

type SyncDeleteMessage = {
  type: "SYNC_DELETE";
  sessionId: string;
  deletedAt: number;
};

type SyncPrefsReq = {
  type: "SYNC_PREFS_REQ";
  wantPrompts: boolean;
  wantProviders: boolean;
};

type SyncPrefsRes = {
  type: "SYNC_PREFS_RES";
  customPrompts?: { updatedAt: number; items: CustomPrompt[] };
  providers?: { updatedAt: number; items: ProviderConfig[] };
};

type SyncProtocolMessage =
  | SyncManifestMessage
  | SyncSessionFullReq
  | SyncSessionFullRes
  | SyncSessionDiffReq
  | SyncSessionDiffRes
  | SyncLivePatch
  | SyncDeleteMessage
  | SyncPrefsReq
  | SyncPrefsRes;

type BlobProtocolMessage =
  | { type: "BLOB_WHO_HAS"; fileId: string }
  | { type: "BLOB_HAVE"; fileId: string; size: number }
  | { type: "BLOB_REQUEST"; fileId: string };

export const useSyncStore = create<SyncStoreState>(() => ({
  config: loadSyncConfig(),
  status: "disconnected",
  reconnectingAttempt: 0,
  reconnectingDelayMs: 0,
  self: null,
  peers: [],
  syncing: false,
  lastSyncedAt: null,
  lastError: null,
  downloadingFiles: {},
  fileVersions: {},
  sessionCount: 0,
  branchNotice: null,
  logs: [],
  quota: null,
}));

const { getState: getSync, setState: setSync } = useSyncStore;

// 运行时内部状态（放在模块闭包中，避免将复杂句柄塞进 React 状态）
let client: SyncClientInstance | null = null;
let initializedMeta = false;
let initMetaPromise: Promise<void> | null = null;
let bindingsInstalled = false;
let replicaId = "";
let tombstones: Record<string, number> = {};
let sessionMetaMap: Record<string, SessionSyncMeta> = {};
let prefsMeta: PrefsSyncMeta = { customPromptsUpdatedAt: 0, providersUpdatedAt: 0 };
const manifestCache = new Map<string, SyncSessionManifestEntry>();
const localFileIds = new Set<string>();
const sessionLocks = new Map<string, Promise<void>>();

// 多端上线时的请求合并缓冲（防 3+ 台设备广播风暴）
const pendingFullPulls = new Map<string, { peerId: string; updatedAt: number }>();
const pendingDiffPulls = new Map<string, { peerId: string; updatedAt: number }>();
let pullCoalesceTimer = 0;
let syncingActivityCount = 0;

// 附件按需拉取状态
const transferToFileId = new Map<string, string>();
const pendingBlobLookups = new Map<
  string,
  { timer: number; resolved: boolean; name: string; silent: boolean }
>();
const outgoingBlobQueue = new Map<string, { targets: Set<string>; timer: number }>();
const autoBlobQueue: Array<{ id: string; name: string }> = [];
let autoBlobInFlight = 0;
let logSeed = 1;
let branchNoticeSeed = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const addLog = (text: string, tone: SyncLogEntry["tone"] = "info") => {
  setSync((state) => ({
    logs: [{ id: logSeed++, time: Date.now(), text, tone }, ...state.logs].slice(0, MAX_LOGS),
  }));
};

const beginSyncActivity = () => {
  syncingActivityCount += 1;
  if (syncingActivityCount === 1) {
    setSync({ syncing: true });
  }
};

const endSyncActivity = (markSynced = false) => {
  syncingActivityCount = Math.max(0, syncingActivityCount - 1);
  setSync((state) => ({
    syncing: syncingActivityCount > 0,
    lastSyncedAt: markSynced ? Date.now() : state.lastSyncedAt,
  }));
};

/** 对同一 sessionId 串行化读-改-写，防止多端同时发来增量时发生竞态覆盖 */
const withSessionLock = <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const settled = run.then(
    () => {},
    () => {},
  );
  sessionLocks.set(sessionId, settled);
  void settled.finally(() => {
    if (sessionLocks.get(sessionId) === settled) {
      sessionLocks.delete(sessionId);
    }
  });
  return run;
};

const pruneExpiredTombstones = (): boolean => {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  let pruned = false;
  const next: Record<string, number> = {};
  for (const [id, deletedAt] of Object.entries(tombstones)) {
    if (deletedAt >= cutoff) {
      next[id] = deletedAt;
    } else {
      pruned = true;
    }
  }
  if (pruned) {
    tombstones = next;
  }
  return pruned;
};

const persistSyncMeta = async () => {
  await db.saveSyncMeta({
    replicaId,
    tombstones,
    sessionMeta: sessionMetaMap,
    prefsMeta,
  });
};

const loadSessionFresh = async (sessionId: string): Promise<Session | null> => {
  const cached = getCachedSession(sessionId);
  if (cached) {
    return cached;
  }
  return (await db.loadSession(sessionId)) ?? null;
};

const rebuildManifestCache = async () => {
  const sessions = await db.loadAllSessions();
  manifestCache.clear();
  for (const session of sessions) {
    const meta = sessionMetaMap[session.id] ?? defaultSessionSyncMeta(session);
    if (!sessionMetaMap[session.id]) {
      sessionMetaMap = { ...sessionMetaMap, [session.id]: meta };
    }
    manifestCache.set(session.id, buildSessionManifestEntry(session, meta));
  }
  const fileKeys = await db.loadFileKeys();
  localFileIds.clear();
  for (const key of fileKeys) {
    localFileIds.add(key);
  }
  setSync({ sessionCount: manifestCache.size });
};

const ensureSyncMetaLoaded = async () => {
  if (initializedMeta) {
    return;
  }
  if (initMetaPromise) {
    return initMetaPromise;
  }
  initMetaPromise = (async () => {
    const [storedReplica, storedTombstones, storedSessionMeta, storedPrefsMeta] = await Promise.all(
      [
        db.loadSyncMeta<string>("replicaId"),
        db.loadSyncMeta<Record<string, number>>("tombstones"),
        db.loadSyncMeta<Record<string, SessionSyncMeta>>("sessionMeta"),
        db.loadSyncMeta<PrefsSyncMeta>("prefsMeta"),
      ],
    );

    let dirty = false;
    if (typeof storedReplica === "string" && storedReplica.length > 0) {
      replicaId = storedReplica;
    } else {
      replicaId = `chat_${createId().replace(/-/g, "").slice(0, 12)}`;
      dirty = true;
    }

    tombstones = isRecord(storedTombstones) ? { ...storedTombstones } : {};
    if (pruneExpiredTombstones()) {
      dirty = true;
    }

    sessionMetaMap = isRecord(storedSessionMeta) ? { ...storedSessionMeta } : {};
    prefsMeta =
      isRecord(storedPrefsMeta) &&
      typeof storedPrefsMeta.customPromptsUpdatedAt === "number" &&
      typeof storedPrefsMeta.providersUpdatedAt === "number"
        ? {
            customPromptsUpdatedAt: storedPrefsMeta.customPromptsUpdatedAt,
            providersUpdatedAt: storedPrefsMeta.providersUpdatedAt,
          }
        : { customPromptsUpdatedAt: 0, providersUpdatedAt: 0 };

    await rebuildManifestCache();
    if (dirty) {
      await persistSyncMeta();
    }
    initializedMeta = true;
  })();

  try {
    await initMetaPromise;
  } finally {
    initMetaPromise = null;
  }
};

const sendSyncMessage = async (
  payload: SyncProtocolMessage,
  targets: string[] | "*" = "*",
): Promise<void> => {
  if (!client || !client.connected) {
    return;
  }
  if (targets === "*" && client.peers.length === 0) {
    return;
  }
  try {
    await client.sendData(payload, { channel: SYNC_CHANNEL, targets });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes("暂无可接收")) {
      addLog(`同步发送失败: ${msg}`, "warn");
    }
  }
};

const sendBlobMessage = async (
  payload: BlobProtocolMessage,
  targets: string[] | "*" = "*",
): Promise<void> => {
  if (!client || !client.connected) {
    return;
  }
  if (targets === "*" && client.peers.length === 0) {
    return;
  }
  try {
    await client.sendData(payload, { channel: BLOB_CHANNEL, targets });
  } catch {
    // 忽略对端瞬间下线的错误
  }
};

const sendManifest = async (targets: string[] | "*", replyNeeded: boolean) => {
  await ensureSyncMetaLoaded();
  const { config } = getSync();
  const sessionsObj: Record<string, SyncSessionManifestEntry> = {};
  for (const [id, entry] of manifestCache.entries()) {
    sessionsObj[id] = entry;
  }
  const msg: SyncManifestMessage = {
    type: "SYNC_MANIFEST",
    replicaId,
    sessions: sessionsObj,
    tombstones: { ...tombstones },
    ...(config.syncCustomPrompts
      ? { customPromptsUpdatedAt: prefsMeta.customPromptsUpdatedAt }
      : {}),
    ...(config.syncProviders ? { providersUpdatedAt: prefsMeta.providersUpdatedAt } : {}),
    replyNeeded,
  };
  await sendSyncMessage(msg, targets);
};

const flushCoalescedPulls = async () => {
  pullCoalesceTimer = 0;
  if (!client || !client.connected) {
    pendingFullPulls.clear();
    pendingDiffPulls.clear();
    return;
  }

  // 按目标 peer 分组，避免对同一会话向多台设备重复拉取
  const fullByPeer = new Map<string, string[]>();
  for (const [sessionId, info] of pendingFullPulls.entries()) {
    const list = fullByPeer.get(info.peerId) ?? [];
    list.push(sessionId);
    fullByPeer.set(info.peerId, list);
  }
  pendingFullPulls.clear();

  const diffEntries = Array.from(pendingDiffPulls.entries());
  pendingDiffPulls.clear();

  if (fullByPeer.size === 0 && diffEntries.length === 0) {
    return;
  }

  beginSyncActivity();
  try {
    for (const [peerId, sessionIds] of fullByPeer.entries()) {
      for (let i = 0; i < sessionIds.length; i += FULL_REQ_BATCH_SIZE) {
        const batch = sessionIds.slice(i, i + FULL_REQ_BATCH_SIZE);
        await sendSyncMessage({ type: "SYNC_SESSION_FULL_REQ", sessionIds: batch }, [peerId]);
      }
    }

    for (const [sessionId, info] of diffEntries) {
      const local = await loadSessionFresh(sessionId);
      if (!local) {
        await sendSyncMessage({ type: "SYNC_SESSION_FULL_REQ", sessionIds: [sessionId] }, [
          info.peerId,
        ]);
        continue;
      }
      await sendSyncMessage(
        {
          type: "SYNC_SESSION_DIFF_REQ",
          sessionId,
          fingerprints: buildMessageFingerprints(local),
        },
        [info.peerId],
      );
    }
  } finally {
    window.setTimeout(() => endSyncActivity(true), 250);
  }
};

const schedulePullFlush = () => {
  if (pullCoalesceTimer) {
    return;
  }
  pullCoalesceTimer = window.setTimeout(() => {
    void flushCoalescedPulls();
  }, PULL_COALESCE_MS);
};

const applyRemoteTombstone = async (
  sessionId: string,
  deletedAt: number,
  fromName: string,
): Promise<void> => {
  await withSessionLock(sessionId, async () => {
    if (useChatStore.getState().importingHistory) {
      return;
    }
    const existingTombstone = tombstones[sessionId] ?? 0;
    const local = await loadSessionFresh(sessionId);
    if (!local) {
      if (deletedAt > existingTombstone) {
        tombstones = { ...tombstones, [sessionId]: deletedAt };
        await persistSyncMeta();
      }
      return;
    }
    const decision = resolveTombstone(local, deletedAt);
    if (decision === "delete") {
      await applySyncedDeletion(sessionId);
      manifestCache.delete(sessionId);
      const nextMeta = Object.fromEntries(
        Object.entries(sessionMetaMap).filter(([key]) => key !== sessionId),
      );
      sessionMetaMap = nextMeta;
      tombstones = { ...tombstones, [sessionId]: Math.max(existingTombstone, deletedAt) };
      await persistSyncMeta();
      setSync({ sessionCount: manifestCache.size });
      addLog(`已同步删除来自 ${fromName} 的会话`, "info");
    } else if (tombstones[sessionId] !== undefined) {
      // Add-Wins：本机在删除之后又产生了新消息，清除墓碑保护会话
      tombstones = Object.fromEntries(
        Object.entries(tombstones).filter(([key]) => key !== sessionId),
      );
      await persistSyncMeta();
    }
  });
};

const pumpAutoBlobQueue = () => {
  if (!client || !client.connected || client.peers.length === 0) {
    return;
  }
  while (autoBlobInFlight < MAX_AUTO_BLOB_CONCURRENT && autoBlobQueue.length > 0) {
    const next = autoBlobQueue.shift();
    if (!next) {
      break;
    }
    if (
      localFileIds.has(next.id) ||
      pendingBlobLookups.has(next.id) ||
      Object.hasOwn(getSync().downloadingFiles, next.id)
    ) {
      continue;
    }
    autoBlobInFlight += 1;
    requestFileInternal(next.id, next.name, true);
  }
};

const scheduleAutoSmallFilesForSession = (session: Session) => {
  const { config } = getSync();
  if (!config.autoSyncSmallFiles || !client || !client.connected || client.peers.length === 0) {
    return;
  }
  const limitBytes = config.smallFileLimitKB * 1024;
  const files = collectSessionFiles(session);
  for (const file of files.values()) {
    if (localFileIds.has(file.id)) {
      continue;
    }
    if (file.size <= limitBytes) {
      autoBlobQueue.push({ id: file.id, name: file.name });
    }
  }
  pumpAutoBlobQueue();
};

const applyIncomingPatch = async (
  header: SyncSessionHeader,
  messages: Message[],
  fromPeerId: string,
  fromName: string,
): Promise<void> => {
  if (!header || typeof header.id !== "string" || !header.id) {
    return;
  }
  await withSessionLock(header.id, async () => {
    if (useChatStore.getState().importingHistory) {
      return;
    }
    const local = await loadSessionFresh(header.id);
    const localTombstone = tombstones[header.id];

    // 如果本机存在更晚的删除墓碑且远端没有任何更新消息，忽略该远端会话
    if (!local && localTombstone !== undefined) {
      let maxRemoteTime = header.createdAt;
      for (const message of messages) {
        const t =
          message.role === "assistant"
            ? (message.finishedAt ?? message.createdAt)
            : message.createdAt;
        if (t > maxRemoteTime) {
          maxRemoteTime = t;
        }
      }
      if (localTombstone >= maxRemoteTime) {
        return;
      }
      // 远端有更新的对话（Add-Wins），移除本机墓碑
      tombstones = Object.fromEntries(
        Object.entries(tombstones).filter(([key]) => key !== header.id),
      );
    }

    const activeId = useChatStore.getState().activeId;
    const streamingReplyId = getStreamingReplyId(header.id);
    const result = mergeSessionPatch(
      local,
      sessionMetaMap[header.id] ?? null,
      { header, messages },
      {
        preserveLocalFocus: activeId === header.id,
        streamingReplyId,
      },
    );

    // 若收到增量时存在缺失父节点的孤儿消息，自动回退拉取完整会话自愈
    if (result.hasOrphans) {
      await sendSyncMessage({ type: "SYNC_SESSION_FULL_REQ", sessionIds: [header.id] }, [
        fromPeerId,
      ]);
    }

    if (!result.changed && local !== null) {
      return;
    }

    sessionMetaMap = { ...sessionMetaMap, [header.id]: result.meta };
    manifestCache.set(header.id, buildSessionManifestEntry(result.session, result.meta));
    await applySyncedSession(result.session);
    await persistSyncMeta();

    const updatedState: Partial<SyncStoreState> = {
      sessionCount: manifestCache.size,
      lastSyncedAt: Date.now(),
    };
    if (result.addedNewBranch && activeId === header.id) {
      updatedState.branchNotice = {
        id: branchNoticeSeed++,
        sessionId: header.id,
        fromName,
      };
    }
    setSync(updatedState);

    if (!local) {
      addLog(`已从 ${fromName} 同步新会话「${result.session.title || "新对话"}」`, "ok");
    } else if (result.addedNewBranch) {
      addLog(
        `会话「${result.session.title || "新对话"}」已无损合并来自 ${fromName} 的并发分支`,
        "ok",
      );
    } else if (result.addedMessageIds.length > 0) {
      addLog(
        `已从 ${fromName} 增量更新「${result.session.title || "新对话"}」(+${result.addedMessageIds.length} 条消息)`,
        "ok",
      );
    }

    scheduleAutoSmallFilesForSession(result.session);
  });
};

const handleSyncMessage = async (
  fromPeerId: string,
  fromName: string,
  raw: unknown,
): Promise<void> => {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return;
  }
  if (useChatStore.getState().importingHistory) {
    return;
  }
  await ensureSyncMetaLoaded();
  const msg = raw as SyncProtocolMessage;

  switch (msg.type) {
    case "SYNC_MANIFEST": {
      // 1. 先处理对端墓碑
      if (isRecord(msg.tombstones)) {
        for (const [sessionId, deletedAt] of Object.entries(msg.tombstones)) {
          if (typeof deletedAt === "number" && Number.isFinite(deletedAt)) {
            await applyRemoteTombstone(sessionId, deletedAt, fromName);
          }
        }
      }

      // 2. 比对会话清单（差集全拉、交集哈希不一致做消息级 Diff、一致则 0 传输）
      if (isRecord(msg.sessions)) {
        for (const [sessionId, remoteEntry] of Object.entries(msg.sessions)) {
          if (!remoteEntry || typeof remoteEntry.digest !== "string") {
            continue;
          }
          const localEntry = manifestCache.get(sessionId);
          if (!localEntry) {
            const localDeletedAt = tombstones[sessionId];
            if (localDeletedAt !== undefined && localDeletedAt >= remoteEntry.updatedAt) {
              continue;
            }
            const prev = pendingFullPulls.get(sessionId);
            if (!prev || remoteEntry.updatedAt > prev.updatedAt) {
              pendingFullPulls.set(sessionId, {
                peerId: fromPeerId,
                updatedAt: remoteEntry.updatedAt,
              });
            }
            continue;
          }
          if (localEntry.digest !== remoteEntry.digest) {
            const prev = pendingDiffPulls.get(sessionId);
            if (!prev || remoteEntry.updatedAt > prev.updatedAt) {
              pendingDiffPulls.set(sessionId, {
                peerId: fromPeerId,
                updatedAt: remoteEntry.updatedAt,
              });
            }
          }
        }
        if (pendingFullPulls.size > 0 || pendingDiffPulls.size > 0) {
          schedulePullFlush();
        }
      }

      // 3. 可选同步：自定义提示词与服务商配置
      const { config } = getSync();
      const wantPrompts =
        config.syncCustomPrompts &&
        typeof msg.customPromptsUpdatedAt === "number" &&
        msg.customPromptsUpdatedAt > 0;
      const wantProviders =
        config.syncProviders &&
        typeof msg.providersUpdatedAt === "number" &&
        msg.providersUpdatedAt > 0;
      if (wantPrompts || wantProviders) {
        await sendSyncMessage({ type: "SYNC_PREFS_REQ", wantPrompts, wantProviders }, [fromPeerId]);
      }

      // 4. 若对方请求回发清单，单播回复自身清单（replyNeeded: false，避免循环）
      if (msg.replyNeeded) {
        await sendManifest([fromPeerId], false);
      }
      break;
    }

    case "SYNC_SESSION_FULL_REQ": {
      if (!Array.isArray(msg.sessionIds)) {
        return;
      }
      for (const sessionId of msg.sessionIds) {
        if (typeof sessionId !== "string") {
          continue;
        }
        const session = await loadSessionFresh(sessionId);
        if (!session) {
          continue;
        }
        const normalized = normalizeSession(session);
        const meta = sessionMetaMap[sessionId] ?? defaultSessionSyncMeta(normalized);
        const messages = normalized.messages.filter(isSyncableMessage).map(sanitizeMessageForSync);
        await sendSyncMessage(
          {
            type: "SYNC_SESSION_FULL_RES",
            header: extractSessionHeader(normalized, meta),
            messages,
          },
          [fromPeerId],
        );
      }
      break;
    }

    case "SYNC_SESSION_FULL_RES": {
      if (Array.isArray(msg.messages)) {
        await applyIncomingPatch(msg.header, msg.messages, fromPeerId, fromName);
      }
      break;
    }

    case "SYNC_SESSION_DIFF_REQ": {
      if (typeof msg.sessionId !== "string" || !isRecord(msg.fingerprints)) {
        return;
      }
      const session = await loadSessionFresh(msg.sessionId);
      if (!session) {
        return;
      }
      const normalized = normalizeSession(session);
      const meta = sessionMetaMap[msg.sessionId] ?? defaultSessionSyncMeta(normalized);
      const diffMessages = diffSessionMessagesForRemote(normalized, msg.fingerprints);
      await sendSyncMessage(
        {
          type: "SYNC_SESSION_DIFF_RES",
          header: extractSessionHeader(normalized, meta),
          messages: diffMessages,
        },
        [fromPeerId],
      );
      break;
    }

    case "SYNC_SESSION_DIFF_RES": {
      if (Array.isArray(msg.messages)) {
        await applyIncomingPatch(msg.header, msg.messages, fromPeerId, fromName);
      }
      break;
    }

    case "SYNC_LIVE_PATCH": {
      if (Array.isArray(msg.messages)) {
        await applyIncomingPatch(msg.header, msg.messages, fromPeerId, fromName);
      }
      break;
    }

    case "SYNC_DELETE": {
      if (typeof msg.sessionId === "string" && typeof msg.deletedAt === "number") {
        await applyRemoteTombstone(msg.sessionId, msg.deletedAt, fromName);
      }
      break;
    }

    case "SYNC_PREFS_REQ": {
      const { config } = getSync();
      const res: SyncPrefsRes = { type: "SYNC_PREFS_RES" };
      if (msg.wantPrompts && config.syncCustomPrompts) {
        res.customPrompts = {
          updatedAt: prefsMeta.customPromptsUpdatedAt || Date.now(),
          items: readCustomPrompts(),
        };
      }
      if (msg.wantProviders && config.syncProviders) {
        res.providers = {
          updatedAt: prefsMeta.providersUpdatedAt || Date.now(),
          items: useProviders.getState().providers,
        };
      }
      if (res.customPrompts || res.providers) {
        await sendSyncMessage(res, [fromPeerId]);
      }
      break;
    }

    case "SYNC_PREFS_RES": {
      const { config } = getSync();
      let metaDirty = false;
      if (config.syncCustomPrompts && msg.customPrompts && Array.isArray(msg.customPrompts.items)) {
        const remoteIsNewer = msg.customPrompts.updatedAt >= prefsMeta.customPromptsUpdatedAt;
        const changed = mergeSyncedCustomPrompts(msg.customPrompts.items, remoteIsNewer);
        if (msg.customPrompts.updatedAt > prefsMeta.customPromptsUpdatedAt) {
          prefsMeta = { ...prefsMeta, customPromptsUpdatedAt: msg.customPrompts.updatedAt };
          metaDirty = true;
        }
        if (changed) {
          addLog(`已从 ${fromName} 合并自定义提示词`, "ok");
        }
      }
      if (config.syncProviders && msg.providers && Array.isArray(msg.providers.items)) {
        const remoteIsNewer = msg.providers.updatedAt >= prefsMeta.providersUpdatedAt;
        const changed = mergeSyncedProviders(msg.providers.items, remoteIsNewer);
        if (msg.providers.updatedAt > prefsMeta.providersUpdatedAt) {
          prefsMeta = { ...prefsMeta, providersUpdatedAt: msg.providers.updatedAt };
          metaDirty = true;
        }
        if (changed) {
          addLog(`已从 ${fromName} 合并服务商配置`, "ok");
        }
      }
      if (metaDirty) {
        await persistSyncMeta();
      }
      break;
    }

    default:
      break;
  }
};

const finishAutoBlobSlot = (silent: boolean) => {
  if (silent) {
    autoBlobInFlight = Math.max(0, autoBlobInFlight - 1);
    pumpAutoBlobQueue();
  }
};

const requestFileInternal = (fileId: string, fileName: string, silent: boolean): boolean => {
  if (localFileIds.has(fileId)) {
    finishAutoBlobSlot(silent);
    return false;
  }
  if (!client || !client.connected || client.peers.length === 0) {
    finishAutoBlobSlot(silent);
    return false;
  }
  if (pendingBlobLookups.has(fileId) || Object.hasOwn(getSync().downloadingFiles, fileId)) {
    finishAutoBlobSlot(silent);
    return false;
  }

  const timer = window.setTimeout(() => {
    const entry = pendingBlobLookups.get(fileId);
    if (entry && !entry.resolved) {
      pendingBlobLookups.delete(fileId);
      finishAutoBlobSlot(entry.silent);
      if (!entry.silent) {
        addLog(`在线设备均未缓存附件「${entry.name}」`, "warn");
      }
    }
  }, BLOB_LOOKUP_TIMEOUT_MS);

  pendingBlobLookups.set(fileId, { timer, resolved: false, name: fileName, silent });
  void sendBlobMessage({ type: "BLOB_WHO_HAS", fileId }, "*");
  return true;
};

const handleBlobSignal = async (
  fromPeerId: string,
  fromName: string,
  raw: unknown,
): Promise<void> => {
  if (!isRecord(raw) || typeof raw.type !== "string" || typeof raw.fileId !== "string") {
    return;
  }
  const fileId = raw.fileId;

  if (raw.type === "BLOB_WHO_HAS") {
    if (!localFileIds.has(fileId)) {
      // 兜底核对一次 IndexedDB，防止本机刚新发附件尚未入索引
      if (await db.hasFile(fileId)) {
        localFileIds.add(fileId);
      } else {
        return;
      }
    }
    const blob = await db.loadFile(fileId);
    if (blob) {
      await sendBlobMessage({ type: "BLOB_HAVE", fileId, size: blob.size }, [fromPeerId]);
    }
    return;
  }

  if (raw.type === "BLOB_HAVE") {
    const pending = pendingBlobLookups.get(fileId);
    if (!pending || pending.resolved) {
      return;
    }
    pending.resolved = true;
    window.clearTimeout(pending.timer);
    pendingBlobLookups.delete(fileId);
    setSync((state) => ({
      downloadingFiles: { ...state.downloadingFiles, [fileId]: 0 },
    }));
    addLog(`正在从 ${fromName} 拉取附件「${pending.name}」`, "info");
    await sendBlobMessage({ type: "BLOB_REQUEST", fileId }, [fromPeerId]);
    finishAutoBlobSlot(pending.silent);
    return;
  }

  if (raw.type === "BLOB_REQUEST") {
    let bucket = outgoingBlobQueue.get(fileId);
    if (!bucket) {
      bucket = { targets: new Set<string>(), timer: 0 };
      outgoingBlobQueue.set(fileId, bucket);
    }
    bucket.targets.add(fromPeerId);

    // 短窗聚合同一附件的多端请求，一次 sendFiles 利用 DO 边缘扇出服务所有请求方
    if (!bucket.timer) {
      bucket.timer = window.setTimeout(() => {
        const current = outgoingBlobQueue.get(fileId);
        outgoingBlobQueue.delete(fileId);
        if (!current || !client || !client.connected || current.targets.size === 0) {
          return;
        }
        const targets = Array.from(current.targets);
        void (async () => {
          const blob = await db.loadFile(fileId);
          if (!blob || !client || !client.connected) {
            return;
          }
          const file = new File([blob], `${fileId}.bin`, {
            type: blob.type || "application/octet-stream",
          });
          try {
            await client.sendFiles([file], {
              targets,
              bundleSmallFiles: false,
              meta: {
                kind: "chat-file",
                fileId,
                mimeType: blob.type || "",
              },
            });
          } catch (error) {
            addLog(
              `推送附件失败: ${error instanceof Error ? error.message : String(error)}`,
              "warn",
            );
          }
        })();
      }, BLOB_AGGREGATE_MS);
    }
  }
};

const handleIncomingFileOffer = async (offer: SyncFileOffer) => {
  if (offer.meta.kind !== "chat-file" || typeof offer.meta.fileId !== "string") {
    await offer.reject("UNSUPPORTED");
    return;
  }
  const fileId = offer.meta.fileId;
  if (localFileIds.has(fileId) || (await db.hasFile(fileId))) {
    localFileIds.add(fileId);
    await offer.reject("ALREADY_HAVE");
    return;
  }
  transferToFileId.set(offer.transferId, fileId);
  setSync((state) => ({
    downloadingFiles: { ...state.downloadingFiles, [fileId]: 0 },
  }));
  await offer.accept();
};

const handleFileProgress = (progress: SyncTransferProgress) => {
  if (progress.direction !== "receive") {
    return;
  }
  const fileId = transferToFileId.get(progress.transferId);
  if (!fileId) {
    return;
  }
  const pct = Math.min(100, Math.max(0, Math.round(progress.percent)));
  setSync((state) => ({
    downloadingFiles: { ...state.downloadingFiles, [fileId]: pct },
  }));
};

const handleFileReceived = async (received: SyncReceivedFile) => {
  const metaFileId = typeof received.meta.fileId === "string" ? received.meta.fileId : null;
  const fileId = metaFileId ?? transferToFileId.get(received.transferId) ?? null;
  transferToFileId.delete(received.transferId);
  if (!fileId) {
    await received.cleanup().catch(() => {});
    return;
  }
  try {
    const fileObj = await received.getFile();
    const mimeType =
      typeof received.meta.mimeType === "string" && received.meta.mimeType
        ? received.meta.mimeType
        : fileObj.type;
    const blob = new Blob([fileObj], { type: mimeType });
    await db.saveFiles([{ id: fileId, blob }]);
    localFileIds.add(fileId);
    setSync((state) => ({
      downloadingFiles: Object.fromEntries(
        Object.entries(state.downloadingFiles).filter(([key]) => key !== fileId),
      ),
      fileVersions: {
        ...state.fileVersions,
        [fileId]: (state.fileVersions[fileId] ?? 0) + 1,
      },
    }));
    addLog(`附件已落盘同步到本地`, "ok");
  } catch (error) {
    addLog(`保存同步附件失败: ${error instanceof Error ? error.message : String(error)}`, "err");
    setSync((state) => ({
      downloadingFiles: Object.fromEntries(
        Object.entries(state.downloadingFiles).filter(([key]) => key !== fileId),
      ),
    }));
  } finally {
    await received.cleanup().catch(() => {});
  }
};

const handleLocalChatMutation = async (event: LocalChatMutation) => {
  await ensureSyncMetaLoaded();
  if (event.type === "session-deleted") {
    manifestCache.delete(event.sessionId);
    sessionMetaMap = Object.fromEntries(
      Object.entries(sessionMetaMap).filter(([key]) => key !== event.sessionId),
    );
    tombstones = { ...tombstones, [event.sessionId]: event.deletedAt };
    await persistSyncMeta();
    setSync({ sessionCount: manifestCache.size });
    if (client && client.connected && client.peers.length > 0) {
      await sendSyncMessage({
        type: "SYNC_DELETE",
        sessionId: event.sessionId,
        deletedAt: event.deletedAt,
      });
    }
    return;
  }

  const session = await loadSessionFresh(event.sessionId);
  if (!session) {
    return;
  }
  const normalized = normalizeSession(session);

  // 清除可能存在的旧墓碑（防重用/恢复）
  if (tombstones[event.sessionId] !== undefined) {
    tombstones = Object.fromEntries(
      Object.entries(tombstones).filter(([key]) => key !== event.sessionId),
    );
  }

  const prevMeta = sessionMetaMap[event.sessionId] ?? defaultSessionSyncMeta(normalized);
  const nextMeta: SessionSyncMeta =
    event.type === "session-renamed" ? { titleUpdatedAt: event.updatedAt } : prevMeta;

  sessionMetaMap = { ...sessionMetaMap, [event.sessionId]: nextMeta };
  manifestCache.set(event.sessionId, buildSessionManifestEntry(normalized, nextMeta));

  // 记录本机新产生的附件 ID 到索引
  for (const file of collectSessionFiles(normalized).values()) {
    if (!localFileIds.has(file.id) && (await db.hasFile(file.id))) {
      localFileIds.add(file.id);
    }
  }

  await persistSyncMeta();
  setSync({ sessionCount: manifestCache.size });

  if (!client || !client.connected || client.peers.length === 0) {
    return;
  }

  const header = extractSessionHeader(normalized, nextMeta);
  if (event.type === "session-renamed") {
    await sendSyncMessage({ type: "SYNC_LIVE_PATCH", header, messages: [] });
    return;
  }

  // 在线实时增量：仅推送当前分支末尾最近 4 条稳态消息，缺父节点时对端自动兜底全量拉取
  const visibleSyncable = getVisibleMessages(normalized)
    .filter(isSyncableMessage)
    .slice(-4)
    .map(sanitizeMessageForSync);
  await sendSyncMessage({
    type: "SYNC_LIVE_PATCH",
    header,
    messages: visibleSyncable,
  });
};

const handleLocalPromptsChanged = async () => {
  await ensureSyncMetaLoaded();
  prefsMeta = { ...prefsMeta, customPromptsUpdatedAt: Date.now() };
  await persistSyncMeta();
  const { config } = getSync();
  if (config.syncCustomPrompts && client && client.connected && client.peers.length > 0) {
    await sendSyncMessage({
      type: "SYNC_PREFS_RES",
      customPrompts: {
        updatedAt: prefsMeta.customPromptsUpdatedAt,
        items: readCustomPrompts(),
      },
    });
  }
};

const handleLocalProvidersChanged = async () => {
  await ensureSyncMetaLoaded();
  prefsMeta = { ...prefsMeta, providersUpdatedAt: Date.now() };
  await persistSyncMeta();
  const { config } = getSync();
  if (config.syncProviders && client && client.connected && client.peers.length > 0) {
    await sendSyncMessage({
      type: "SYNC_PREFS_RES",
      providers: {
        updatedAt: prefsMeta.providersUpdatedAt,
        items: useProviders.getState().providers,
      },
    });
  }
};

const clearPendingTimers = () => {
  if (pullCoalesceTimer) {
    window.clearTimeout(pullCoalesceTimer);
    pullCoalesceTimer = 0;
  }
  pendingFullPulls.clear();
  pendingDiffPulls.clear();
  for (const item of pendingBlobLookups.values()) {
    window.clearTimeout(item.timer);
  }
  pendingBlobLookups.clear();
  for (const bucket of outgoingBlobQueue.values()) {
    window.clearTimeout(bucket.timer);
  }
  outgoingBlobQueue.clear();
  transferToFileId.clear();
  autoBlobQueue.length = 0;
  autoBlobInFlight = 0;
  syncingActivityCount = 0;
};

/** 更新同步配置并立即写入 localStorage */
export const updateSyncConfig = (patch: Partial<SyncConfig>): SyncConfig => {
  const next: SyncConfig = { ...getSync().config, ...patch };
  saveSyncConfig(next);
  setSync({ config: next });
  return next;
};

/**
 * 动态加载外部 Worker SDK 并连接同步房间。
 * 连接成功后自动将 autoConnect 置为 true，下次刷新页面将自动连接。
 */
export const connectSync = async (override?: Partial<SyncConfig>): Promise<boolean> => {
  const config = override ? updateSyncConfig(override) : getSync().config;
  if (!config.workerUrl.trim() || !config.password) {
    setSync({ lastError: { code: "missingConfig", message: "Missing workerUrl or password" } });
    return false;
  }

  await disconnectSync({ preserveAutoConnect: true });
  await ensureSyncMetaLoaded();

  setSync({
    status: "loading-sdk",
    lastError: null,
    reconnectingAttempt: 0,
    reconnectingDelayMs: 0,
  });

  try {
    const { sdk, normalized } = await loadCfWssSyncSdk(config.workerUrl);
    setSync({ status: "connecting" });

    const instance = new sdk.SyncClient({
      workerUrl: normalized.httpBase,
      password: config.password,
      role: "duplex",
      deviceName: config.deviceName.trim() || undefined,
      autoAcceptFiles: false,
      bundleSmallFiles: false,
      autoReconnect: true,
    });
    client = instance;

    instance.on("connected", ({ self, peers }) => {
      if (client !== instance) {
        return;
      }
      setSync({
        status: "connected",
        self,
        peers,
        lastError: null,
        reconnectingAttempt: 0,
        reconnectingDelayMs: 0,
      });
      // 首次连接成功持久化自动连接开关，下次刷新自动连回房间
      if (!getSync().config.autoConnect) {
        updateSyncConfig({ autoConnect: true });
      }
      addLog(`已加入同步房间（${self.name} · 在线对端 ${peers.length} 台）`, "ok");
      if (peers.length > 0) {
        void sendManifest("*", true);
      }
    });

    instance.on("reconnecting", ({ attempt, delayMs }) => {
      if (client !== instance) {
        return;
      }
      setSync({
        status: "reconnecting",
        reconnectingAttempt: attempt,
        reconnectingDelayMs: delayMs,
      });
    });

    instance.on("disconnected", ({ willReconnect }) => {
      if (client !== instance) {
        return;
      }
      clearPendingTimers();
      setSync({
        status: willReconnect ? "reconnecting" : "disconnected",
        peers: [],
        syncing: false,
        downloadingFiles: {},
        ...(willReconnect ? {} : { self: null }),
      });
    });

    instance.on("peers-change", (list) => {
      if (client !== instance) {
        return;
      }
      const prevIds = new Set(getSync().peers.map((peer) => peer.peerId));
      setSync({ peers: list });
      const newlyJoined = list.filter((peer) => !prevIds.has(peer.peerId));
      if (newlyJoined.length > 0) {
        addLog(`设备上线: ${newlyJoined.map((peer) => peer.name).join("、")}，开始对账`, "info");
        void sendManifest(
          newlyJoined.map((peer) => peer.peerId),
          true,
        );
      }
    });

    instance.on("data", ({ fromPeerId, fromName, channel, data }) => {
      if (client !== instance) {
        return;
      }
      if (channel === SYNC_CHANNEL) {
        void handleSyncMessage(fromPeerId, fromName, data);
      } else if (channel === BLOB_CHANNEL) {
        void handleBlobSignal(fromPeerId, fromName, data);
      }
    });

    instance.on("file-offer", (offer) => {
      if (client !== instance) {
        return;
      }
      void handleIncomingFileOffer(offer);
    });

    instance.on("progress", (progress) => {
      if (client !== instance) {
        return;
      }
      handleFileProgress(progress);
    });

    instance.on("file-received", (received) => {
      if (client !== instance) {
        return;
      }
      void handleFileReceived(received);
    });

    instance.on("transfer-cancelled", ({ transferId }) => {
      const fileId = transferToFileId.get(transferId);
      if (!fileId) {
        return;
      }
      transferToFileId.delete(transferId);
      setSync((state) => ({
        downloadingFiles: Object.fromEntries(
          Object.entries(state.downloadingFiles).filter(([key]) => key !== fileId),
        ),
      }));
    });

    instance.on("quota-stats", (quota) => {
      if (client !== instance) {
        return;
      }
      setSync({ quota });
    });

    instance.on("error", (error) => {
      if (client !== instance) {
        return;
      }
      setSync({ lastError: { code: error.code, message: error.message } });
      addLog(`同步异常: ${error.message}`, "err");
    });

    await instance.connect();
    return true;
  } catch (error) {
    client = null;
    const code = error instanceof SdkLoadError ? error.code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    setSync({
      status: "disconnected",
      self: null,
      peers: [],
      lastError: { code, message },
    });
    addLog(`连接失败: ${message}`, "err");
    return false;
  }
};

/** 断开同步连接；手动断开时关闭 autoConnect 避免刷新后又强行连回 */
export const disconnectSync = async (options?: {
  preserveAutoConnect?: boolean;
}): Promise<void> => {
  if (!options?.preserveAutoConnect && getSync().config.autoConnect) {
    updateSyncConfig({ autoConnect: false });
  }
  clearPendingTimers();
  const active = client;
  client = null;
  if (active) {
    try {
      await active.disconnect();
    } catch {
      // 忽略关闭期间的瞬时错误
    }
  }
  setSync({
    status: "disconnected",
    self: null,
    peers: [],
    syncing: false,
    downloadingFiles: {},
    reconnectingAttempt: 0,
    reconnectingDelayMs: 0,
  });
};

/** 手动触发全房增量对账 */
export const triggerManualReconcile = async (): Promise<void> => {
  if (!client || !client.connected || client.peers.length === 0) {
    return;
  }
  await ensureSyncMetaLoaded();
  addLog("手动发起全房增量对账", "info");
  await sendManifest("*", true);
};

/** 按需向在线设备拉取指定附件原件（供 MessageFile 卡片点击调用） */
export const requestSyncedFile = (fileId: string, fileName: string): boolean =>
  requestFileInternal(fileId, fileName, false);

/**
 * 在应用启动并完成 initChat 后调用一次：
 * 绑定本地变更订阅、处理历史导入/清空互斥保护，并在 autoConnect 为真时自动加载 SDK 并连接。
 */
export const bootstrapSync = (): void => {
  if (!bindingsInstalled) {
    bindingsInstalled = true;
    onLocalChatMutation((event) => {
      void handleLocalChatMutation(event);
    });
    onLocalPromptsMutation(() => {
      void handleLocalPromptsChanged();
    });
    onLocalProvidersMutation(() => {
      void handleLocalProvidersChanged();
    });

    // 历史导入或清空全部对话期间自动断开保护，避免大范围破坏性操作扩散给其他在线设备
    useChatStore.subscribe((state, previous) => {
      if (state.importingHistory && !previous.importingHistory) {
        if (client) {
          addLog("检测到历史导入/清空，已自动断开同步以保护其他设备", "warn");
          void disconnectSync({ preserveAutoConnect: false });
        }
      } else if (!state.importingHistory && previous.importingHistory) {
        // 本地历史被整库替换后重置清单缓存与墓碑
        tombstones = {};
        sessionMetaMap = {};
        void ensureSyncMetaLoaded().then(async () => {
          await rebuildManifestCache();
          await persistSyncMeta();
        });
      }
    });
  }

  const { config } = getSync();
  if (config.autoConnect && config.workerUrl.trim() && config.password) {
    void connectSync();
  }
};
