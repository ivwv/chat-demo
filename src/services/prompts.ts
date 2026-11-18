import { create } from 'zustand'
import { translate, type TranslationKey } from '../i18n/index.js'
import { createId } from '../utils/id.js'
import { setPromptId, useSettings } from './settings.js'

/** 内置提示词：内容随语言切换，不能修改或删除，可以复制成自定义项再改 */
type BuiltinPrompt = { id: string; nameKey: TranslationKey; contentKey: TranslationKey }

const BUILTIN_PROMPTS: BuiltinPrompt[] = [
  { id: 'general', nameKey: 'promptGeneralName', contentKey: 'promptGeneralContent' },
  { id: 'code', nameKey: 'promptCodeName', contentKey: 'promptCodeContent' },
  { id: 'review', nameKey: 'promptReviewName', contentKey: 'promptReviewContent' },
  { id: 'explain', nameKey: 'promptExplainName', contentKey: 'promptExplainContent' },
  { id: 'translate', nameKey: 'promptTranslateName', contentKey: 'promptTranslateContent' },
  { id: 'polish', nameKey: 'promptPolishName', contentKey: 'promptPolishContent' },
  { id: 'summarize', nameKey: 'promptSummarizeName', contentKey: 'promptSummarizeContent' },
]

/** 提示词在界面上的统一形态：内置项翻译后与自定义项同形，列表与选择器只认这一种 */
export type PromptOption = {
  id: string
  name: string
  content: string
  /** 内置项只读 */
  builtin: boolean
}

export type CustomPrompt = { id: string; name: string; content: string }

export type CustomPromptDraft = { name: string; content: string }

const STORAGE_KEY = 'chat-demo:custom-prompts'
/** 自定义项的 id 前缀，避免与内置项的固定 id 撞车 */
const CUSTOM_PREFIX = 'custom-'

const read = (): CustomPrompt[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.flatMap((item): CustomPrompt[] => {
      if (typeof item !== 'object' || item === null) {
        return []
      }
      const record = item as { id?: unknown; name?: unknown; content?: unknown }
      if (
        typeof record.id !== 'string' ||
        !record.id.startsWith(CUSTOM_PREFIX) ||
        typeof record.content !== 'string'
      ) {
        return []
      }
      return [
        {
          id: record.id,
          name: typeof record.name === 'string' ? record.name : '',
          content: record.content,
        },
      ]
    })
  } catch {
    // 存储不可用或内容损坏时按空列表处理，不影响内置提示词
    return []
  }
}

const write = (prompts: CustomPrompt[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts))
  } catch {
    // 存储不可用时只在本次页面生效
  }
}

/** 自定义提示词列表，组件通过它订阅增删改 */
export const useCustomPrompts = create<{ prompts: CustomPrompt[] }>(() => ({ prompts: read() }))

const commit = (prompts: CustomPrompt[]) => {
  write(prompts)
  useCustomPrompts.setState({ prompts })
}

/** 内置 + 自定义；调用方订阅 useCustomPrompts 后即可在增删改时重新渲染 */
export const listPrompts = (): PromptOption[] => [
  ...BUILTIN_PROMPTS.map((preset) => ({
    id: preset.id,
    name: translate(preset.nameKey),
    content: translate(preset.contentKey),
    builtin: true,
  })),
  ...useCustomPrompts.getState().prompts.map((prompt) => ({
    id: prompt.id,
    name: prompt.name || translate('promptUntitled'),
    content: prompt.content,
    builtin: false,
  })),
]

export const findPrompt = (id: string): PromptOption | null =>
  id ? (listPrompts().find((prompt) => prompt.id === id) ?? null) : null

/** 选中的提示词内容按当前语言取，切换语言后下一次请求就生效 */
export const getPromptContent = (id: string): string => findPrompt(id)?.content ?? ''

export const addCustomPrompt = (draft: CustomPromptDraft): string => {
  const id = `${CUSTOM_PREFIX}${createId()}`
  commit([
    ...useCustomPrompts.getState().prompts,
    {
      id,
      name: draft.name.trim() || translate('promptUntitled'),
      content: draft.content.trim(),
    },
  ])
  return id
}

export const updateCustomPrompt = (id: string, draft: CustomPromptDraft) =>
  commit(
    useCustomPrompts.getState().prompts.map((prompt) =>
      prompt.id === id
        ? {
            ...prompt,
            name: draft.name.trim() || translate('promptUntitled'),
            content: draft.content.trim(),
          }
        : prompt
    )
  )

/** 删除后如果正被使用，回到「不使用预设」的状态 */
export const removeCustomPrompt = (id: string) => {
  commit(useCustomPrompts.getState().prompts.filter((prompt) => prompt.id !== id))
  if (useSettings.getState().promptId === id) {
    setPromptId('')
  }
}
