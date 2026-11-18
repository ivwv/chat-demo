/**
 * token 估算：CJK 约 1 字 1 token，其余按 3.5 字符 1 token。
 * 只用于界面上提示「大概多长」，真实用量以服务端返回的 usage 为准。
 */
const CJK_PATTERN = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g

export const estimateTokens = (text: string): number => {
  if (!text) {
    return 0
  }
  const cjk = text.match(CJK_PATTERN)?.length ?? 0
  return Math.ceil(cjk + (text.length - cjk) / 3.5)
}

/** 统计位空间有限：1234 → 1.2K，12345 → 12K，1234567 → 1.2M */
export const formatTokens = (count: number): string => {
  if (!Number.isFinite(count) || count <= 0) {
    return '0'
  }
  if (count < 1000) {
    return String(Math.round(count))
  }
  if (count < 1_000_000) {
    return `${formatScaled(count / 1000)}K`
  }
  return `${formatScaled(count / 1_000_000)}M`
}

const formatScaled = (value: number) =>
  value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
