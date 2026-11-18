import { useTranslate } from '../../i18n/index.js'
import { setActiveKey, useModelOptions, useProviders } from '../../services/providers/store.js'
import { Select } from '../base/Select.js'
import styles from './ModelPicker.module.css'

/** 模型选择器：把所有服务商的模型摊平成一个下拉，标签里带服务商名避免重名困惑 */
export const ModelPicker = () => {
  const t = useTranslate()
  const models = useModelOptions()
  const activeKey = useProviders((state) => state.activeKey)
  if (models.length === 0) {
    return null
  }
  return (
    <div className={styles.picker}>
      <Select
        ariaLabel={t('modelSelectorLabel')}
        value={activeKey ?? ''}
        placeholder={t('modelSelectorPlaceholder')}
        options={models.map((item) => ({
          value: item.key,
          label:
            item.providerName === item.modelLabel
              ? item.modelLabel
              : `${item.providerName} · ${item.modelLabel}`,
        }))}
        onChange={setActiveKey}
      />
    </div>
  )
}
