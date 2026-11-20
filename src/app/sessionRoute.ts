/**
 * 会话地址：`#/chat/<sessionId>`。
 * 用 hash 而不是路径，静态托管刷新时不会 404；切换会话时用 replaceState 不产生历史记录。
 */
const HASH_PREFIX = '#/chat/'

export const readSessionIdFromUrl = (): string | null => {
  const hash = window.location.hash
  if (!hash.startsWith(HASH_PREFIX)) {
    return null
  }
  const id = decodeURIComponent(hash.slice(HASH_PREFIX.length)).trim()
  return id || null
}

export const writeSessionIdToUrl = (id: string | null) => {
  const base = `${window.location.pathname}${window.location.search}`
  const next = id ? `${base}${HASH_PREFIX}${encodeURIComponent(id)}` : base
  if (`${base}${window.location.hash}` === next) {
    return
  }
  window.history.replaceState(null, '', next)
}
