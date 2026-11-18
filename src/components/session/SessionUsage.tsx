import { useMemo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import type { Session } from '../../services/chat/types.js'
import { formatTokens } from '../../utils/tokens.js'
import styles from './SessionUsage.module.css'

/**
 * 当前会话累计用量：只统计当前分支上的回答，切换版本后跟着变。
 * 输入按每次请求累加（包含重复发送的上下文），与实际计费口径一致。
 */
export const SessionUsage = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const totals = useMemo(() => {
    const sum = { input: 0, output: 0, cache: 0 }
    for (const message of getVisibleMessages(session)) {
      if (message.role !== 'assistant' || !message.usage) {
        continue
      }
      sum.input += message.usage.input_tokens
      sum.output += message.usage.output_tokens
      sum.cache +=
        message.usage.cache_read_input_tokens + message.usage.cache_creation_input_tokens
    }
    return sum
  }, [session])

  const total = totals.input + totals.output
  if (total === 0) {
    return null
  }
  return (
    <div
      className={styles.usage}
      title={t('sessionUsageTitle', {
        input: totals.input,
        output: totals.output,
        cache: totals.cache,
      })}
    >
      {t('sessionUsage', { count: formatTokens(total) })}
    </div>
  )
}
