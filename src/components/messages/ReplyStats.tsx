import { useTranslate } from '../../i18n/index.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import { formatTokens } from '../../utils/tokens.js'
import styles from './ReplyStats.module.css'

/** 速度保留一位小数，超过 100 取整，避免统计位抖动 */
const formatSpeed = (value: number) => (value >= 100 ? String(Math.round(value)) : value.toFixed(1))

const formatSeconds = (value: number) => (value >= 10 ? String(Math.round(value)) : value.toFixed(1))

/**
 * 每条回答的用量：输入、输出、缓存与平均吐字速度。
 * 数据全部来自服务端响应，插件式网关没返回的字段就不显示，不做估算。
 */
export const ReplyStats = ({ message }: { message: AssistantMessage }) => {
  const t = useTranslate()
  const usage = message.usage
  if (!usage) {
    return null
  }
  const cacheRead = usage.cache_read_input_tokens
  const cacheWrite = usage.cache_creation_input_tokens
  const cached = cacheRead + cacheWrite
  const seconds =
    message.finishedAt !== undefined && message.finishedAt > message.createdAt
      ? (message.finishedAt - message.createdAt) / 1000
      : null
  // 极短请求的耗时会取整到 0，避免除零；其余按实际情况算平均速度
  const speed =
    seconds !== null && seconds > 0.05 && usage.output_tokens > 0
      ? usage.output_tokens / seconds
      : null
  const parts = [
    t('messageStatInput', { count: formatTokens(usage.input_tokens) }),
    t('messageStatOutput', { count: formatTokens(usage.output_tokens) }),
    usage.reasoning_tokens
      ? t('messageStatReasoning', { count: formatTokens(usage.reasoning_tokens) })
      : '',
    cached > 0 ? t('messageStatCache', { count: formatTokens(cached) }) : '',
    speed !== null ? t('messageStatSpeed', { speed: formatSpeed(speed) }) : '',
  ].filter(Boolean)
  const title = t('messageStatTitle', {
    model: message.model ?? '',
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead,
    cacheWrite,
    seconds: seconds === null ? '-' : formatSeconds(seconds),
    speed: speed === null ? '-' : formatSpeed(speed),
  })
  return (
    <div className={styles.stats} title={title}>
      {parts.join(' · ')}
    </div>
  )
}
