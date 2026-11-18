import type { ProviderConfig } from '../../providers/types.js'
import { ApiError, providerHeaders, providerUrl, readErrorResponse, request } from '../client.js'
import { readServerSentEvents } from '../sse.js'
import type {
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
} from '../types.js'
import type { ChatRequest } from './anthropic.js'

type OpenAIPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | OpenAIPart[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** 兼容 content 为字符串或 [{type:'text',text}] 两种写法 */
const textOf = (content: unknown): string => {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part
      }
      return isRecord(part) && typeof part.text === 'string' ? part.text : ''
    })
    .join('')
}

/** 各家推理字段名不统一，按常见顺序探测，取到第一个非空字符串 */
const reasoningOf = (value: unknown): string => {
  if (!isRecord(value)) {
    return ''
  }
  for (const key of ['reasoning_content', 'reasoning', 'thinking_content', 'thinking']) {
    const field = value[key]
    if (typeof field === 'string' && field) {
      return field
    }
    if (isRecord(field) && typeof field.text === 'string' && field.text) {
      return field.text
    }
  }
  return ''
}

/** 把内部消息转成 Chat Completions 的 messages；history 里的 latest_reminder 是 DeepSeek 扩展，跳过 */
const toOpenAIMessages = (system: string, messages: MessageParam[]): OpenAIMessage[] => {
  const result: OpenAIMessage[] = []
  if (system.trim()) {
    result.push({ role: 'system', content: system })
  }
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      continue
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        result.push({ role: 'user', content: message.content })
        continue
      }
      const parts: OpenAIPart[] = []
      for (const block of message.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'image' && block.source.type === 'base64') {
          // 图片内联成 data URL，是 Chat Completions 唯一跨厂商通用的图片入参
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          })
        } else {
          // file / document 块来自 Files API，只有声明了 filesApi 的服务商能接受
          throw new ApiError('protocol', { key: 'replyAttachmentUnsupported' })
        }
      }
      result.push({
        role: 'user',
        content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
      })
      continue
    }
    // 历史思考、工具块不回传，只保留正文；空正文的回复整条丢弃
    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
    if (text.trim()) {
      result.push({ role: 'assistant', content: text })
    }
  }
  return result
}

const STOP_REASONS: Record<string, StopReason> = {
  stop: 'end_turn',
  end_turn: 'end_turn',
  length: 'max_tokens',
  max_tokens: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
}

const toStopReason = (value: unknown): StopReason =>
  (typeof value === 'string' ? STOP_REASONS[value] : undefined) ?? 'end_turn'

const toUsage = (value: unknown): MessageUsage | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const promptDetails = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : null
  const completionDetails = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : null
  const usage: MessageUsage = {
    input_tokens: number(value.prompt_tokens ?? value.input_tokens),
    // OpenAI 走 prompt_tokens_details.cached_tokens，DeepSeek 走 prompt_cache_hit_tokens
    cache_read_input_tokens: number(
      promptDetails?.cached_tokens ?? value.prompt_cache_hit_tokens
    ),
    cache_creation_input_tokens: number(promptDetails?.cache_write_tokens),
    output_tokens: number(value.completion_tokens ?? value.output_tokens),
  }
  const reasoning = number(completionDetails?.reasoning_tokens)
  if (reasoning > 0) {
    usage.reasoning_tokens = reasoning
  }
  return usage
}

const buildBody = (provider: ProviderConfig, model: string, req: ChatRequest) => ({
  model,
  messages: toOpenAIMessages(req.system, req.messages),
  stream: true,
  ...(provider.features?.usageChunk ? { stream_options: { include_usage: true } } : {}),
  ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
  ...provider.extraBody,
})

