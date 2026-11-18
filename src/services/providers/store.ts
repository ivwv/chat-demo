import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { createDefaultProvider } from './presets.js'
import {
  getModelCapabilities,
  isProviderReady,
  type ModelCapabilities,
  type ModelConfig,
  type Protocol,
  type ProviderConfig,
  type ProviderDraft,
} from './types.js'

const PROVIDERS_KEY = 'chat-demo:providers'
const ACTIVE_KEY = 'chat-demo:active-model'
/** 旧版本只有一个 API Key，首次启动时迁移为默认 DeepSeek 服务商 */
const LEGACY_API_KEY = 'chat-demo:api-key'

/** 当前选择的标识：`providerId::modelId`，模型 id 里可能带 `/`，用 `::` 分隔 */
const SEPARATOR = '::'

const readString = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const removeKey = (key: string) => {
  try {
    localStorage.removeItem(key)
  } catch {
    // 存储不可用时只在内存中生效
  }
}

const readJson = (key: string): unknown => {
  const raw = readString(key)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const writeJson = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储不可用时只在内存中生效
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const normalizeProtocol = (value: unknown): Protocol =>
  value === 'anthropic' ? 'anthropic' : 'openai'

const normalizeModel = (value: unknown): ModelConfig | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) {
    return null
  }
  const id = value.id.trim()
  const caps = isRecord(value.capabilities) ? value.capabilities : undefined
  const capabilities: ModelConfig['capabilities'] = {}
  if (typeof caps?.vision === 'boolean') {
    capabilities.vision = caps.vision
  }
  if (typeof caps?.thinking === 'boolean') {
    capabilities.thinking = caps.thinking
  }
  if (typeof caps?.search === 'boolean') {
    capabilities.search = caps.search
  }
  if (caps?.files === 'none' || caps?.files === 'inline' || caps?.files === 'filesApi') {
    capabilities.files = caps.files
  }
  return {
    id,
    label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : id,
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
  }
}

const normalizeStringMap = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const entries = Object.entries(value).flatMap(([key, item]) =>
    typeof item === 'string' ? [[key, item] as const] : []
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/** 只接受结构完整的服务商，损坏的条目直接丢弃，避免半个配置把界面打崩 */
const normalizeProvider = (value: unknown): ProviderConfig | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    return null
  }
  const models = Array.isArray(value.models)
    ? value.models.flatMap((item) => {
        const model = normalizeModel(item)
        return model ? [model] : []
      })
    : []
  if (models.length === 0) {
    return null
  }
  const features = isRecord(value.features) ? value.features : {}
  const pick = (key: keyof typeof features) => (features[key] === true ? true : undefined)
  return {
    id: value.id,
    name:
      typeof value.name === 'string' && value.name.trim() ? value.name.trim() : '未命名服务商',
    protocol: normalizeProtocol(value.protocol),
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '',
    ...(typeof value.modelsUrl === 'string' && value.modelsUrl.trim()
      ? { modelsUrl: value.modelsUrl.trim() }
      : {}),
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
    models,
    headers: normalizeStringMap(value.headers),
    extraBody: isRecord(value.extraBody) ? value.extraBody : undefined,
    features: {
      speech: pick('speech'),
      serverTools: pick('serverTools'),
      serverTitle: pick('serverTitle'),
      latestReminder: pick('latestReminder'),
      safetyCheck: pick('safetyCheck'),
      filesApi: pick('filesApi'),
      usageChunk: pick('usageChunk'),
    },
  }
}

const splitKey = (key: string) => {
  const at = key.indexOf(SEPARATOR)
  return at === -1 ? null : { providerId: key.slice(0, at), modelId: key.slice(at + SEPARATOR.length) }
}

const findByKey = (providers: ProviderConfig[], key: string) => {
  const parsed = splitKey(key)
  if (!parsed) {
    return null
  }
  const provider = providers.find((item) => item.id === parsed.providerId)
  const model = provider?.models.find((item) => item.id === parsed.modelId)
  return provider && model ? { provider, model } : null
}

/** 选中项失效时（删除服务商 / 模型）退回第一个可用组合 */
const firstKey = (providers: ProviderConfig[]) => {
  const provider = providers.find((item) => item.models.length > 0)
  return provider ? `${provider.id}${SEPARATOR}${provider.models[0].id}` : null
}

