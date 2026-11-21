import { normalizeSession } from "../chat/branches.js";
import type { AssistantMessage, Message, ReplyBlock, Session, UserMessage } from "../chat/types.js";

/** 每个会话独立的同步元数据（存在 IndexedDB syncMeta 表） */
export type SessionSyncMeta = {
  /** 标题最后一次修改时间，用于标题独立 LWW，避免新消息覆盖重命名 */
  titleUpdatedAt: number;
};

/** 传输层的会话头信息（用于全量/增量同步） */
export type SyncSessionHeader = {
  id: string;
  title: string;
  titleUpdatedAt: number;
  createdAt: number;
  updatedAt: number;
  rootMessageId: string | null;
  /** parentId -> selectedChildId，仅作为非冲突快进时的参考指针 */
  selectedChildren: Record<string, string>;
};

export type SyncSessionManifestEntry = {
  digest: string;
  messageCount: number;
  updatedAt: number;
  titleUpdatedAt: number;
};

export type RemoteSessionPatch = {
  header: SyncSessionHeader;
  messages: Message[];
};

export type MergeSessionOptions = {
  /** 为 true 时保留本地当前的分支浏览焦点（避免打断用户正在查看的对话） */
  preserveLocalFocus: boolean;
  /** 若本地该会话正在流式生成，传入正在生成的回复 ID，保护其不被覆盖 */
  streamingReplyId?: string | null;
};

export type MergeSessionResult = {
  session: Session;
  meta: SessionSyncMeta;
  changed: boolean;
  /** 合并后是否在原分叉点新增了其他分支（用于给正在浏览该会话的用户弹提示） */
  addedNewBranch: boolean;
  /** 合并后新增的消息 ID（便于扫描新增的附件原件） */
  addedMessageIds: string[];
  /** 存在孤儿消息（缺失父节点），调用方应回退请求完整会话 */
  hasOrphans: boolean;
};

const REPLY_STATUS_RANK: Record<AssistantMessage["status"], number> = {
  pending: 0,
  streaming: 1,
  error: 2,
  stopped: 3,
  done: 4,
};

/** 64 位双 FNV-1a 确定性哈希（16 位小写 Hex），纯同步零开销 */
export const stableHash = (input: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code + ((i & 0xff) << 8);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
};

/** 只有非流式稳态消息才向外同步，避免每帧中间态浪费流量或污染对端 */
export const isSyncableMessage = (message: Message): boolean =>
  message.role === "user" ||
  message.status === "done" ||
  message.status === "stopped" ||
  message.status === "error";

/** 外发同步时剥离绑定在当前 API Key 上的临时 serverId */
export const sanitizeMessageForSync = (message: Message): Message => {
  if (message.role === "user") {
    return {
      ...message,
      files: message.files.map((file) => ({ ...file, serverId: null })),
    };
  }
  return message;
};

const serializeBlocksSignature = (blocks: ReplyBlock[]): string =>
  blocks
    .map((block) => {
      switch (block.type) {
        case "text":
          return `t:${block.isTemplate ? 1 : 0}:${block.text}`;
        case "thinking":
          return `k:${block.thinking}`;
        case "server_tool_use":
          return `u:${block.id}:${block.kind}`;
        case "web_search_tool_result":
          return `s:${block.tool_use_id}:${block.content.length}`;
        case "web_fetch_tool_result":
          return `f:${block.tool_use_id}:${block.content.type}`;
        default:
          return "";
      }
    })
    .join("\u001e");

/** 计算单条消息的内容指纹，用于会话内消息级增量 Diff */
export const getMessageFingerprint = (message: Message): string => {
  if (message.role === "user") {
    const filesSig = message.files
      .map((file) => `${file.id}:${file.name}:${file.size}:${file.isImage ? 1 : 0}`)
      .join(",");
    return `u:${message.parentId ?? ""}:${stableHash(`${message.content}\u001f${filesSig}`)}`;
  }
  const blockSig = serializeBlocksSignature(message.blocks);
  const errSig = message.error ? `${message.error.kind}:${message.error.message}` : "";
  return `a:${message.parentId ?? ""}:${message.status}:${message.stopReason ?? ""}:${message.blocks.length}:${stableHash(`${blockSig}\u001f${errSig}`)}`;
};

