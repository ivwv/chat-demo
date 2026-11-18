import type { ProviderConfig } from '../providers/types.js'
import type { MessageStreamEvent } from './types.js'
import { streamAnthropic, type ChatRequest } from './protocols/anthropic.js'
import { streamOpenAI } from './protocols/openai.js'

export type { ChatRequest }

/** 按服务商声明的协议分派，产出统一的内部流式事件 */
export const streamChat = (
  provider: ProviderConfig,
  model: string,
  request: ChatRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> =>
  provider.protocol === 'openai'
    ? streamOpenAI(provider, model, request, signal)
    : streamAnthropic(provider, model, request, signal)
