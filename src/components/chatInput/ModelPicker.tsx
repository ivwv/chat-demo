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
import { useProviders } from '../../services/providers/store.js'
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
  /** 置顶的额外选项（如「跟随当前模型」），不参与服务商分组 */
  extra?: boolean
}

export type ModelPickerOption = { key: string; label: string }

/**
 * 模型选择器：按服务商分组的下拉，带搜索与键盘导航。
 * `value` / `onChange` 受控，聊天输入框与设置页共用同一套交互。
 */
export const ModelPicker = ({
  value,
  onChange,
  placeholder,
  extraOptions,
  menuSide = 'top',
  ariaLabel,
  className,
}: {
  /** 当前值：`providerId::modelId`，或 extraOptions 里的 key */
  value: string | null
  onChange: (key: string) => void
  /** 没有任何匹配时触发器显示的文字；也为空时不渲染 */
  placeholder?: string
  /** 置顶的额外选项，搜索时同样参与匹配 */
  extraOptions?: ModelPickerOption[]
  menuSide?: 'top' | 'bottom'
  ariaLabel?: string
  className?: string
}) => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
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
  >(open, { side: menuSide, align: 'end', maxHeight: 360, minSpace: 200 })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  const candidates = useMemo<Candidate[]>(
    () => [
      ...(extraOptions ?? []).map((option) => ({
        key: option.key,
        providerName: '',
        label: option.label,
        modelId: '',
        extra: true,
      })),
      ...providers.flatMap((provider) =>
        provider.models.map((model) => ({
          key: `${provider.id}${SEPARATOR}${model.id}`,
          providerName: provider.name,
          label: model.label,
          modelId: model.id,
        }))
      ),
    ],
    [extraOptions, providers]
  )

  /** 有关键词时按分数排序，没有则保持「额外选项 + 服务商分组」顺序 */
  const matches = useMemo(() => {
    if (!query.trim()) {
      return null
    }
    return candidates
      .map((item) => ({
        item,
        score: item.extra
          ? fuzzyScore(query, item.label)
          : Math.max(
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

  const selected = candidates.find((item) => item.key === value)
  const triggerLabel = selected?.label ?? placeholder ?? ''

  // 打开或清空搜索时，键盘高亮直接落到当前选中的模型；输入关键词后从第一条开始
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    if (query.trim()) {
      setActiveIndex(0)
      return
    }
    const index = visible.findIndex((item) => item.key === value)
    setActiveIndex(index >= 0 ? index : 0)
  }, [open, query, value, visible])

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

  if (!triggerLabel) {
    return null
  }

  const select = (key: string) => {
    onChange(key)
    setOpen(false)
  }

  /**
   * 打开前同步归位：清空搜索并把高亮放到当前值。
   * 否则首次渲染会沿用上一次的 activeIndex，滚动 effect 先按错误位置滚一次再修正，表现为抖动。
   */
  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    setQuery('')
    const index = candidates.findIndex((item) => item.key === value)
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

  const indexByKey = new Map(visible.map((item, index) => [item.key, index]))
  const candidateByKey = new Map(candidates.map((item) => [item.key, item]))
  const triggerTitle = selected
    ? selected.extra
      ? selected.label
      : fullModelTitle(selected.label, selected.modelId)
    : undefined

  const renderOption = (item: Candidate, index: number) => (
    <button
      key={item.key || '__current__'}
      ref={index === activeIndex ? activeItemRef : undefined}
      type="button"
      role="menuitemradio"
      aria-checked={item.key === value}
      title={item.extra ? item.label : fullModelTitle(item.label, item.modelId)}
      className={clsx(
        styles.option,
        item.key === value && styles.optionSelected,
        index === activeIndex && styles.optionActive
      )}
      onMouseEnter={() => setActiveIndex(index)}
      onClick={() => select(item.key)}
    >
      <span className={styles.optionLabel}>{item.label}</span>
      {item.extra ? null : (
        <span className={styles.optionHint} title={item.providerName}>
          {item.providerName}
        </span>
      )}
      {item.key === value ? <IconCheckOutline16 /> : null}
    </button>
  )

  const extraCandidates = candidates.filter((item) => item.extra)

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.triggerOpen, className)}
        aria-label={ariaLabel ?? t('modelSelectorLabel')}
        title={triggerTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className={styles.triggerText}>{triggerLabel}</span>
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
                    matches.map((item, index) => renderOption(item, index))
                  )
                ) : (
                  <>
                    {extraCandidates.length > 0 ? (
                      <div className={styles.group}>
                        {extraCandidates.map((item) =>
                          renderOption(item, indexByKey.get(item.key) ?? 0)
                        )}
                      </div>
                    ) : null}
                    {providers.map((provider) => (
                      <div key={provider.id} className={styles.group}>
                        <div className={styles.groupName} title={provider.name}>
                          {provider.name}
                        </div>
                        {provider.models.map((model) => {
                          const key = `${provider.id}${SEPARATOR}${model.id}`
                          const item = candidateByKey.get(key)
                          return item ? renderOption(item, indexByKey.get(key) ?? 0) : null
                        })}
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
