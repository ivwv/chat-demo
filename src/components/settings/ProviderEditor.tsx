import { useState } from 'react'
import { fetchModels } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import {
  getModelCapabilities,
  isLocalBaseUrl,
  normalizeBaseUrl,
  type ModelConfig,
  type Protocol,
  type ProviderConfig,
  type ProviderDraft,
  type ProviderFeatures,
} from '../../services/providers/types.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { IconPlusOutline14, IconRefreshOutline16, IconTrashOutline16 } from '../base/icons.js'
import styles from './Providers.module.css'

/** 表单里的字段：JSON 与模型列表用字符串暂存，保存时再校验 */
type FormState = {
  name: string
  protocol: Protocol
  baseUrl: string
  modelsUrl: string
  apiKey: string
  models: ModelConfig[]
  headersText: string
  extraBodyText: string
  features: ProviderFeatures
}

/** 服务商能力开关：只有 DeepSeek 这类自带服务端工具的接口才需要打开 */
const FEATURE_KEYS: { key: keyof ProviderFeatures; label: TranslationKey }[] = [
  { key: 'serverTools', label: 'providerFeatureServerTools' },
  { key: 'serverTitle', label: 'providerFeatureServerTitle' },
  { key: 'latestReminder', label: 'providerFeatureLatestReminder' },
  { key: 'safetyCheck', label: 'providerFeatureSafetyCheck' },
  { key: 'filesApi', label: 'providerFeatureFilesApi' },
  { key: 'speech', label: 'providerFeatureSpeech' },
]

const toForm = (provider: ProviderDraft): FormState => ({
  name: provider.name,
  protocol: provider.protocol,
  baseUrl: provider.baseUrl,
  modelsUrl: provider.modelsUrl ?? '',
  apiKey: provider.apiKey,
  models: provider.models.map((item) => ({ ...item })),
  headersText: provider.headers ? JSON.stringify(provider.headers, null, 2) : '',
  extraBodyText: provider.extraBody ? JSON.stringify(provider.extraBody, null, 2) : '',
  features: { ...provider.features },
})

