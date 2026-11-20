import { useProviders } from './providers/store.js'
import type { ProviderConfig } from './providers/types.js'
import { readCustomPrompts, replaceCustomPrompts, type CustomPrompt } from './prompts.js'
import {
  setForceVision,
  setLocale,
  setLocation,
  setPromptId,
  setSearch,
  setSiderCollapsed,
  setSystemPrompt,
  setThemePreference,
  setThinking,
  setTitleModelKey,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from './settings.js'

const PROVIDERS_KEY = 'chat-demo:providers'
const ACTIVE_KEY = 'chat-demo:active-model'
const BACKUP_VERSION = 1

/** 导出的设置快照：服务商（含 API Key）+ 界面/模型偏好 + 自定义提示词 */
export type SettingsBackup = {
  version: number
  exportedAt: string
  providers: ProviderConfig[]
  activeModel: string | null
  settings: Record<string, unknown>
  customPrompts: unknown[]
}

const pad = (value: number) => String(value).padStart(2, '0')

const backupFileName = (date: Date) => {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}`
  return `chat-demo-settings-${day}-${time}.json`
}

/** 导出当前设置；文件含 API Key，界面上需要提示用户妥善保管 */
export const exportSettingsBackup = (): { name: string; blob: Blob } => {
  const { providers, activeKey } = useProviders.getState()
  const settings = useSettings.getState()
  const payload: SettingsBackup = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    providers,
    activeModel: activeKey,
    settings: {
      locale: settings.locale,
      themePreference: settings.themePreference,
      ttsVoice: settings.ttsVoice,
      location: settings.location,
      systemPrompt: settings.systemPrompt,
      promptId: settings.promptId,
      thinking: settings.thinking,
      search: settings.search,
      siderCollapsed: settings.siderCollapsed,
      titleModelKey: settings.titleModelKey,
      forceVision: settings.forceVision,
    },
    customPrompts: readCustomPrompts(),
  }
  return {
    name: backupFileName(new Date()),
    blob: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
  }
}

const isModel = (value: unknown) => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.label === 'string'
}

const isProvider = (value: unknown): value is ProviderConfig => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    (record.protocol === 'openai' || record.protocol === 'anthropic') &&
    typeof record.baseUrl === 'string' &&
    Array.isArray(record.models) &&
    record.models.every(isModel)
  )
}

/** 解析导入文件；结构不对或没有可用服务商时返回 null，不改动现有配置 */
export const parseSettingsBackup = (text: string): SettingsBackup | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.providers)) {
    return null
  }
  const providers = record.providers.filter(isProvider)
  if (providers.length === 0) {
    return null
  }
  return {
    version: typeof record.version === 'number' ? record.version : BACKUP_VERSION,
    exportedAt: typeof record.exportedAt === 'string' ? record.exportedAt : '',
    providers,
    activeModel: typeof record.activeModel === 'string' ? record.activeModel : null,
    settings:
      typeof record.settings === 'object' && record.settings !== null
        ? (record.settings as Record<string, unknown>)
        : {},
    customPrompts: Array.isArray(record.customPrompts) ? record.customPrompts : [],
  }
}

/** 导入方式：replace 整体替换；merge 保留本机独有的服务商/提示词，同 id 用导入值更新 */
export type SettingsImportMode = 'replace' | 'merge'

const mergeProviders = (local: ProviderConfig[], incoming: ProviderConfig[]): ProviderConfig[] => {
  const merged = new Map(local.map((provider) => [provider.id, provider]))
  for (const provider of incoming) {
    const existing = merged.get(provider.id)
    if (!existing) {
      merged.set(provider.id, provider)
      continue
    }
    // 同 id：字段取导入值，模型按 id 取并集
    const models = [...existing.models]
    for (const model of provider.models) {
      const index = models.findIndex((item) => item.id === model.id)
      if (index >= 0) {
        models[index] = model
      } else {
        models.push(model)
      }
    }
    merged.set(provider.id, { ...existing, ...provider, models })
  }
  return [...merged.values()]
}

const mergePrompts = (incoming: unknown[]): CustomPrompt[] => {
  const merged = new Map(readCustomPrompts().map((prompt) => [prompt.id, prompt]))
  for (const item of incoming) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const record = item as { id?: unknown; name?: unknown; content?: unknown }
    if (
      typeof record.id !== 'string' ||
      !record.id.startsWith('custom-') ||
      typeof record.content !== 'string'
    ) {
      continue
    }
    merged.set(record.id, {
      id: record.id,
      name: typeof record.name === 'string' ? record.name : '',
      content: record.content,
    })
  }
  return [...merged.values()]
}

/**
 * 应用导入的设置并刷新页面。
 * providers store 在模块加载时初始化，直接改内存无法让全部组件重新订阅，
 * 因此写入 localStorage 后统一 reload；设置项也一并落盘。
 * 合并模式只同步服务商与提示词，界面偏好保留本机。
 */
export const applySettingsBackup = (
  backup: SettingsBackup,
  mode: SettingsImportMode = 'replace'
) => {
  const current = useProviders.getState()
  const providers =
    mode === 'merge' ? mergeProviders(current.providers, backup.providers) : backup.providers
  const activeModel =
    mode === 'merge' ? (current.activeKey ?? backup.activeModel) : backup.activeModel
  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers))
  localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeModel))

  if (mode === 'merge') {
    replaceCustomPrompts(mergePrompts(backup.customPrompts))
    window.location.reload()
    return
  }

  const settings = backup.settings
  if (settings.locale === 'zh-CN' || settings.locale === 'en-US') {
    setLocale(settings.locale)
  }
  const theme = settings.themePreference
  if (theme === 'light' || theme === 'dark' || theme === 'system') {
    setThemePreference(theme as ThemePreference)
  }
  if (settings.ttsVoice === 'stella' || settings.ttsVoice === 'tide') {
    setTtsVoice(settings.ttsVoice)
  }
  if ('location' in settings) {
    setLocation((settings.location ?? null) as Parameters<typeof setLocation>[0])
  }
  if (typeof settings.systemPrompt === 'string') {
    setSystemPrompt(settings.systemPrompt)
  }
  if (typeof settings.promptId === 'string') {
    setPromptId(settings.promptId)
  }
  if (typeof settings.thinking === 'boolean') {
    setThinking(settings.thinking)
  }
  if (typeof settings.search === 'boolean') {
    setSearch(settings.search)
  }
  if (typeof settings.siderCollapsed === 'boolean') {
    setSiderCollapsed(settings.siderCollapsed)
  }
  if (typeof settings.titleModelKey === 'string') {
    setTitleModelKey(settings.titleModelKey)
  }
  if (typeof settings.forceVision === 'boolean') {
    setForceVision(settings.forceVision)
  }
  replaceCustomPrompts(backup.customPrompts)

  window.location.reload()
}
