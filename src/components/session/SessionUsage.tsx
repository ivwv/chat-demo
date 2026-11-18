import { useMemo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { useProviders } from '../../services/providers/store.js'
import type { Session } from '../../services/chat/types.js'
import { formatTokens } from '../../utils/tokens.js'
import styles from './SessionUsage.module.css'

/**
 * 右上角用量：显示「当前上下文」而不是把每轮输入直接累加。
 * 每轮请求的输入都带完整历史，累加会把同一段历史重复计算；
 * 最后一条回答的输入（含历史）+ 它的输出，才是模型此刻实际占用的 token。
 * 累计消耗（计费口径）放在悬停提示里备查。
 */
export const SessionUsage = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
  const stats = useMemo(() => {
    const protocolById = new Map(providers.map((provider) => [provider.id, provider.protocol]))
    let latest: { input: number; output: number } | null = null
    const total = { input: 0, output: 0, cache: 0 }
    for (const message of getVisibleMessages(session)) {
      if (message.role !== 'assistant' || !message.usage) {
        continue
      }
      const usage = message.usage
      const cached = usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      // OpenAI 的 prompt_tokens 已包含缓存命中；Anthropic 的 input_tokens 不含，需要补齐
      const input =
        protocolById.get(message.providerId ?? '') === 'anthropic'
          ? usage.input_tokens + cached
          : usage.input_tokens
      total.input += input
      total.output += usage.output_tokens
      total.cache += cached
      latest = { input, output: usage.output_tokens }
    }
    return { latest, total }
  }, [providers, session])

  if (!stats.latest) {
    return null
  }
  const context = stats.latest.input + stats.latest.output
  return (
    <div
      className={styles.usage}
      title={t('sessionUsageTitle', {
        input: stats.latest.input,
        output: stats.latest.output,
        totalInput: stats.total.input,
        totalOutput: stats.total.output,
        cache: stats.total.cache,
      })}
    >
      {t('sessionUsage', { count: formatTokens(context) })}
    </div>
  )
}