export const defaultSessionSyncMeta = (session: Session): SessionSyncMeta => ({
  titleUpdatedAt: session.title.trim() ? session.updatedAt : 0,
});

/**
 * 计算会话内容摘要哈希：仅覆盖可同步消息集合与标题元数据，故意不含 selectedChildId 视口焦点，
 * 保证两端查看不同分支时摘要依然一致，杜绝反复循环同步。
 */
export const computeSessionDigest = (session: Session, meta?: SessionSyncMeta): string => {
  const normalized = normalizeSession(session);
  const resolvedMeta = meta ?? defaultSessionSyncMeta(normalized);
  const msgParts = normalized.messages
    .filter(isSyncableMessage)
    .map((message) => `${message.id}=${getMessageFingerprint(message)}`)
    .sort();
  const headerPart = `${normalized.id}|${normalized.title}|${resolvedMeta.titleUpdatedAt}`;
  return stableHash(`${headerPart}\n${msgParts.join("\n")}`);
};

export const buildSessionManifestEntry = (
  session: Session,
  meta?: SessionSyncMeta,
): SyncSessionManifestEntry => {
  const normalized = normalizeSession(session);
  const resolvedMeta = meta ?? defaultSessionSyncMeta(normalized);
  return {
    digest: computeSessionDigest(normalized, resolvedMeta),
    messageCount: normalized.messages.filter(isSyncableMessage).length,
    updatedAt: normalized.updatedAt,
    titleUpdatedAt: resolvedMeta.titleUpdatedAt,
  };
};

export const extractSessionHeader = (
  session: Session,
  meta?: SessionSyncMeta,
): SyncSessionHeader => {
  const normalized = normalizeSession(session);
  const resolvedMeta = meta ?? defaultSessionSyncMeta(normalized);
  const selectedChildren: Record<string, string> = {};
  for (const message of normalized.messages) {
    if (message.selectedChildId) {
      selectedChildren[message.id] = message.selectedChildId;
    }
  }
  return {
    id: normalized.id,
    title: normalized.title,
    titleUpdatedAt: resolvedMeta.titleUpdatedAt,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    rootMessageId: normalized.rootMessageId ?? null,
    selectedChildren,
  };
};

export const buildMessageFingerprints = (session: Session): Record<string, string> => {
  const normalized = normalizeSession(session);
  const map: Record<string, string> = {};
  for (const message of normalized.messages) {
    if (isSyncableMessage(message)) {
      map[message.id] = getMessageFingerprint(message);
    }
  }
  return map;
};

/** 选出对端缺失或指纹不同的消息，用于会话内消息级增量推送 */
export const diffSessionMessagesForRemote = (
  session: Session,
  remoteFingerprints: Record<string, string>,
): Message[] => {
  const normalized = normalizeSession(session);
  const out: Message[] = [];
  for (const message of normalized.messages) {
    if (!isSyncableMessage(message)) {
      continue;
    }
    const localFp = getMessageFingerprint(message);
    if (remoteFingerprints[message.id] !== localFp) {
      out.push(sanitizeMessageForSync(message));
    }
  }
  return out;
};

const blockTextOf = (blocks: ReplyBlock[]): string =>
  blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();

