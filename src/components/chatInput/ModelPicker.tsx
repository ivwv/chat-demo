import clsx from 'clsx'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconSearchOutline16,
} from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setActiveKey, useProviders } from '../../services/providers/store.js'
import { fuzzyScore } from '../../utils/fuzzy.js'
import styles from './ModelPicker.module.css'

const SEPARATOR = '::'

/** 生成悬停提示：名称与 id 不同时一并展示，避免用户只看到被截断的显示名 */
const fullModelTitle = (label: string, modelId: string) =>
  label === modelId ? label : `${label} (${modelId})`

type Candidate = {
  key: string
  providerName: string
  label: string
  modelId: string
}

/**
 * 模型选择器：按服务商分组的下拉，服务商多、模型多时仍能一眼看出「哪个模型属于哪家」。
 * 输入关键词后改为模糊匹配的平铺列表，模型名、服务商名、模型 id 任一命中即可。
 */
export const ModelPicker = () => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
  const activeKey = useProviders((state) => state.activeKey)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** 当前高亮项，用于把它滚进可视区 */
  const activeItemRef = useRef<HTMLButtonElement | null>(null)
  /** 本次打开是否已完成「滚到选中项」的首次定位 */
  const centeredRef = useRef(false)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { side: 'top', align: 'end', maxHeight: 360, minSpace: 200 })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  const active = providers.find((provider) =>
    activeKey?.startsWith(`${provider.id}${SEPARATOR}`)
  )
  const activeModel = active?.models.find(
    (model) => activeKey === `${active.id}${SEPARATOR}${model.id}`
  )

  const candidates = useMemo<Candidate[]>(
    () =>
      providers.flatMap((provider) =>
        provider.models.map((model) => ({
          key: `${provider.id}${SEPARATOR}${model.id}`,
          providerName: provider.name,
          label: model.label,
          modelId: model.id,
        }))
      ),
    [providers]
  )

  /** 有关键词时按分数排序，没有则保持服务商分组顺序 */
  const matches = useMemo(() => {
    if (!query.trim()) {
      return null
    }
    return candidates
      .map((item) => ({
        item,
        score: Math.max(
          fuzzyScore(query, item.label),
          fuzzyScore(query, item.modelId),
          fuzzyScore(query, item.providerName)
        ),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item)
  }, [candidates, query])

  const visible = matches ?? candidates

  // 打开或清空搜索时，键盘高亮直接落到当前选中的模型；输入关键词后从第一条开始
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    if (query.trim()) {
      setActiveIndex(0)
      return
    }
    const index = visible.findIndex((item) => item.key === activeKey)
    setActiveIndex(index >= 0 ? index : 0)
  }, [open, query, visible, activeKey])

  // 首次打开把选中项滚到列表中间；之后键盘移动只做最小滚动，避免列表大幅跳动
  useEffect(() => {
    if (!open) {
      centeredRef.current = false
      return
    }
    // 浮层还没完成定位时高度不可信，等 position 就绪再滚，避免先滚错再回弹
    if (!position) {
      return
    }
    const frame = requestAnimationFrame(() => {
      const list = listRef.current
      const item = activeItemRef.current
      if (!list || !item) {
        return
      }
      const listRect = list.getBoundingClientRect()
      const itemRect = item.getBoundingClientRect()
      if (!centeredRef.current) {
        list.scrollTop += itemRect.top - listRect.top - (listRect.height - itemRect.height) / 2
        centeredRef.current = true
        return
      }
      if (itemRect.top < listRect.top) {
        list.scrollTop += itemRect.top - listRect.top
      } else if (itemRect.bottom > listRect.bottom) {
        list.scrollTop += itemRect.bottom - listRect.bottom
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [open, activeIndex, position])

  // 输入关键词后列表内容整体变化，滚回顶部从第一条结果看起
  useEffect(() => {
    if (!open || !query.trim()) {
      return
    }
    const list = listRef.current
    if (list) {
      list.scrollTop = 0
    }
  }, [open, query])

  useEffect(() => {
    if (open) {
      // 打开后直接可输入，省去一次点击
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  if (!active || !activeModel) {
    return null
  }

  const select = (key: string) => {
    setActiveKey(key)
    setOpen(false)
  }

  /**
   * 打开前同步归位：清空搜索并把高亮放到当前模型。
   * 否则首次渲染会沿用上一次的 activeIndex（可能是搜索结果里的索引），
   * 滚动 effect 先按错误位置滚一次，随后才被修正，表现为抖动。
   */
  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    setQuery('')
    const index = candidates.findIndex((item) => item.key === activeKey)
    setActiveIndex(index >= 0 ? index : 0)
    setOpen(true)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((index) => {
        if (visible.length === 0) {
          return 0
        }
        return (index + delta + visible.length) % visible.length
      })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const target = visible[activeIndex]
      if (target) {
        select(target.key)
      }
    }
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.triggerOpen)}
        aria-label={t('modelSelectorLabel')}
        title={fullModelTitle(activeModel.label, activeModel.id)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
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
              <div className={styles.search}>
                <IconSearchOutline16 />
                <input
                  ref={inputRef}
                  className={styles.searchInput}
                  value={query}
                  placeholder={t('modelSearchPlaceholder')}
                  aria-label={t('modelSearchPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={onKeyDown}
                />
              </div>
              <div ref={listRef} className={styles.list}>
                {matches ? (
                  matches.length === 0 ? (
                    <div className={styles.empty}>{t('modelSearchEmpty')}</div>
                  ) : (
                    matches.map((item, index) => (
                      <button
                        key={item.key}
                        ref={index === activeIndex ? activeItemRef : undefined}
                        type="button"
                        role="menuitemradio"
                        aria-checked={item.key === activeKey}
                        title={fullModelTitle(item.label, item.modelId)}
                        className={clsx(
                          styles.option,
                          item.key === activeKey && styles.optionSelected,
                          index === activeIndex && styles.optionActive
                        )}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => select(item.key)}
                      >
                        <span className={styles.optionLabel}>{item.label}</span>
                        <span className={styles.optionHint} title={item.providerName}>
                          {item.providerName}
                        </span>
                        {item.key === activeKey ? <IconCheckOutline16 /> : null}
                      </button>
                    ))
                  )
                ) : (
                  providers.map((provider) => (
                    <div key={provider.id} className={styles.group}>
                      <div className={styles.groupName} title={provider.name}>
                        {provider.name}
                      </div>
                      {provider.models.map((model) => {
                        const key = `${provider.id}${SEPARATOR}${model.id}`
                        const selected = key === activeKey
                        const index = visible.findIndex((item) => item.key === key)
                        return (
                          <button
                            key={key}
                            ref={index === activeIndex ? activeItemRef : undefined}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            title={fullModelTitle(model.label, model.id)}
                            className={clsx(
                              styles.option,
                              selected && styles.optionSelected,
                              index === activeIndex && styles.optionActive
                            )}
                            onMouseEnter={() => setActiveIndex(index)}
                            onClick={() => select(key)}
                          >
                            <span className={styles.optionLabel}>{model.label}</span>
                            {selected ? <IconCheckOutline16 /> : null}
                          </button>
                        )
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
