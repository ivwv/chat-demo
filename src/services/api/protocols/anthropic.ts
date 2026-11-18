import { normalizeBaseUrl, type ProviderConfig } from '../../providers/types.js'
import { ApiError, providerHeaders, providerUrl, readErrorResponse, request } from '../client.js'
import { readMessageEvent } from '../parseEvent.js'
import { readServerSentEvents } from '../sse.js'
import type { CreateMessageRequest, MessageParam, MessageStreamEvent } from '../types.js'

/** 一轮对话的输入：与具体协议无关，由各适配器翻译成自己的请求体 */
export type ChatRequest = {
  system: string
  messages: MessageParam[]
  thinking: boolean
  search: boolean
  /** 请求服务端顺带生成会话标题（仅声明了 serverTitle 的服务商） */
  title?: boolean
  maxTokens?: number
}

/** Anthropic 官方接口需要 max_tokens，且思考预算必须小于它 */
const NATIVE_MAX_TOKENS = 8192
const NATIVE_THINKING_BUDGET = 4096

/** 官方接口与第三方兼容实现的差异集中在少数几个字段上 */
const isNativeAnthropic = (provider: ProviderConfig) =>
  /^https:\/\/api\.anthropic\.com(\/|$)/i.test(normalizeBaseUrl(provider.baseUrl))

/** 联网与读链工具是 DeepSeek 的服务端扩展，只在声明了 serverTools 时下发 */
const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: NonNullable<CreateMessageRequest['tools']> = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

export const buildAnthropicBody = (
  provider: ProviderConfig,
  model: string,
  req: ChatRequest
): Record<string, unknown> => {
  const native = isNativeAnthropic(provider)
  const body: Record<string, unknown> = {
    model,
    system: req.system,
    messages: req.messages,
  }
  if (provider.features?.safetyCheck) {
    body.safety_check = { level: 'high' }
  }
  if (provider.features?.serverTools) {
    body.tools = serverTools(req.search)
  }
  if (req.title && provider.features?.serverTitle) {
    body.title = { enabled: true }
  }
  if (req.thinking) {
    body.thinking = native
      ? { type: 'enabled', budget_tokens: NATIVE_THINKING_BUDGET }
      : { type: 'enabled' }
  } else if (!native) {
    // DeepSeek 兼容实现用 disabled 明确关闭；官方老模型不认识该字段，干脆不发
    body.thinking = { type: 'disabled' }
  }
  if (native) {
    body.max_tokens = req.maxTokens ?? NATIVE_MAX_TOKENS
  } else if (req.maxTokens) {
    body.max_tokens = req.maxTokens
  }
  return { ...body, ...provider.extraBody }
}

/**
 * POST /messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamAnthropic(
  provider: ProviderConfig,
  model: string,
  req: ChatRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(providerUrl(provider, '/messages'), {
    method: 'POST',
    headers: providerHeaders(provider, {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }),
    body: JSON.stringify({ ...buildAnthropicBody(provider, model, req), stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof (payload as { error?: { message?: unknown } }).error?.message === 'string'
    ) {
      throw new ApiError('stream', (payload as { error: { message: string } }).error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
