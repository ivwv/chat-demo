import clsx from 'clsx'
import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  IconGlobeLanguageOutline14,
  IconPaperclipOutline16,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline14,
} from '../base/icons.js'
import { setSearch, setThinking, useSettings } from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  expandDraftAttachment,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import {
  getActiveFileMode,
  getActiveProvider,
  setActiveKey,
  useCapability,
  useProviders,
} from '../../services/providers/store.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { IconButton } from '../base/IconButton.js'
import { Tooltip } from '../base/Tooltip.js'
import { ensureProvider } from '../settings/settingsDialogState.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { ModelPicker } from './ModelPicker.js'
import { showToast } from '../base/toastState.js'
import { ACCEPT, PASTE_AS_FILE_TOKENS, useUploads } from '../../services/attachments.js'
import { estimateTokens } from '../../utils/tokens.js'
import { DraftAttachments } from './DraftAttachments.js'
import { PromptPicker } from './PromptPicker.js'
import { useVoiceInput } from './useVoiceInput.js'
import { VoiceButton } from './VoiceButton.js'
import { Spectrum } from './Spectrum.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ChatInput.module.css'

/** 输入框：自适应高度的文本框 + 文件 + 深度思考、智能搜索与提示词切换 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

/**
 * 用首行给粘贴内容起个像文件的名字，方便在附件卡片上认出来。
 * 只取第一行并去掉 Markdown 标记，不对内容做字数截断——卡片上的省略号只是显示效果。
 */
