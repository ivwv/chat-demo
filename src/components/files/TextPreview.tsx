import { useTranslate } from '../../i18n/index.js'
import { formatSize } from '../../services/attachments.js'
import { formatTokens } from '../../utils/tokens.js'
import { Modal } from '../base/Modal.js'
import styles from './TextPreview.module.css'

/**
 * 文本附件预览：消息里的文件卡片点开后查看全文。
 * 长文本在弹窗内滚动，顶部保留大小与 token 估算，方便判断上下文成本。
 */
export const TextPreview = ({
  name,
  size,
  text,
  tokens,
  onClose,
}: {
  name: string
  size: number
  text: string
  tokens: number | null
  onClose: () => void
}) => {
  const t = useTranslate()
  const meta = [
    formatSize(size),
    tokens === null ? '' : t('fileTokenCount', { count: formatTokens(tokens) }),
    t('fileLineCount', { count: text.split('\n').length }),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Modal
      title={name}
      closable
      className={styles.dialog}
      mainClassName={styles.body}
      onClose={onClose}
    >
      <div className={styles.meta}>{meta}</div>
      <pre className={styles.text}>{text}</pre>
    </Modal>
  )
}
