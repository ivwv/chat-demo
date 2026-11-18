import { translate, type TranslationMessage } from '../../i18n/index.js'
import { joinUrl, normalizeBaseUrl, type ProviderConfig } from '../providers/types.js'
import type { ApiErrorBody, FileObject, FilePurpose } from './types.js'

/** Anthropic 兼容接口在引用 Files API 上传的文件时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'
/** Anthropic 官方接口的版本头，第三方兼容实现通常忽略 */
const ANTHROPIC_VERSION = '2023-06-01'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

export const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

/**
 * 鉴权头按协议区分：
 * - Anthropic 用 x-api-key；官方域名额外带直连浏览器所需的头
 * - OpenAI 用 Authorization: Bearer
 * 用户自定义头最后覆盖，便于接入只认特定头的网关。
 */
const authHeaders = (provider: ProviderConfig): Record<string, string> => {
  const apiKey = provider.apiKey.trim()
  if (provider.protocol === 'anthropic') {
    return {
      'anthropic-version': ANTHROPIC_VERSION,
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...(/^https:\/\/api\.anthropic\.com(\/|$)/i.test(normalizeBaseUrl(provider.baseUrl))
        ? { 'anthropic-dangerous-direct-browser-access': 'true' }
        : {}),
    }
  }
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

export const providerHeaders = (
  provider: ProviderConfig,
  extra?: Record<string, string>
): Record<string, string> => ({
  ...authHeaders(provider),
  ...provider.headers,
  ...extra,
})

export const providerUrl = (provider: ProviderConfig, path: string) =>
  joinUrl(provider.baseUrl, path)

/** GET /models：用于连通性测试与拉取模型列表，不产生推理费用 */
export const fetchModels = async (
  provider: ProviderConfig,
  signal?: AbortSignal
): Promise<string[]> => {
  const headers = providerHeaders(provider)
  // 单独指定了模型地址（如 DeepSeek 的 /models）时按 Bearer 鉴权，与官方示例一致
  if (provider.modelsUrl && provider.apiKey.trim() && provider.protocol === 'anthropic') {
    headers.Authorization = `Bearer ${provider.apiKey.trim()}`
  }
  const response = await request(provider.modelsUrl ?? providerUrl(provider, '/models'), {
    method: 'GET',
    headers,
    signal,
  })
  const body: unknown = await response.json()
  const list = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : typeof body === 'object' &&
          body !== null &&
          Array.isArray((body as { models?: unknown }).models)
        ? (body as { models: unknown[] }).models
        : []
  return [
    ...new Set(
      list.flatMap((item) => {
        if (typeof item === 'string') {
          return [item]
        }
        if (typeof item !== 'object' || item === null) {
          return []
        }
        const record = item as { id?: unknown; name?: unknown }
        // Gemini 的 name 形如 models/gemini-2.5-pro
        const id =
          typeof record.id === 'string'
            ? record.id
            : typeof record.name === 'string'
              ? record.name.replace(/^models\//, '')
              : ''
        return id ? [id] : []
      })
    ),
  ]
}

/** 兼容旧调用：只校验 Key 是否可用 */
export const verifyProvider = (provider: ProviderConfig, signal?: AbortSignal): Promise<void> =>
  fetchModels(provider, signal).then(() => undefined)

/** POST /files：仅声明了 filesApi 能力的服务商使用（目前为 DeepSeek） */
export const uploadFile = async (
  provider: ProviderConfig,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(providerUrl(provider, '/files'), {
    method: 'POST',
    headers: providerHeaders(provider, { 'anthropic-beta': FILES_BETA }),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

export const deleteFile = async (provider: ProviderConfig, fileId: string): Promise<void> => {
  await request(providerUrl(provider, `/files/${encodeURIComponent(fileId)}`), {
    method: 'DELETE',
    headers: providerHeaders(provider, { 'anthropic-beta': FILES_BETA }),
  })
}