const loadInitial = (): { providers: ProviderConfig[]; activeKey: string | null } => {
  const stored = readJson(PROVIDERS_KEY)
  let providers = Array.isArray(stored)
    ? stored.flatMap((item) => {
        const provider = normalizeProvider(item)
        return provider ? [provider] : []
      })
    : []
  if (providers.length === 0) {
    const legacyKey = readString(LEGACY_API_KEY)?.trim() ?? ''
    const draft = createDefaultProvider(legacyKey)
    providers = [{ ...draft, id: createId() }]
    writeJson(PROVIDERS_KEY, providers)
    if (legacyKey) {
      removeKey(LEGACY_API_KEY)
    }
  }
  const storedActiveRaw = readJson(ACTIVE_KEY)
  const storedActive = typeof storedActiveRaw === 'string' ? storedActiveRaw : null
  const activeKey =
    storedActive && findByKey(providers, storedActive) ? storedActive : firstKey(providers)
  if (activeKey && activeKey !== storedActive) {
    writeJson(ACTIVE_KEY, activeKey)
  }
  return { providers, activeKey }
}

type ProvidersState = {
  providers: ProviderConfig[]
  /** `providerId::modelId`，null 表示没有可用模型 */
  activeKey: string | null
}

const initial = loadInitial()

export const useProviders = create<ProvidersState>(() => initial)

const commit = (next: ProvidersState) => {
  useProviders.setState(next)
  writeJson(PROVIDERS_KEY, next.providers)
  writeJson(ACTIVE_KEY, next.activeKey)
}

export const getProvider = (id: string | null | undefined) =>
  id ? (useProviders.getState().providers.find((item) => item.id === id) ?? null) : null

export const getActiveSelection = (): { provider: ProviderConfig; model: ModelConfig } | null => {
  const { providers, activeKey } = useProviders.getState()
  return activeKey ? findByKey(providers, activeKey) : null
}

export const getActiveProvider = () => getActiveSelection()?.provider ?? null

/** 按消息里记录的组合找服务商与模型，已被删除时退回当前选择 */
export const resolveSelection = (
  providerId?: string | null,
  modelId?: string | null
): { provider: ProviderConfig; model: ModelConfig } | null => {
  const provider = getProvider(providerId)
  if (provider) {
    const model = provider.models.find((item) => item.id === modelId) ?? provider.models[0]
    if (model) {
      return { provider, model }
    }
  }
  return getActiveSelection()
}

export const getCapabilities = (
  selection = getActiveSelection()
): ModelCapabilities | null => (selection ? getModelCapabilities(selection.provider, selection.model) : null)

export const setActiveKey = (key: string) => {
  const { providers } = useProviders.getState()
  if (findByKey(providers, key)) {
    commit({ providers, activeKey: key })
  }
}

export const addProvider = (draft: ProviderDraft): string => {
  const id = createId()
  const { providers, activeKey } = useProviders.getState()
  const next = [...providers, { ...draft, id }]
  const model = draft.models[0]
  commit({
    providers: next,
    activeKey: activeKey ?? (model ? `${id}${SEPARATOR}${model.id}` : null),
  })
  return id
}

export const updateProvider = (id: string, patch: Partial<ProviderDraft>) => {
  const { providers, activeKey } = useProviders.getState()
  const next = providers.map((item) => (item.id === id ? { ...item, ...patch, id } : item))
  const stillValid = activeKey ? findByKey(next, activeKey) : null
  commit({ providers: next, activeKey: stillValid ? activeKey : (activeKey ? firstKey(next) : activeKey) })
}

/** 至少保留一个服务商，避免界面进入没有模型可选的状态 */
export const removeProvider = (id: string) => {
  const { providers, activeKey } = useProviders.getState()
  if (providers.length <= 1) {
    return
  }
  const next = providers.filter((item) => item.id !== id)
  const parsed = activeKey ? splitKey(activeKey) : null
  commit({
    providers: next,
    activeKey: parsed?.providerId === id || !activeKey ? firstKey(next) : activeKey,
  })
}

/** 当前选中的服务商是否可用，不可用时界面负责跳转到设置 */
export const hasUsableProvider = () => isProviderReady(getActiveProvider())

/** 组件用：当前选中的服务商 */
export const useActiveProvider = () =>
  useProviders((state) => {
    const parsed = state.activeKey ? splitKey(state.activeKey) : null
    return parsed ? (state.providers.find((item) => item.id === parsed.providerId) ?? null) : null
  })

/** 组件用：全部可选模型，按服务商分组展开成一维列表 */
export const useModelOptions = () =>
  useProviders((state) =>
    state.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        key: `${provider.id}${SEPARATOR}${model.id}`,
        providerName: provider.name,
        modelLabel: model.label,
      }))
    )
  )