/** 判断 shorter 是否为 longer 的前缀延伸（用于识别正常的单端“继续生成”） */
const isBlocksPrefix = (shorter: ReplyBlock[], longer: ReplyBlock[]): boolean => {
  if (shorter.length > longer.length) {
    return false;
  }
  if (shorter.length === 0) {
    return true;
  }
  for (let i = 0; i < shorter.length - 1; i += 1) {
    if (serializeBlocksSignature([shorter[i]]) !== serializeBlocksSignature([longer[i]])) {
      return false;
    }
  }
  const lastShort = shorter[shorter.length - 1];
  const matchLong = longer[shorter.length - 1];
  if (lastShort.type !== matchLong.type) {
    return false;
  }
  if (lastShort.type === "text" && matchLong.type === "text") {
    return matchLong.text.startsWith(lastShort.text);
  }
  if (lastShort.type === "thinking" && matchLong.type === "thinking") {
    return matchLong.thinking.startsWith(lastShort.thinking);
  }
  return serializeBlocksSignature([lastShort]) === serializeBlocksSignature([matchLong]);
};

/**
 * 合并同一 ID 的 AssistantMessage（处理续写、补传重试、以及极端情况下的双端并发续写）。
 * 返回主消息与可选的派生分叉兄弟消息。
 */
const mergeSameAssistantMessage = (
  local: AssistantMessage,
  remote: AssistantMessage,
): { primary: AssistantMessage; forked?: AssistantMessage } => {
  if (getMessageFingerprint(local) === getMessageFingerprint(remote)) {
    return { primary: local };
  }

  const localRank = REPLY_STATUS_RANK[local.status];
  const remoteRank = REPLY_STATUS_RANK[remote.status];
  const localText = blockTextOf(local.blocks);
  const remoteText = blockTextOf(remote.blocks);

  // 一方无实质正文（如 error/pending），优先采纳有实质内容或状态更高的一方
  if (!localText && remoteText) {
    return { primary: remote };
  }
  if (localText && !remoteText) {
    return { primary: local };
  }

  // 正常单端“继续生成”：短版本是长版本的前缀，直接取长版本
  if (isBlocksPrefix(local.blocks, remote.blocks)) {
    return { primary: remote };
  }
  if (isBlocksPrefix(remote.blocks, local.blocks)) {
    return { primary: local };
  }

  // 一方为 error 且另一方已重试成功（done/stopped）
  if (localRank !== remoteRank && (local.status === "error" || remote.status === "error")) {
    return { primary: remoteRank > localRank ? remote : local };
  }

  // 极端情况：A、B 对同一条未完成回复各自离线点了「继续生成」导致正文分歧
  // 用确定性规则选出主版本，另一版本以确定性派生 ID 挂在同一 parentId 下成为兄弟分支，0 丢失
  const localSig = serializeBlocksSignature(local.blocks);
  const remoteSig = serializeBlocksSignature(remote.blocks);
  const localTime = local.finishedAt ?? local.createdAt;
  const remoteTime = remote.finishedAt ?? remote.createdAt;
  const keepLocalPrimary =
    localTime !== remoteTime
      ? localTime < remoteTime
      : stableHash(localSig) <= stableHash(remoteSig);

  const primary = keepLocalPrimary ? local : remote;
  const secondary = keepLocalPrimary ? remote : local;
  const secondarySig = keepLocalPrimary ? remoteSig : localSig;
  const forkId = `fork-${secondary.id}-${stableHash(secondarySig).slice(0, 8)}`;
  return {
    primary,
    forked: {
      ...secondary,
      id: forkId,
      parentId: primary.parentId,
      selectedChildId: undefined,
    },
  };
};

const mergeSameUserMessage = (local: UserMessage, remote: UserMessage): UserMessage => {
  // 提问正文不可变；保留本机已有附件的 serverId，同时合入缺失的 mimeType
  const localByFileId = new Map(local.files.map((file) => [file.id, file]));
  const files = remote.files.map((file) => {
    const existing = localByFileId.get(file.id);
    if (!existing) {
      return { ...file, serverId: null };
    }
    return {
      ...existing,
      mimeType: existing.mimeType || file.mimeType,
    };
  });
  return { ...local, files };
};

