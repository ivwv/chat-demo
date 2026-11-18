import { translate, type TranslationKey } from '../i18n/index.js'

/** 内置提示词预设：选中后作为系统提示词发给当前服务商 */
export type PromptPreset = {
  id: string
  nameKey: TranslationKey
  contentKey: TranslationKey
}

export const PROMPT_PRESETS: PromptPreset[] = [
  { id: 'general', nameKey: 'promptGeneralName', contentKey: 'promptGeneralContent' },
  { id: 'code', nameKey: 'promptCodeName', contentKey: 'promptCodeContent' },
  { id: 'review', nameKey: 'promptReviewName', contentKey: 'promptReviewContent' },
  { id: 'explain', nameKey: 'promptExplainName', contentKey: 'promptExplainContent' },
  { id: 'translate', nameKey: 'promptTranslateName', contentKey: 'promptTranslateContent' },
  { id: 'polish', nameKey: 'promptPolishName', contentKey: 'promptPolishContent' },
  { id: 'summarize', nameKey: 'promptSummarizeName', contentKey: 'promptSummarizeContent' },
]

export const getPromptPreset = (id: string): PromptPreset | null =>
  PROMPT_PRESETS.find((preset) => preset.id === id) ?? null

/** 预设内容按当前语言取，切换语言后下一次请求就生效 */
export const getPromptContent = (id: string): string => {
  const preset = getPromptPreset(id)
  return preset ? translate(preset.contentKey) : ''
}