/** 空文本视为「未配置」，非空时必须能解析成对象 */
const parseObject = (text: string): Record<string, unknown> | null | undefined => {
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }
  try {
    const value: unknown = JSON.parse(trimmed)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

const splitModelIds = (text: string) =>
  text
    .split(/[\s,，、]+/)
    .map((item) => item.trim())
    .filter(Boolean)

/** 编辑单个服务商：基础字段 + 模型列表 + 兼容选项，保存前做完整校验 */
export const ProviderEditor = ({
  initial,
  providerId,
  title,
  onSave,
  onClose,
}: {
  /** 新建时传入预设的初值，编辑时传入现有配置 */
  initial: ProviderDraft
  providerId: string | null
  title: string
  onSave: (patch: ProviderDraft) => void
  onClose: () => void
}) => {
  const t = useTranslate()
  const [form, setForm] = useState<FormState>(() => toForm(initial))
  const [modelInput, setModelInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState<'test' | 'pull' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const patch = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const setFeature = (key: keyof ProviderFeatures, value: boolean) =>
    setForm((current) => ({ ...current, features: { ...current.features, [key]: value } }))

  /** 用当前表单值拼一个临时配置，供测试连接与能力推断使用 */
  const toConfig = (): ProviderConfig => {
    const headers = parseObject(form.headersText)
    const extraBody = parseObject(form.extraBodyText)
    return {
      id: providerId ?? 'draft',
      name: form.name.trim() || initial.name,
      protocol: form.protocol,
      baseUrl: normalizeBaseUrl(form.baseUrl),
      ...(form.modelsUrl.trim() ? { modelsUrl: form.modelsUrl.trim() } : {}),
      apiKey: form.apiKey.trim(),
      models: form.models,
      ...(headers ? { headers: headers as Record<string, string> } : {}),
      ...(extraBody ? { extraBody } : {}),
      features: form.features,
    }
  }

  const addModels = (ids: string[]) => {
    setForm((current) => {
      const existing = new Set(current.models.map((item) => item.id))
      const added = ids.filter((id) => !existing.has(id)).map((id) => ({ id, label: id }))
      return added.length > 0 ? { ...current, models: [...current.models, ...added] } : current
    })
  }

  /** 拉取模型用全量替换：上游下架的模型不再残留，保留仍存在模型的 label/capabilities */
  const replaceModels = (ids: string[]) => {
    setForm((current) => {
      const byId = new Map(current.models.map((item) => [item.id, item]))
      return {
        ...current,
        models: ids.map((id) => byId.get(id) ?? { id, label: id }),
      }
    })
  }

  const describe = (cause: unknown) => {
    if (cause instanceof Error && cause.message) {
      return cause.message
    }
    return classifyApiError(cause) === 'network' ? t('commonNetworkErrorToast') : String(cause)
  }

  const connect = async (mode: 'test' | 'pull') => {
    if (testing) {
      return
    }
    setTesting(mode)
    setResult(null)
    try {
      const models = await fetchModels(toConfig())
      if (mode === 'pull') {
        // 上游没返回任何模型时保留原列表，避免接口异常导致误清空
        if (models.length === 0) {
          setResult({ ok: false, text: t('providerModelsEmptyPulled') })
          return
        }
        replaceModels(models)
      }
      setResult({
        ok: true,
        text:
          mode === 'pull'
            ? t('providerModelsPulled', { count: models.length })
            : t('providerConnected', { count: models.length }),
      })
    } catch (cause) {
      setResult({ ok: false, text: t('providerConnectFailed', { message: describe(cause) }) })
    } finally {
      setTesting(null)
    }
  }

  const submit = () => {
    const name = form.name.trim()
    const baseUrl = normalizeBaseUrl(form.baseUrl)
    const headers = parseObject(form.headersText)
    const extraBody = parseObject(form.extraBodyText)
    const failure =
      !name
        ? 'providerNameRequired'
        : !/^https?:\/\//i.test(baseUrl)
          ? 'providerBaseUrlInvalid'
          : form.models.length === 0
            ? 'providerModelsRequired'
            : headers === undefined
              ? 'providerHeadersInvalid'
              : extraBody === undefined
                ? 'providerExtraBodyInvalid'
                : null
    if (failure) {
      setError(t(failure))
      return
    }
    onSave({
      name,
      protocol: form.protocol,
      baseUrl,
      ...(form.modelsUrl.trim() ? { modelsUrl: form.modelsUrl.trim() } : {}),
      apiKey: form.apiKey.trim(),
      models: form.models,
      ...(headers ? { headers: headers as Record<string, string> } : {}),
      ...(extraBody ? { extraBody } : {}),
      features: form.features,
    })
  }

  const config = toConfig()

  return (
    <Modal
      title={title}
      closable
      className={styles.editorDialog}
      mainClassName={styles.dialogBody}
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
      <div className={styles.form}>
        <div className={styles.fieldRow}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('providerName')}</span>
            <input
              className={styles.input}
              value={form.name}
              placeholder={t('providerNamePlaceholder')}
              onChange={(event) => patch('name', event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('providerProtocol')}</span>
            <Select
              ariaLabel={t('providerProtocol')}
              value={form.protocol}
              options={[
                { value: 'openai', label: 'OpenAI Chat Completions' },
                { value: 'anthropic', label: 'Anthropic Messages' },
              ]}
              onChange={(value) => {
                patch('protocol', value)
                setResult(null)
              }}
            />
          </label>
        </div>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('providerBaseUrl')}</span>
          <input
            className={styles.input}
            value={form.baseUrl}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              patch('baseUrl', event.target.value)
              setResult(null)
            }}
          />
          <span className={styles.hint}>{t('providerBaseUrlHint')}</span>
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('providerApiKey')}</span>
          <input
            className={styles.input}
            type="password"
            value={form.apiKey}
            placeholder={
              isLocalBaseUrl(form.baseUrl) ? t('providerApiKeyLocalHint') : t('apiKeyPlaceholder')
            }
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              patch('apiKey', event.target.value)
              setResult(null)
            }}
          />
          <span className={styles.hint}>{t('providerApiKeyHint')}</span>
        </label>

        <div className={styles.inlineActions}>
          <Button
            variant="outlined"
            size="m"
            title={t('providerPullModelsHint')}
            disabled={testing !== null || !form.baseUrl.trim()}
            onClick={() => void connect('pull')}
          >
            <IconRefreshOutline16 />
            {testing === 'pull' ? t('providerTesting') : t('providerPullModels')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            disabled={testing !== null || !form.baseUrl.trim()}
            onClick={() => void connect('test')}
          >
            {testing === 'test' ? t('providerTesting') : t('providerTest')}
          </Button>
        </div>
        {result ? (
          <div className={result.ok ? styles.testSuccess : styles.testError}>{result.text}</div>
        ) : null}

        <div className={styles.field}>
          <div className={styles.modelHeader}>
            <span className={styles.fieldLabel}>
              {t('providerModels')}
              {form.models.length > 0 ? ` (${form.models.length})` : ''}
            </span>
            <button
              type="button"
              className={styles.clearButton}
              disabled={form.models.length === 0}
              onClick={() => {
                patch('models', [])
                setResult(null)
              }}
            >
              {t('providerModelsClear')}
            </button>
          </div>
          <div className={styles.modelList}>
            {form.models.length === 0 ? (
              <div className={styles.modelEmpty}>{t('providerModelsEmpty')}</div>
            ) : (
              form.models.map((item) => {
                const caps = getModelCapabilities(config, item)
                const tags = [
                  caps.vision ? t('providerCapVision') : '',
                  caps.thinking ? t('providerCapThinking') : '',
                  caps.search ? t('providerCapSearch') : '',
                ].filter(Boolean)
                return (
                  <div key={item.id} className={styles.modelRow}>
                    <span className={styles.modelName}>{item.id}</span>
                    <span className={styles.modelCaps}>{tags.join(' · ')}</span>
                    <IconButton
                      icon={<IconTrashOutline16 />}
                      tooltip={t('delete')}
                      onClick={() =>
                        patch(
                          'models',
                          form.models.filter((model) => model.id !== item.id)
                        )
                      }
                    />
                  </div>
                )
              })
            )}
          </div>
          <div className={styles.fieldRow}>
            <input
              className={styles.input}
              value={modelInput}
              placeholder={t('providerModelPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setModelInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  addModels(splitModelIds(modelInput))
                  setModelInput('')
                }
              }}
            />
            <Button
              variant="outlined"
              size="m"
              disabled={!modelInput.trim()}
              onClick={() => {
                addModels(splitModelIds(modelInput))
                setModelInput('')
              }}
            >
              <IconPlusOutline14 />
              {t('add')}
            </Button>
          </div>
        </div>

        <details className={styles.advanced}>
          <summary>{t('providerAdvanced')}</summary>
          <div className={styles.advancedBody}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('providerModelsUrl')}</span>
              <input
                className={styles.input}
                value={form.modelsUrl}
                placeholder={t('providerModelsUrlPlaceholder')}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => patch('modelsUrl', event.target.value)}
              />
              <span className={styles.hint}>{t('providerModelsUrlHint')}</span>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('providerHeaders')}</span>
              <textarea
                className={styles.textarea}
                value={form.headersText}
                placeholder={'{"X-Custom-Header": "value"}'}
                spellCheck={false}
                onChange={(event) => patch('headersText', event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('providerExtraBody')}</span>
              <textarea
                className={styles.textarea}
                value={form.extraBodyText}
                placeholder={'{"reasoning_effort": "high"}'}
                spellCheck={false}
                onChange={(event) => patch('extraBodyText', event.target.value)}
              />
            </label>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('providerFeatures')}</span>
              <div className={styles.checks}>
                {FEATURE_KEYS.map((item) => (
                  <label key={item.key} className={styles.check}>
                    <input
                      type="checkbox"
                      checked={form.features[item.key] === true}
                      onChange={(event) => setFeature(item.key, event.target.checked)}
                    />
                    {t(item.label)}
                  </label>
                ))}
              </div>
              <span className={styles.hint}>{t('providerFeaturesHint')}</span>
            </div>
          </div>
        </details>

        {error ? <div className={styles.error}>{error}</div> : null}
      </div>
    </Modal>
  )
}
