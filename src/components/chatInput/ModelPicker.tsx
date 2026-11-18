import clsx from 'clsx'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setActiveKey, useProviders } from '../../services/providers/store.js'
import styles from './ModelPicker.module.css'

const SEPARATOR = '::'

/**
 * 模型选择器：按服务商分组的下拉。
 * 服务商多、模型多时仍能一眼看出「哪个模型属于哪家」，比平铺列表更清楚。
 */
export const ModelPicker = () => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
  const activeKey = useProviders((state) => state.activeKey)
  const [open, setOpen] = useState(false)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { side: 'top', align: 'end', maxHeight: 340, minSpace: 200 })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  const active = providers.find((provider) =>
    activeKey?.startsWith(`${provider.id}${SEPARATOR}`)
  )
  const activeModel = active?.models.find(
    (model) => activeKey === `${active.id}${SEPARATOR}${model.id}`
  )
  if (!active || !activeModel) {
    return null
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.triggerOpen)}
        aria-label={t('modelSelectorLabel')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.triggerText}>{activeModel.label}</span>
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
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
              {providers.map((provider) => (
                <div key={provider.id} className={styles.group}>
                  <div className={styles.groupName}>{provider.name}</div>
                  {provider.models.map((model) => {
                    const key = `${provider.id}${SEPARATOR}${model.id}`
                    const selected = key === activeKey
                    return (
                      <button
                        key={key}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        className={clsx(styles.option, selected && styles.optionSelected)}
                        onClick={() => {
                          setActiveKey(key)
                          setOpen(false)
                        }}
                      >
                        <span className={styles.optionLabel}>{model.label}</span>
                        {selected ? <IconCheckOutline16 /> : null}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
