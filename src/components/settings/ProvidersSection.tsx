import clsx from 'clsx'
import { useState } from 'react'
import {
  addProvider,
  removeProvider,
  setActiveKey,
  updateProvider,
  useProviders,
} from '../../services/providers/store.js'
import { providerPresets, type ProviderPreset } from '../../services/providers/presets.js'
import {
  isProviderReady,
  type ProviderConfig,
  type ProviderDraft,
} from '../../services/providers/types.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { Modal } from '../base/Modal.js'
import {
  IconCheckOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconPlusOutline14,
  IconTrashOutline16,
} from '../base/icons.js'
import { ProviderEditor } from './ProviderEditor.js'
import styles from './Providers.module.css'

const SPLIT = '::'

const providerKey = (provider: ProviderConfig) =>
  provider.models[0] ? `${provider.id}${SPLIT}${provider.models[0].id}` : null

/** 预设按 group 聚类，保持 providerPresets 里的先后顺序 */
const groupPresets = () => {
  const groups = new Map<string, ProviderPreset[]>()
  providerPresets.forEach((preset) => {
    const list = groups.get(preset.group) ?? []
    list.push(preset)
    groups.set(preset.group, list)
  })
  return [...groups.entries()]
}

type Editing = { id: string | null; draft: ProviderDraft; title: string }

/** 设置 › 服务商：列表 + 添加预设 + 编辑 + 删除，当前选中的服务商带标记 */
export const ProvidersSection = () => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
  const activeKey = useProviders((state) => state.activeKey)
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [removing, setRemoving] = useState<ProviderConfig | null>(null)

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <div className={styles.title}>{t('providersTitle')}</div>
        <Button variant="outlined" size="m" onClick={() => setPicking(true)}>
          <IconPlusOutline14 />
          {t('providerAdd')}
        </Button>
      </div>
      <div className={styles.hint}>{t('providersDescription')}</div>
      {providers.some(isProviderReady) ? null : (
        <div className={styles.error}>{t('providerNoneReady')}</div>
      )}

      <div className={styles.list}>
        {providers.map((provider) => {
          const isActive = activeKey?.startsWith(`${provider.id}${SPLIT}`) === true
          const edit = () =>
            setEditing({ id: provider.id, draft: provider, title: provider.name })
          return (
            <div key={provider.id} className={clsx(styles.card, isActive && styles.cardActive)}>
              <div className={styles.cardMain}>
                <div className={styles.cardName}>
                  <span className={styles.cardNameText}>{provider.name}</span>
                  {isActive ? <span className={styles.badge}>{t('providerActive')}</span> : null}
                </div>
                <div className={styles.cardMeta}>
                  {t('providerMeta', {
                    protocol: provider.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI',
                    count: provider.models.length,
                  })}
                </div>
              </div>
              <div className={styles.cardActions}>
                {isProviderReady(provider) ? (
                  <IconButton icon={<IconEditOutline16 />} tooltip={t('edit')} onClick={edit} />
                ) : (
                  <Button size="s" onClick={edit}>
                    {t('providerConfigure')}
                  </Button>
                )}
                <Menu
                  options={[
                    ...(isActive
                      ? []
                      : [
                          {
                            key: 'activate',
                            label: t('providerSetActive'),
                            icon: <IconCheckOutline16 />,
                            onSelect: () => {
                              const key = providerKey(provider)
                              if (key) {
                                setActiveKey(key)
                              }
                            },
                          },
                        ]),
                    ...(providers.length > 1
                      ? [
                          {
                            key: 'remove',
                            label: t('delete'),
                            icon: <IconTrashOutline16 />,
                            danger: true,
                            onSelect: () => setRemoving(provider),
                          },
                        ]
                      : []),
                  ]}
                >
                  {({ toggle }) => (
                    <IconButton
                      icon={<IconEllipsisOutline16 />}
                      tooltip={t('more')}
                      onClick={toggle}
                    />
                  )}
                </Menu>
              </div>
            </div>
          )
        })}
      </div>

      {picking ? (
        <PresetPicker
          onClose={() => setPicking(false)}
          onPick={(preset) => {
            setPicking(false)
            setEditing({
              id: null,
              draft: preset.draft,
              title: t('providerAddTitle', { name: preset.name }),
            })
          }}
        />
      ) : null}

      {editing ? (
        <ProviderEditor
          key={editing.id ?? editing.draft.name}
          initial={editing.draft}
          providerId={editing.id}
          title={editing.title}
          onClose={() => setEditing(null)}
          onSave={(patch) => {
            if (editing.id) {
              updateProvider(editing.id, patch)
            } else {
              addProvider(patch)
            }
            setEditing(null)
          }}
        />
      ) : null}

      {removing ? (
        <Modal
          title={t('providerDeleteTitle', { name: removing.name })}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setRemoving(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  removeProvider(removing.id)
                  setRemoving(null)
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          <div className={styles.hint}>{t('providerDeleteDescription')}</div>
        </Modal>
      ) : null}
    </div>
  )
}

/** 添加服务商：先选预设（预填地址、协议与默认模型），再进编辑器补 Key */
const PresetPicker = ({
  onPick,
  onClose,
}: {
  onPick: (preset: ProviderPreset) => void
  onClose: () => void
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('providerAdd')}
      closable
      className={styles.presetDialog}
      mainClassName={styles.dialogBody}
      onClose={onClose}
    >
      <div className={styles.presetGroups}>
        {groupPresets().map(([group, presets]) => (
          <div key={group} className={styles.presetGroup}>
            <div className={styles.presetGroupName}>{group}</div>
            <div className={styles.presetGrid}>
              {presets.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className={styles.presetItem}
                  onClick={() => onPick(preset)}
                >
                  <span className={styles.presetName}>{preset.name}</span>
                  <span className={styles.presetMeta}>
                    {preset.draft.baseUrl || t('providerCustomBaseUrl')}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