/** 非流式响应（部分网关忽略 stream）也要能读出内容，避免直接报协议错误 */
const readCompletion = (
  payload: unknown,
  model: string
): { events: MessageStreamEvent[]; stopReason: StopReason; usage?: MessageUsage } => {
  const events: MessageStreamEvent[] = [
    { type: 'message_start', message: { id: `chatcmpl-${Date.now()}`, model } },
  ]
  const choice =
    isRecord(payload) && Array.isArray(payload.choices) && isRecord(payload.choices[0])
      ? payload.choices[0]
      : null
  const message = choice && isRecord(choice.message) ? choice.message : null
  const reasoning = reasoningOf(message)
  const text = textOf(message?.content)
  let index = 0
  if (reasoning) {
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    })
    events.push({
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking: reasoning },
    })
    events.push({ type: 'content_block_stop', index })
    index += 1
  }
  if (text) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
    events.push({ type: 'content_block_stop', index })
  }
  return {
    events,
    stopReason: toStopReason(choice?.finish_reason),
    usage: isRecord(payload) ? toUsage(payload.usage) : undefined,
  }
}

/**
 * POST /chat/completions（stream: true）。
 * 覆盖所有 OpenAI 兼容服务商：正文取 delta.content，推理取 reasoning_content / reasoning，
 * 结束原因由 finish_reason 映射到内部 stop_reason，收到 [DONE] 或流结束时补齐收尾事件。
 */
export async function* streamOpenAI(
  provider: ProviderConfig,
  model: string,
  req: ChatRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(providerUrl(provider, '/chat/completions'), {
    method: 'POST',
    headers: providerHeaders(provider, {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }),
    body: JSON.stringify(buildBody(provider, model, req)),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  if (!contentType.includes('text/event-stream')) {
    const payload: unknown = await response.json().catch(() => null)
    if (!isRecord(payload) || !Array.isArray(payload.choices)) {
      throw new ApiError('protocol', '')
    }
    const completion = readCompletion(payload, model)
    for (const event of completion.events) {
      yield event
    }
    yield {
      type: 'message_delta',
      delta: { stop_reason: completion.stopReason, stop_sequence: null },
      usage: completion.usage,
    }
    yield { type: 'message_stop' }
    return
  }

  const responseId = `chatcmpl-${Date.now()}`
  yield { type: 'message_start', message: { id: responseId, model } }

  let nextIndex = 0
  let current: { index: number; kind: 'text' | 'thinking' } | null = null
  let stopReason: StopReason = 'end_turn'
  let usage: MessageUsage | undefined

  for await (const { data } of readServerSentEvents(response.body, signal)) {
    const payloadText = data.trim()
    if (!payloadText) {
      continue
    }
    if (payloadText === '[DONE]') {
      break
    }
    let payload: unknown
    try {
      payload = JSON.parse(payloadText)
    } catch {
      continue
    }
    if (isRecord(payload) && payload.error !== undefined) {
      const error = payload.error
      throw new ApiError(
        'stream',
        isRecord(error) && typeof error.message === 'string'
          ? error.message
          : typeof error === 'string'
            ? error
            : JSON.stringify(error)
      )
    }
    if (!isRecord(payload) || !Array.isArray(payload.choices)) {
      // 有些服务商把用量单独放在最后一帧，没有 choices
      usage = toUsage(payload && isRecord(payload) ? payload.usage : undefined) ?? usage
      continue
    }
    const choice = isRecord(payload.choices[0]) ? payload.choices[0] : null
    const delta = choice && isRecord(choice.delta) ? choice.delta : null
    if (choice?.finish_reason) {
      stopReason = toStopReason(choice.finish_reason)
    }
    usage = toUsage(payload.usage) ?? usage
    if (!delta) {
      continue
    }
    const reasoning = reasoningOf(delta)
    if (reasoning) {
      if (current?.kind !== 'thinking') {
        if (current) {
          yield { type: 'content_block_stop', index: current.index }
        }
        current = { index: nextIndex++, kind: 'thinking' }
        yield {
          type: 'content_block_start',
          index: current.index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index: current.index,
        delta: { type: 'thinking_delta', thinking: reasoning },
      }
    }
    const text = textOf(delta.content)
    if (text) {
      if (current?.kind !== 'text') {
        if (current) {
          yield { type: 'content_block_stop', index: current.index }
        }
        current = { index: nextIndex++, kind: 'text' }
        yield {
          type: 'content_block_start',
          index: current.index,
          content_block: { type: 'text', text: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index: current.index,
        delta: { type: 'text_delta', text },
      }
    }
  }

  if (current) {
    yield { type: 'content_block_stop', index: current.index }
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  }
  yield { type: 'message_stop' }
}