const mergeTitle = (
  localTitle: string,
  localUpdatedAt: number,
  remoteTitle: string,
  remoteUpdatedAt: number,
): { title: string; titleUpdatedAt: number } => {
  const localClean = localTitle.trim();
  const remoteClean = remoteTitle.trim();
  if (!localClean && remoteClean) {
    return { title: remoteTitle, titleUpdatedAt: remoteUpdatedAt };
  }
  if (localClean && !remoteClean) {
    return { title: localTitle, titleUpdatedAt: localUpdatedAt };
  }
  if (localTitle === remoteTitle) {
    return { title: localTitle, titleUpdatedAt: Math.max(localUpdatedAt, remoteUpdatedAt) };
  }
  if (remoteUpdatedAt > localUpdatedAt) {
    return { title: remoteTitle, titleUpdatedAt: remoteUpdatedAt };
  }
  if (localUpdatedAt > remoteUpdatedAt) {
    return { title: localTitle, titleUpdatedAt: localUpdatedAt };
  }
  // 时间完全相同时按字典序确定性收敛
  return remoteTitle > localTitle
    ? { title: remoteTitle, titleUpdatedAt: remoteUpdatedAt }
    : { title: localTitle, titleUpdatedAt: localUpdatedAt };
};

const messageActivityTime = (message: Message): number =>
  message.role === "assistant" ? (message.finishedAt ?? message.createdAt) : message.createdAt;

const compareSiblings = (a: Message, b: Message): number =>
  a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/**
 * 将远端会话（全量或消息级增量补丁）无损合并到本地会话树中。
 * 满足交换律、结合律与幂等律；合并后消息数组按确定性拓扑序排列，保证各端分支序号一致。
 */