const pasteFileName = (text: string, fallback: string) => {
  const firstLine =
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  const name = firstLine
    .replace(/^[#>\-*\s]+/, '')
    .replace(/[*_`]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
  return `${name || fallback}.txt`
}

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useSettings((state) => state.thinking)
  const activeKey = useProviders((state) => state.activeKey)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const search = useSettings((state) => state.search)
  // 能力位跟随当前模型：不支持的开关直接禁用，避免用户以为开了就生效；
  // 还没配置服务商时（null）不禁用，先让用户被引导去设置
  const canThink = useCapability('thinking') !== false
  const canSearch = useCapability('search') !== false
  // 语音接口是服务商专有的，没有该能力的服务商直接不显示入口
  const canVoice = useCapability('speech') !== false
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (!toggles) {
      return
    }

    const updateLabels = () => {
      toggles.classList.remove(styles.collapsedToggles)
      toggles.classList.toggle(styles.collapsedToggles, toggles.scrollWidth > toggles.clientWidth)
    }

    updateLabels()
    const observer = new ResizeObserver(updateLabels)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [t])

  const acceptFiles = (files: File[]) => {
    if (files.length === 0 || useChatStore.getState().importingHistory || !ensureProvider()) {
      return
    }
    const provider = getActiveProvider()
    if (!provider) {
      return
    }
    const error = addDraftFiles(sessionId, files, provider, getActiveFileMode())
    if (error) {
      showToast(error)
    }
  }
  /** 大段粘贴转成文本附件：输入框只留一个带 token 数的卡片，随时可以还原 */
  const acceptPastedText = (text: string) => {
    acceptFiles([new File([text], pasteFileName(text, t('pastedTextName')), { type: 'text/plain' })])
  }
  const retryFile = useCallback(
    (id: string) => {
      const provider = getActiveProvider()
      if (!useChatStore.getState().importingHistory && provider && ensureProvider()) {
        retryDraftAttachment(sessionId, id, provider)
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  /** 把文本附件还原成输入框里的普通文字，光标落在插入内容之后 */
  const expandFile = useCallback(
    async (id: string) => {
      const text = await expandDraftAttachment(sessionId, id)
      if (text === null) {
        return
      }
      const textarea = textareaRef.current
      const current = getDraft(sessionId).text
      const start = textarea?.selectionStart ?? current.length
      const end = textarea?.selectionEnd ?? current.length
      setDraftText(sessionId, current.slice(0, start) + text + current.slice(end))
      requestAnimationFrame(() => {
        textarea?.focus({ preventScroll: true })
        textarea?.setSelectionRange(start + text.length, start + text.length)
      })
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)

  /** 转写结果插入到光标处，并把光标移到插入内容之后 */
  const voice = useVoiceInput((transcript) => {
    const textarea = textareaRef.current
    const current = getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    setText(current.slice(0, start) + transcript + current.slice(end))
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  })

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice]
  )

  // 移动端录音时用频谱替代输入框内容
  const recording = voice.status === 'recording'

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  const canSend = !importingHistory && !streaming && voice.status === 'idle' && draftReady

  const send = () => {
    if (
      useChatStore.getState().importingHistory ||
      voice.status !== 'idle' ||
      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)
    ) {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (!ensureProvider() || !sendMessage(sessionId)) {
      return
    }
    stopReadAloud()
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  return (
    <div
      className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      <DraftAttachments
        items={attachments}
        onRetry={retryFile}
        onRemove={removeFile}
        onExpand={expandFile}
      />
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
          placeholder={t('chatInputPlaceholderChat')}
          rows={2}
          // 移动端不自动聚焦，避免一打开就弹出键盘
          autoFocus={!isMobile}
          disabled={importingHistory}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onMouseDown={(event) => {
            // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
            if (isMobile && event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length > 0) {
              event.preventDefault()
              acceptFiles(files)
              return
            }
            const text = event.clipboardData.getData('text/plain')
            if (estimateTokens(text) >= PASTE_AS_FILE_TOKENS) {
              event.preventDefault()
              acceptPastedText(text)
            }
          }}
        />
        {recording && isMobile ? <Spectrum getAnalyser={voice.getAnalyser} /> : null}
        <div className={styles.mirror} aria-hidden>
          {`${text}\n`}
        </div>
      </div>
      <div className={styles.functionRow}>
        <ModelPicker value={activeKey} onChange={setActiveKey} />
        {/* 深度思考 / 智能搜索开关，tooltip 在按钮上方 */}
        <div ref={togglesRef} className={styles.toggles}>
          <Tooltip content={t(canThink ? 'deactivatedThinkTooltip' : 'unsupportedThinkTooltip')}>
            <button
              type="button"
              className={clsx(styles.toggle, thinking && canThink && styles.selected)}
              aria-label={t('thinkingSwitch')}
              aria-pressed={thinking && canThink}
              disabled={!canThink}
              onClick={() => setThinking(!thinking)}
            >
              <IconThinkOutline14 />
              <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
            </button>
          </Tooltip>
          <Tooltip
            content={t(canSearch ? 'deactivatedSearchTooltip' : 'unsupportedSearchTooltip')}
          >
            <button
              type="button"
              className={clsx(styles.toggle, search && canSearch && styles.selected)}
              aria-label={t('search')}
              aria-pressed={search && canSearch}
              disabled={!canSearch}
              onClick={() => setSearch(!search)}
            >
              <IconGlobeLanguageOutline14 />
              <span className={styles.toggleLabel}>{t('search')}</span>
            </button>
          </Tooltip>
          <PromptPicker labelClassName={styles.toggleLabel} />
        </div>
        <div className={styles.right}>
          {canVoice ? (
            <VoiceButton
              status={voice.status}
              disabled={!voice.available}
              seconds={voice.seconds}
              onClick={() => {
                if (
                  voice.status !== 'idle' ||
                  (!useChatStore.getState().importingHistory && ensureProvider())
                ) {
                  void voice.toggle()
                }
              }}
            />
          ) : null}          <IconButton
            size="m"
            tone="primary"
            icon={<IconPaperclipOutline16 />}
            tooltip={t('uploadFile')}
            disabled={importingHistory}
            onClick={() => ensureProvider() && fileInputRef.current?.click()}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept={ACCEPT}
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          {streaming && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('chatInputStopButtonTooltip')}
              onClick={() => {
                stopReadAloud()
                stopReply(sessionId)
              }}
            >
              <IconStopFill16 />
            </button>
          ) : (
            <button
              type="button"
              className={clsx(styles.sendButton, !canSend && styles.disabled)}
              aria-label={t('send')}
              aria-disabled={!canSend}
              onClick={send}
            >
              <IconSendOutline16 />
            </button>
          )}
        </div>
      </div>
      {dragging ? <DragMask /> : null}
    </div>
  )
}
