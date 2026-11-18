import clsx from 'clsx'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconCheckOutline16, IconPromptOutline16 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { findPrompt, listPrompts, useCustomPrompts } from '../../services/prompts.js'
import { setPromptId, useSettings } from '../../services/settings.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './PromptPicker.module.css'

/**
 * 提示词切换：选中的预设会作为系统提示词随每次请求发送，
 * 与「深度思考」「智能搜索」并排放在输入框底部。自定义提示词在「设置 › 提示词」里维护。
 */
export const PromptPicker = ({
  labelClassName,
}: {
  /** 窄屏折叠文字时复用输入框的样式类 */
  labelClassName?: string
}) => {
  const t = useTranslate()
  const promptId = useSettings((state) => state.promptId)
  // 设置里增删改自定义提示词后，这里的列表要跟着变
  useCustomPrompts((state) => state.prompts)
  const [open, setOpen] = useState(false)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { side: 'top', align: 'start', maxHeight: 400, minSpace: 200 })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  const active = findPrompt(promptId)
  const options = [{ id: '', name: t('promptNone'), content: '', builtin: true }, ...listPrompts()]

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, active && styles.triggerActive)}
        aria-label={t('promptLabel')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconPromptOutline16 />
        <span className={labelClassName ?? styles.label}>
          {active ? active.name : t('promptLabel')}
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.menu}
              style={position ?? undefined}
              role="menu"
            >
              <div className={styles.list}>
                {options.map((option) => {
                  const selected = option.id === promptId
                  return (
                    <button
                      key={option.id || 'none'}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className={clsx(styles.option, selected && styles.optionSelected)}
                      onClick={() => {
                        setPromptId(option.id)
                        setOpen(false)
                      }}
                    >
                      <span className={styles.optionHead}>
                        <span className={styles.optionName}>{option.name}</span>
                        {option.builtin ? null : (
                          <span className={styles.optionTag}>{t('promptCustomTag')}</span>
                        )}
                        {selected ? <IconCheckOutline16 /> : null}
                      </span>
                      {option.content ? (
                        <span className={styles.optionText}>{option.content}</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
              <button
                type="button"
                className={styles.manage}
                onClick={() => {
                  setOpen(false)
                  openSettings('prompts')
                }}
              >
                {t('promptManage')}
              </button>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
