import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  addCustomPrompt,
  listPrompts,
  removeCustomPrompt,
  updateCustomPrompt,
  useCustomPrompts,
  type CustomPrompt,
  type PromptOption,
} from '../../services/prompts.js'
import { setPromptId, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import {
  IconCopyOutline16,
  IconEditOutline16,
  IconPlusOutline14,
  IconTrashOutline16,
} from '../base/icons.js'
import styles from './Settings.module.css'

type Editing = { id: string | null; name: string; content: string }

/**
 * 设置 › 提示词：内置项只读（可复制成自定义再改），自定义项可新建、编辑、删除。
 * 选中项会作为系统提示词随每次请求发送，与输入框底部的切换器共用同一份数据。
 */
export const PromptsSection = () => {
  const t = useTranslate()
  // 订阅自定义列表，增删改后立即重新渲染
  useCustomPrompts((state) => state.prompts)
  const activeId = useSettings((state) => state.promptId)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [removing, setRemoving] = useState<CustomPrompt | null>(null)

  const options = listPrompts()
  const builtin = options.filter((prompt) => prompt.builtin)
  const custom = options.filter((prompt) => !prompt.builtin)

  const copyOf = (prompt: PromptOption) => {
    const name = `${prompt.name} ${t('promptCopySuffix')}`
    const id = addCustomPrompt({ name, content: prompt.content })
    setEditing({ id, name, content: prompt.content })
  }

  const row = (prompt: PromptOption) => (
    <PromptRow
      key={prompt.id}
      prompt={prompt}
      active={prompt.id === activeId}
      onUse={() => setPromptId(prompt.id)}
      onEdit={() => setEditing({ id: prompt.id, name: prompt.name, content: prompt.content })}
      onCopy={() => copyOf(prompt)}
      onDelete={() =>
        setRemoving({ id: prompt.id, name: prompt.name, content: prompt.content })
      }
    />
  )

  return (
    <div className={styles.promptSection}>
      <div className={styles.promptHeader}>
        <div>
          <div className={styles.promptTitle}>{t('promptsTitle')}</div>
          <div className={styles.promptDesc}>{t('promptsDescription')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          onClick={() => setEditing({ id: null, name: '', content: '' })}
        >
          <IconPlusOutline14 />
          {t('promptAdd')}
        </Button>
      </div>

      <div className={styles.promptGroupName}>{t('promptCustomGroup')}</div>
      {custom.length === 0 ? (
        <div className={styles.promptEmpty}>{t('promptEmpty')}</div>
      ) : (
        custom.map(row)
      )}

      <div className={styles.promptGroupName}>{t('promptBuiltinGroup')}</div>
      {builtin.map(row)}

      {editing ? (
        <PromptEditor
          key={editing.id ?? 'new'}
          initial={editing}
          title={editing.id ? t('promptEditTitle') : t('promptAddTitle')}
          onClose={() => setEditing(null)}
          onSave={(draft) => {
            if (editing.id) {
              updateCustomPrompt(editing.id, draft)
            } else {
              setPromptId(addCustomPrompt(draft))
            }
            setEditing(null)
          }}
        />
      ) : null}

      {removing ? (
        <Modal
          title={t('promptDeleteTitle', { name: removing.name })}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setRemoving(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  removeCustomPrompt(removing.id)
                  setRemoving(null)
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          <div className={styles.promptDesc}>{t('promptDeleteDescription')}</div>
        </Modal>
      ) : null}
    </div>
  )
}

const PromptRow = ({
  prompt,
  active,
  onUse,
  onEdit,
  onCopy,
  onDelete,
}: {
  prompt: PromptOption
  active: boolean
  onUse: () => void
  onEdit: () => void
  onCopy: () => void
  onDelete: () => void
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.promptRow, active && styles.promptRowActive)}>
      <div className={styles.promptRowMain}>
        <div className={styles.promptRowName}>
          <span className={styles.promptRowNameText}>{prompt.name}</span>
          {prompt.builtin ? <span className={styles.promptBadge}>{t('promptBuiltin')}</span> : null}
          {active ? <span className={styles.promptBadgeActive}>{t('promptInUse')}</span> : null}
        </div>
        <div className={styles.promptRowText}>{prompt.content}</div>
      </div>
      <div className={styles.promptRowActions}>
        {active ? null : (
          <Button size="s" variant="outlined" onClick={onUse}>
            {t('promptUse')}
          </Button>
        )}
        {prompt.builtin ? (
          <IconButton icon={<IconCopyOutline16 />} tooltip={t('promptCopy')} onClick={onCopy} />
        ) : (
          <>
            <IconButton icon={<IconEditOutline16 />} tooltip={t('edit')} onClick={onEdit} />
            <IconButton icon={<IconTrashOutline16 />} tooltip={t('delete')} onClick={onDelete} />
          </>
        )}
      </div>
    </div>
  )
}

const PromptEditor = ({
  initial,
  title,
  onSave,
  onClose,
}: {
  initial: Editing
  title: string
  onSave: (draft: { name: string; content: string }) => void
  onClose: () => void
}) => {
  const t = useTranslate()
  const [name, setName] = useState(initial.name)
  const [content, setContent] = useState(initial.content)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    if (!content.trim()) {
      setError(t('promptContentRequired'))
      return
    }
    onSave({ name, content })
  }

  return (
    <Modal
      title={title}
      closable
      className={styles.promptDialog}
      mainClassName={styles.promptDialogBody}
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button onClick={submit}>{t('save')}</Button>
        </>
      }
    >
      <label className={styles.promptField}>
        <span className={styles.promptFieldLabel}>{t('promptName')}</span>
        <input
          className={styles.promptInput}
          value={name}
          placeholder={t('promptNamePlaceholder')}
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className={styles.promptField}>
        <span className={styles.promptFieldLabel}>{t('promptContent')}</span>
        <textarea
          className={styles.promptTextarea}
          value={content}
          rows={8}
          placeholder={t('promptContentPlaceholder')}
          spellCheck={false}
          onChange={(event) => {
            setContent(event.target.value)
            setError(null)
          }}
        />
      </label>
      {error ? <div className={styles.promptError}>{error}</div> : null}
    </Modal>
  )
}
