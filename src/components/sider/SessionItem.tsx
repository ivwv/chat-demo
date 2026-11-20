import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconEditOutline16,
  IconEllipsisOutline16,
  IconSparkles16,
  IconTrashOutline16,
} from '../base/icons.js'
import {
  generateTitleWithAi,
  renameSession,
  selectSession,
  useChatStore,
} from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { showToast } from '../base/toastState.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  // 菜单打开后鼠标会移入浮层，会话项失去 hover；保持操作区可见，避免锚点尺寸归零导致菜单跳位
  const [menuOpen, setMenuOpen] = useState(false)
  const naming = useChatStore((state) => state.naming[session.id] === true)
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      className={clsx(styles.item, active && styles.active)}
      onClick={() => {
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      <div className={styles.title}>{displayTitle}</div>
      <div
        className={clsx(styles.action, menuOpen && styles.actionOpen)}
        onClick={(event) => event.stopPropagation()}
      >
        <Menu
          onOpenChange={setMenuOpen}
          options={[
            {
              key: 'ai-rename',
              label: t(naming ? 'sessionItemMenuAiRenameBusy' : 'sessionItemMenuAiRenameOption'),
              icon: <IconSparkles16 />,
              onSelect: () => {
                if (naming) {
                  return
                }
                void generateTitleWithAi(session.id).then((ok) => {
                  if (!ok) {
                    showToast({ key: 'aiRenameFailed', type: 'error' })
                  }
                })
              },
            },
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ toggle }) => (
            <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
          )}
        </Menu>
      </div>
    </div>
  )
})
