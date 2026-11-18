import clsx from 'clsx'
import { memo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getAttachmentKind, useUploads, type UploadTask } from '../../services/attachments.js'
import type { DraftAttachment } from '../../services/chat/drafts.js'
import { formatTokens } from '../../utils/tokens.js'
import { IconCloseFill14, IconRefreshOutline16 } from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import { FileCard } from '../files/FileCard.js'
import { useDraftTextFile } from '../files/useTextFile.js'
import styles from './ChatInput.module.css'

const UPLOADING: UploadTask = { status: 'uploading' }

/** 列表只随草稿附件变化更新；每张卡片独立订阅自己的上传状态与 token 估算。 */
export const DraftAttachments = memo(function DraftAttachments({
  items,
  onRetry,
  onRemove,
  onExpand,
}: {
  items: DraftAttachment[]
  onRetry: (id: string) => void
  onRemove: (id: string) => void
  /** 把文本附件还原成输入框里的普通文字 */
  onExpand: (id: string) => void
}) {
  if (items.length === 0) {
    return null
  }
  return (
    <div className={styles.attachments}>
      {items.map((item) => (
        <AttachmentItem
          key={item.id}
          item={item}
          onRetry={() => onRetry(item.id)}
          onRemove={() => onRemove(item.id)}
          onExpand={() => onExpand(item.id)}
        />
      ))}
    </div>
  )
})

/** 输入框里的文件：图片显示缩略图，其余显示文件卡片 */
const AttachmentItem = ({
  item,
  onRetry,
  onRemove,
  onExpand,
}: {
  item: DraftAttachment
  onRetry: () => void
  onRemove: () => void
  onExpand: () => void
}) => {
  const t = useTranslate()
  // 内联附件不经过上传队列，直接是就绪态
  const task = useUploads((state) =>
    item.needsUpload ? (state.tasks[item.id] ?? UPLOADING) : null
  )
  // 文本附件显示估算 token 数，大段粘贴转成的附件靠它判断值不值得发
  const isText = getAttachmentKind(item.file.name, item.file.type) === 'text'
  const tokens = useDraftTextFile(item.id, isText ? item.file : null)
  const status = task?.status ?? 'done'
  const error = task?.status === 'error' ? t(task.error.key, task.error.params) : undefined
  // 过大、格式不支持等重试无效的失败只提示原因，需删除后再发送
  const retry = task?.status === 'error' && task.retryable ? onRetry : undefined
  const failed = status === 'error'
  const retryLabel = t('uploadRetry', { message: error ?? t('uploadFileStatusFailed') })
  // 「上传失败」只显示重试图标，其余原因写在图片上：可重试时在图标下方，不可重试时贴底
  const showReason = failed && error !== undefined && error !== t('uploadFileStatusFailed')
  return item.previewUrl ? (
    <div
      className={clsx(styles.attachment, failed && styles.attachmentFailed)}
      title={error ?? item.file.name}
    >
      <img src={item.previewUrl} alt={item.file.name} />
      {status === 'uploading' ? <div className={styles.uploading} /> : null}
      {failed && retry ? (
        <Tooltip content={retryLabel}>
          <button type="button" className={styles.failed} aria-label={retryLabel} onClick={retry}>
            <IconRefreshOutline16 />
            {showReason ? <span className={styles.failedReason}>{error}</span> : null}
          </button>
        </Tooltip>
      ) : null}
      {failed && !retry ? (
        <div className={clsx(styles.failed, styles.failedStatic)} aria-label={error}>
          {showReason ? <span className={styles.failedReason}>{error}</span> : null}
        </div>
      ) : null}
      <button
        type="button"
        className={clsx(styles.remove, failed && !retry && styles.invalidRemove)}
        aria-label={t('delete')}
        onClick={onRemove}
      >
        <IconCloseFill14 />
      </button>
    </div>
  ) : (
    <FileCard
      name={item.file.name}
      size={item.file.size}
      status={status}
      error={error}
      extra={tokens === null ? undefined : t('fileTokenCount', { count: formatTokens(tokens) })}
      hint={status === 'done' && isText ? { label: t('pasteAsFile'), onClick: onExpand } : undefined}
      onRetry={retry}
      onRemove={onRemove}
    />
  )
}