export const mergeSessionPatch = (
  localOriginal: Session | null,
  localMetaOriginal: SessionSyncMeta | null,
  patch: RemoteSessionPatch,
  options: MergeSessionOptions,
): MergeSessionResult => {
  const local = localOriginal ? normalizeSession(localOriginal) : null;
  const localMeta = local
    ? (localMetaOriginal ?? defaultSessionSyncMeta(local))
    : { titleUpdatedAt: patch.header.titleUpdatedAt };

  const byId = new Map<string, Message>();
  const localIds = new Set<string>();
  const localChildrenByParent = new Map<string | null, Set<string>>();
  const localSelectedByParent = new Map<string | null, string>();

  if (local) {
    if (local.rootMessageId) {
      localSelectedByParent.set(null, local.rootMessageId);
    }
    for (const message of local.messages) {
      const parentId = message.parentId ?? null;
      byId.set(message.id, { ...message, parentId });
      localIds.add(message.id);
      const set = localChildrenByParent.get(parentId) ?? new Set<string>();
      set.add(message.id);
      localChildrenByParent.set(parentId, set);
      if (message.selectedChildId) {
        localSelectedByParent.set(message.id, message.selectedChildId);
      }
    }
  }

  const addedMessageIds: string[] = [];
  let contentChanged = local === null;
  const pendingForks: AssistantMessage[] = [];

  for (const rawRemote of patch.messages) {
    if (!isSyncableMessage(rawRemote)) {
      continue;
    }
    const remote: Message = {
      ...sanitizeMessageForSync(rawRemote),
      parentId: rawRemote.parentId ?? null,
    };
    const existing = byId.get(remote.id);
    if (!existing) {
      byId.set(remote.id, remote);
      addedMessageIds.push(remote.id);
      contentChanged = true;
      continue;
    }
    if (options.streamingReplyId && existing.id === options.streamingReplyId) {
      continue;
    }
    if (existing.role === "user" && remote.role === "user") {
      const mergedUser = mergeSameUserMessage(existing, remote);
      if (getMessageFingerprint(mergedUser) !== getMessageFingerprint(existing)) {
        byId.set(remote.id, mergedUser);
        contentChanged = true;
      }
    } else if (existing.role === "assistant" && remote.role === "assistant") {
      const { primary, forked } = mergeSameAssistantMessage(existing, remote);
      if (primary !== existing) {
        byId.set(remote.id, primary);
        contentChanged = true;
      }
      if (forked && !byId.has(forked.id)) {
        pendingForks.push(forked);
      }
    }
  }

  for (const forked of pendingForks) {
    if (!byId.has(forked.id)) {
      byId.set(forked.id, forked);
      addedMessageIds.push(forked.id);
      contentChanged = true;
    }
  }

  // 校验父节点存在性，剥离暂未到达父节点的孤儿消息，避免写入损坏的树
  let hasOrphans = false;
  const validIds = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const message of byId.values()) {
      if (validIds.has(message.id)) {
        continue;
      }
      const parentId = message.parentId ?? null;
      if (parentId === null || validIds.has(parentId)) {
        validIds.add(message.id);
        progress = true;
      }
    }
  }
  if (validIds.size < byId.size) {
    hasOrphans = true;
    for (const id of Array.from(byId.keys())) {
      if (!validIds.has(id)) {
        byId.delete(id);
      }
    }
  }

  // 按 parentId 分组并按确定性顺序排序（createdAt 升序，id 字典序兜底）
  const childrenByParent = new Map<string | null, Message[]>();
  for (const message of byId.values()) {
    const parentId = message.parentId ?? null;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(message);
    childrenByParent.set(parentId, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort(compareSiblings);
  }

  // 递归计算每个节点及其子树的最大活跃时间，用于并发分叉的确定性默认选择
  const subtreeMaxTime = new Map<string, number>();
  const computeSubtreeTime = (id: string): number => {
    const cached = subtreeMaxTime.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const msg = byId.get(id);
    let best = msg ? messageActivityTime(msg) : 0;
    for (const child of childrenByParent.get(id) ?? []) {
      const childTime = computeSubtreeTime(child.id);
      if (childTime > best) {
        best = childTime;
      }
    }
    subtreeMaxTime.set(id, best);
    return best;
  };

  const pickSelectedChild = (parentId: string | null): string | undefined => {
    const children = childrenByParent.get(parentId);
    if (!children || children.length === 0) {
      return undefined;
    }
    if (children.length === 1) {
      return children[0].id;
    }
    const localSelected = localSelectedByParent.get(parentId);
    const remoteSelected =
      parentId === null
        ? (patch.header.rootMessageId ?? undefined)
        : patch.header.selectedChildren[parentId];
    const validChildIds = new Set(children.map((child) => child.id));

    // 用户正在看这个会话：保留当前分支焦点，不跳走打断阅读
    if (options.preserveLocalFocus && localSelected && validChildIds.has(localSelected)) {
      return localSelected;
    }
    // 本机原来在此处没有分支（刚收到新延伸），优先采纳远端指针
    const localHadChildren = (localChildrenByParent.get(parentId)?.size ?? 0) > 0;
    if (!localHadChildren && remoteSelected && validChildIds.has(remoteSelected)) {
      return remoteSelected;
    }
    // 确定性收敛：选择子树最新活动时间最大的分支，相同时按 id 字典序大者胜出
    let winner = children[0];
    let winnerTime = computeSubtreeTime(winner.id);
    for (let i = 1; i < children.length; i += 1) {
      const candidate = children[i];
      const candidateTime = computeSubtreeTime(candidate.id);
      if (
        candidateTime > winnerTime ||
        (candidateTime === winnerTime && candidate.id.localeCompare(winner.id) > 0)
      ) {
        winner = candidate;
        winnerTime = candidateTime;
      }
    }
    return winner.id;
  };

  // 检查是否在某个本地已有子节点的父节点下新增了兄弟分支
  let addedNewBranch = false;
  if (local) {
    for (const [parentId, children] of childrenByParent.entries()) {
      const prevSet = localChildrenByParent.get(parentId);
      if (prevSet && prevSet.size > 0 && children.length > prevSet.size) {
        addedNewBranch = true;
        break;
      }
    }
  }

  // 拓扑展开生成确定性有序的 messages 数组（父永远在前、同父按 createdAt + id 排序）
  const sortedMessages: Message[] = [];
  let maxMessageTime = 0;
  const visit = (parentId: string | null) => {
    const children = childrenByParent.get(parentId);
    if (!children) {
      return;
    }
    for (const child of children) {
      const selectedChildId = pickSelectedChild(child.id);
      const normalizedChild: Message = {
        ...child,
        parentId,
        selectedChildId,
      };
      sortedMessages.push(normalizedChild);
      const activity = messageActivityTime(normalizedChild);
      if (activity > maxMessageTime) {
        maxMessageTime = activity;
      }
      visit(child.id);
    }
  };
  visit(null);

  const rootMessageId = pickSelectedChild(null) ?? null;
  const mergedTitle = local
    ? mergeTitle(
        local.title,
        localMeta.titleUpdatedAt,
        patch.header.title,
        patch.header.titleUpdatedAt,
      )
    : { title: patch.header.title, titleUpdatedAt: patch.header.titleUpdatedAt };

  const titleChanged = !local || mergedTitle.title !== local.title;
  const createdAt = local
    ? Math.min(local.createdAt, patch.header.createdAt)
    : patch.header.createdAt;
  const updatedAt = Math.max(
    local?.updatedAt ?? 0,
    patch.header.updatedAt,
    maxMessageTime,
    mergedTitle.titleUpdatedAt,
  );

  const pointerChanged =
    local !== null &&
    (rootMessageId !== (local.rootMessageId ?? null) ||
      sortedMessages.some((msg) => {
        const prev = local.messages.find((item) => item.id === msg.id);
        return prev !== undefined && prev.selectedChildId !== msg.selectedChildId;
      }));

  const changed = contentChanged || titleChanged || pointerChanged;

  const mergedSession: Session = {
    id: patch.header.id,
    title: mergedTitle.title,
    createdAt,
    updatedAt,
    rootMessageId,
    messages: sortedMessages,
  };

  return {
    session: changed || !local ? mergedSession : local,
    meta: { titleUpdatedAt: mergedTitle.titleUpdatedAt },
    changed,
    addedNewBranch,
    addedMessageIds: addedMessageIds.filter((id) => validIds.has(id) && !localIds.has(id)),
    hasOrphans,
  };
};

