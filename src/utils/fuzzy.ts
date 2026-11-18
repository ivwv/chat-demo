/**
 * 模糊匹配：先按子串命中打分（越靠前分越高），没命中再退回「按顺序出现的字符」。
 * 分数越高排序越靠前，返回 -1 表示不匹配。
 */
export const fuzzyScore = (query: string, text: string): number => {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return 0
  }
  const haystack = text.toLowerCase()
  const direct = haystack.indexOf(needle)
  if (direct >= 0) {
    // 前缀命中比中间命中更相关
    return (direct === 0 ? 2000 : 1000) - direct
  }
  let score = 0
  let cursor = 0
  for (const char of needle) {
    if (char === ' ') {
      continue
    }
    const at = haystack.indexOf(char, cursor)
    if (at < 0) {
      return -1
    }
    // 连续命中给更高权重，避免「dc」优先匹配到相隔很远的字符
    score += at === cursor ? 4 : 1
    cursor = at + 1
  }
  return score
}
