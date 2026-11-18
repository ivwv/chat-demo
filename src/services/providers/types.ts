/**
 * 服务商配置：一次配置可挂多个模型，请求按 protocol 分派到不同适配器。
 * 所有配置只存浏览器 localStorage，与现有「无应用后端」的架构一致。
 */

/** 请求协议：Anthropic Messages / OpenAI Chat Completions */
export type Protocol = 'anthropic' | 'openai'

/** 附件能力：none 不支持、inline 随消息内联（base64 / 文本）、filesApi 走服务端文件接口 */
export type FileMode = 'none' | 'inline' | 'filesApi'

export type ModelCapabilities = {
  /** 图片输入 */
  vision: boolean
  /** 思考 / 推理内容 */
  thinking: boolean
  /** 服务端联网搜索 */
  search: boolean
  files: FileMode
}

/** 模型的显式能力覆盖；未填写的项按模型名推断 */
export type ModelConfig = {
  id: string
  label: string
  capabilities?: Partial<ModelCapabilities>
}

/**
 * 服务商级别的附加能力，全部默认关闭：
 * serverTools 对应 DeepSeek 的 deepseek_web_search / deepseek_read_url，
 * serverTitle 对应响应里的 title 字段，latestReminder 对应 latest_reminder 角色。
 */
export type ProviderFeatures = {
  speech?: boolean
  serverTools?: boolean
  serverTitle?: boolean
  latestReminder?: boolean
  safetyCheck?: boolean
  filesApi?: boolean
  /** 流式响应里带 usage 统计（OpenAI 的 stream_options.include_usage） */
  usageChunk?: boolean
}

export type ProviderConfig = {
  id: string
  name: string
  protocol: Protocol
  /** API 根地址，到 /v1 为止，末尾不带斜杠 */
  baseUrl: string
  /**
   * 模型列表地址，缺省为 `${baseUrl}/models`。
   * DeepSeek 的 Anthropic 兼容端点不提供 /anthropic/v1/models，需要单独指向 /models。
   */
  modelsUrl?: string
  apiKey: string
  models: ModelConfig[]
  /** 追加到每个请求的请求头，高级用法（网关鉴权、组织标识等） */
  headers?: Record<string, string>
  /** 合并进请求体的额外字段，高级用法（reasoning_effort、enable_thinking 等） */
  extraBody?: Record<string, unknown>
  features?: ProviderFeatures
}

/** 新建服务商的入参：id 由 store 生成 */
export type ProviderDraft = Omit<ProviderConfig, 'id'>

const VISION_PATTERN =
  /(gpt-4o|gpt-4\.1|gpt-5|o3|o4|vision|(^|[-/])vl([-_]|$)|claude|gemini|pixtral|llava|glm-4v|internvl|qwen2?\.?5?-vl)/i

const THINKING_PATTERN = /(reason|thinking|think|(^|[-/])o[134](-|$)|(^|[-/])r1(-|$)|qwq|deepseek-v4-pro|glm-z1)/i

/**
 * 模型的实际能力：显式配置优先，其次按模型名推断，最后按服务商能力兜底。
 * 推断只是为了少让用户勾选，识别不准时可在服务商编辑里覆盖。
 */
export const getModelCapabilities = (
  provider: ProviderConfig,
  model: ModelConfig
): ModelCapabilities => {
  const files: FileMode = provider.features?.filesApi ? 'filesApi' : 'inline'
  return {
    vision: model.capabilities?.vision ?? VISION_PATTERN.test(model.id),
    thinking: model.capabilities?.thinking ?? THINKING_PATTERN.test(model.id),
    search: model.capabilities?.search ?? provider.features?.serverTools === true,
    files: model.capabilities?.files ?? files,
  }
}

export const normalizeBaseUrl = (url: string) => url.trim().replace(/\/+$/, '')

export const joinUrl = (baseUrl: string, path: string) =>
  `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`

/** 本地推理服务通常不校验 Key，允许留空 */
export const isLocalBaseUrl = (baseUrl: string) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(normalizeBaseUrl(baseUrl))

/** 服务商是否已经可以发请求：有地址、有模型、有 Key（本地服务除外） */
export const isProviderReady = (provider: ProviderConfig | null): provider is ProviderConfig =>
  provider !== null &&
  provider.baseUrl.trim() !== '' &&
  provider.models.length > 0 &&
  (provider.apiKey.trim() !== '' || isLocalBaseUrl(provider.baseUrl))