/**
 * 墓碑冲突裁决（Add-Wins 原则）：
 * 若删除时间晚于或等于会话中全部消息的最新活动时间，则执行删除；
 * 若离线期间另一端在删除之后又发了新消息，则新消息胜出，保留会话并清除墓碑。
 */
export const resolveTombstone = (session: Session, deletedAt: number): "delete" | "keep" => {
  let latestActivityAt = session.createdAt;
  for (const message of session.messages) {
    const t = messageActivityTime(message);
    if (t > latestActivityAt) {
      latestActivityAt = t;
    }
  }
  return deletedAt >= latestActivityAt ? "delete" : "keep";
};

/** 扫描一个会话引用的全部附件元数据（按 id 去重） */
export const collectSessionFiles = (
  session: Session,
): Map<string, { id: string; name: string; size: number; isImage: boolean; mimeType: string }> => {
  const map = new Map<
    string,
    { id: string; name: string; size: number; isImage: boolean; mimeType: string }
  >();
  for (const message of session.messages) {
    if (message.role !== "user") {
      continue;
    }
    for (const file of message.files) {
      if (!map.has(file.id)) {
        map.set(file.id, {
          id: file.id,
          name: file.name,
          size: file.size,
          isImage: file.isImage,
          mimeType: file.mimeType,
        });
      }
    }
  }
  return map;
};
