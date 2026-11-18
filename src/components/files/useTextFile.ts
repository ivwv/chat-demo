import { useEffect, useState } from 'react'
import { loadFile } from '../../services/chat/db.js'
import { estimateTokens } from '../../utils/tokens.js'

/**
 * 文本附件内容按附件 id 缓存：展开原文、预览、统计 token 都读同一份。
 * 上限 32 份，超出按插入顺序淘汰，避免长会话里堆积大量原文。
 */
const CACHE_LIMIT = 32
const textCache = new Map<string, string>()
const tokenCache = new Map<string, number>()

const remember = (id: string, text: string) => {
  if (!textCache.has(id) && textCache.size >= CACHE_LIMIT) {
    const oldest = textCache.keys().next().value
    if (oldest !== undefined) {
      textCache.delete(oldest)
      tokenCache.delete(oldest)
    }
  }
  textCache.set(id, text)
  tokenCache.set(id, estimateTokens(text))
}

const readText = async (id: string) => {
  const cached = textCache.get(id)
  if (cached !== undefined) {
    return cached
  }
  const blob = await loadFile(id)
  const text = blob ? await blob.text() : ''
  remember(id, text)
  return text
}

/**
 * 读取非图片附件的文本：enabled 为 false（图片、上传中）时不读。
 * 首次读取后缓存，列表滚动不会重复解码。
 */
export const useTextFile = (id: string, enabled: boolean) => {
  const [text, setText] = useState<string | null>(() => textCache.get(id) ?? null)
  const [tokens, setTokens] = useState<number | null>(() => tokenCache.get(id) ?? null)
  useEffect(() => {
    if (!enabled) {
      return
    }
    const cached = textCache.get(id)
    if (cached !== undefined) {
      setText(cached)
      setTokens(tokenCache.get(id) ?? estimateTokens(cached))
      return
    }
    let cancelled = false
    void readText(id)
      .then((value) => {
        if (cancelled) {
          return
        }
        setText(value)
        setTokens(tokenCache.get(id) ?? estimateTokens(value))
      })
      .catch(() => {
        // 原件缺失时保持空态，卡片仍按元信息展示
      })
    return () => {
      cancelled = true
    }
  }, [id, enabled])
  return { text: textCache.get(id) ?? text, tokens: tokenCache.get(id) ?? tokens }
}

/** 草稿里的附件还没进 IndexedDB，直接从内存中的 File 读 */
export const useDraftTextFile = (id: string, file: File | null) => {
  const [tokens, setTokens] = useState<number | null>(() => tokenCache.get(id) ?? null)
  useEffect(() => {
    if (!file) {
      return
    }
    const cached = tokenCache.get(id)
    if (cached !== undefined) {
      setTokens(cached)
      return
    }
    let cancelled = false
    void file
      .text()
      .then((value) => {
        remember(id, value)
        if (!cancelled) {
          setTokens(tokenCache.get(id) ?? estimateTokens(value))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id, file])
  return tokenCache.get(id) ?? tokens
}
