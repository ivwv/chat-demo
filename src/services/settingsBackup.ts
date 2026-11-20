import { useProviders } from './providers/store.js'
import type { ProviderConfig } from './providers/types.js'
import { readCustomPrompts, replaceCustomPrompts } from './prompts.js'
import {
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

/**
 * 应用导入的设置并刷新页面。
 * providers store 在模块加载时初始化，直接改内存无法让全部组件重新订阅，
 * 因此写入 localStorage 后统一 reload；设置项也一并落盘。
 */
export const applySettingsBackup = (backup: SettingsBackup) => {
  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(backup.providers))
  localStorage.setItem(ACTIVE_KEY, JSON.stringify(backup.activeModel))

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
  replaceCustomPrompts(backup.customPrompts)

  window.location.reload()
}
