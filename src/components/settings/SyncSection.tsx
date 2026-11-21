import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  generateSyncPassword,
  normalizeSyncWorkerUrl,
} from '../../services/sync/config.js'
import {
  connectSync,
  disconnectSync,
  triggerManualReconcile,
  updateSyncConfig,
  useSyncStore,
} from '../../services/sync/engine.js'
import { probeSyncWorkerHealth } from '../../services/sync/sdkLoader.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import styles from './SyncSection.module.css'

const formatTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const LIMIT_OPTIONS = [
  { value: '256', label: '256 KB' },
  { value: '512', label: '512 KB' },
  { value: '2048', label: '2 MB' },
  { value: '5120', label: '5 MB' },
]

/** 设置 › 多端同步：配置 Worker 域名、房间密码并动态加载外部 SDK 建立实时 E2EE 同步 */
export const SyncSection = () => {
  const t = useTranslate()
  const config = useSyncStore((state) => state.config)
  const status = useSyncStore((state) => state.status)
  const reconnectingAttempt = useSyncStore((state) => state.reconnectingAttempt)
  const self = useSyncStore((state) => state.self)
  const peers = useSyncStore((state) => state.peers)
  const lastError = useSyncStore((state) => state.lastError)
  const sessionCount = useSyncStore((state) => state.sessionCount)
  const quota = useSyncStore((state) => state.quota)
  const logs = useSyncStore((state) => state.logs)

  const [showPassword, setShowPassword] = useState(false)
  const [testingHealth, setTestingHealth] = useState(false)
  const [healthStatus, setHealthStatus] = useState<{ ok: boolean; text: string } | null>(null)

  const normalized = normalizeSyncWorkerUrl(config.workerUrl)
  const isBusy = status === 'loading-sdk' || status === 'connecting'
  const isLocked = status !== 'disconnected'

  const statusText =
    status === 'connected'
      ? t('syncStatusConnected', { count: peers.length + 1 })
      : status === 'loading-sdk'
        ? t('syncStatusLoadingSdk')
        : status === 'connecting'
          ? t('syncStatusConnecting')
          : status === 'reconnecting'
            ? t('syncStatusReconnecting', { attempt: Math.max(1, reconnectingAttempt) })
            : t('syncStatusDisconnected')

  const formatSyncError = (error: { code?: string; message: string } | null): string | null => {
    if (!error) {
      return null
    }
    switch (error.code) {
      case 'missingConfig':
        return t('syncErrMissingConfig')
      case 'invalidUrl':
        return t('syncErrInvalidUrl')
      case 'insecureContext':
        return t('syncErrInsecureContext')
      case 'loadFailed':
        return t('syncErrLoadFailed')
      case 'timeout':
        return t('syncErrTimeout')
      case 'invalidSdk':
        return t('syncErrInvalidSdk')
      case 'DECRYPT_FAILED':
        return t('syncErrDecryptFailed')
      default:
        return t('syncErrGeneric', { message: error.message })
    }
  }

  const onTestHealth = async () => {
    if (testingHealth || !config.workerUrl.trim()) {
      return
    }
    setTestingHealth(true)
    setHealthStatus(null)
    try {
      const info = await probeSyncWorkerHealth(config.workerUrl)
      setHealthStatus({
        ok: true,
        text: t('syncHealthOk', { service: info.service, version: info.version }),
      })
    } catch (error) {
      setHealthStatus({
        ok: false,
        text: t('syncHealthFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      })
    } finally {
      setTestingHealth(false)
    }
  }

  const errorMessage = formatSyncError(lastError)

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <div className={styles.title}>{t('syncTitle')}</div>
        <div className={styles.statusPill}>
          <span
            className={clsx(
              styles.dot,
              status === 'connected' && styles.dotConnected,
              (status === 'loading-sdk' || status === 'connecting' || status === 'reconnecting') &&
                styles.dotBusy
            )}
          />
          <span>{statusText}</span>
        </div>
      </div>
      <div className={styles.desc}>{t('syncDescription')}</div>

      {/* Worker 域名配置 + 拼接 SDK URL 预览 */}
      <div className={styles.field}>
        <label htmlFor="syncWorkerUrl" className={styles.fieldLabel}>
          {t('syncWorkerUrl')}
        </label>
        <div className={styles.inputRow}>
          <input
            id="syncWorkerUrl"
            className={styles.input}
            value={config.workerUrl}
            disabled={isLocked}
            placeholder={t('syncWorkerUrlPlaceholder')}
            spellCheck={false}
            autoComplete="url"
            onChange={(event) => {
              updateSyncConfig({ workerUrl: event.target.value })
              setHealthStatus(null)
            }}
          />
          <Button
            variant="outlined"
            size="m"
            disabled={testingHealth || !config.workerUrl.trim()}
            onClick={() => void onTestHealth()}
          >
            {testingHealth ? t('syncTestingHealth') : t('syncTestHealth')}
          </Button>
        </div>
        {config.workerUrl.trim() ? (
          normalized ? (
            <div className={styles.preview}>
              {t('syncWorkerSdkPreview', { url: normalized.sdkUrl })}
            </div>
          ) : (
            <div className={styles.errorText}>{t('syncWorkerUrlInvalid')}</div>
          )
        ) : null}
        {healthStatus ? (
          <div className={healthStatus.ok ? styles.okText : styles.errorText}>
            {healthStatus.text}
          </div>
        ) : null}
      </div>

      {/* 房间同步密码 */}
      <div className={styles.field}>
        <label htmlFor="syncPassword" className={styles.fieldLabel}>
          {t('syncPassword')}
        </label>
        <div className={styles.inputRow}>
          <input
            id="syncPassword"
            className={styles.input}
            type={showPassword ? 'text' : 'password'}
            value={config.password}
            disabled={isLocked}
            placeholder={t('syncPasswordPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => updateSyncConfig({ password: event.target.value })}
          />
          <Button variant="outlined" size="m" onClick={() => setShowPassword((value) => !value)}>
            {t(showPassword ? 'syncPasswordHide' : 'syncPasswordShow')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            disabled={isLocked}
            onClick={() => {
              updateSyncConfig({ password: generateSyncPassword() })
              setShowPassword(true)
            }}
          >
            {t('syncPasswordGenerate')}
          </Button>
        </div>
        <div className={styles.desc}>{t('syncPasswordHint')}</div>
      </div>

      {/* 本机设备名称 */}
      <div className={styles.field}>
        <label htmlFor="syncDeviceName" className={styles.fieldLabel}>
          {t('syncDeviceName')}
        </label>
        <input
          id="syncDeviceName"
          className={styles.input}
          value={config.deviceName}
          disabled={isLocked}
          placeholder={t('syncDeviceNamePlaceholder')}
          spellCheck={false}
          onChange={(event) => updateSyncConfig({ deviceName: event.target.value })}
        />
      </div>

      {/* 连接 / 断开 / 立即对账 */}
      <div className={styles.actions}>
        {status === 'disconnected' ? (
          <Button
            size="m"
            disabled={!normalized || !config.password}
            onClick={() => void connectSync()}
          >
            {t('syncConnect')}
          </Button>
        ) : (
          <>
            <Button
              variant="dangerOutlined"
              size="m"
              disabled={isBusy}
              onClick={() => void disconnectSync()}
            >
              {t('syncDisconnect')}
            </Button>
            {status === 'connected' ? (
              <Button
                variant="outlined"
                size="m"
                disabled={peers.length === 0}
                onClick={() => void triggerManualReconcile()}
              >
                {t('syncReconcileNow')}
              </Button>
            ) : null}
          </>
        )}
      </div>

      {errorMessage ? <div className={styles.errorText}>{errorMessage}</div> : null}

      {/* 在线设备与统计 */}
      {status === 'connected' ? (
        <div className={styles.card}>
          <div className={styles.cardTitle}>{t('syncPeersLabel')}</div>
          <div className={styles.peerList}>
            <span className={clsx(styles.peerChip, styles.peerChipSelf)}>
              {t('syncPeersSelf', { name: self?.name || config.deviceName })}
            </span>
            {peers.map((peer) => (
              <span key={peer.peerId} className={styles.peerChip}>
                {peer.name} #{peer.shortId}
              </span>
            ))}
          </div>
          {peers.length === 0 ? <div className={styles.desc}>{t('syncPeersEmpty')}</div> : null}
          <div className={styles.desc}>
            {t('syncStatsSummary', {
              sessions: sessionCount,
              sent: quota?.sentFrames ?? 0,
              received: quota?.receivedFrames ?? 0,
            })}
          </div>
        </div>
      ) : null}

      {/* 同步策略选项 */}
      <div className={styles.card}>
        <div className={styles.cardTitle}>{t('syncOptionsTitle')}</div>
        <div className={styles.optionRow}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={config.autoSyncSmallFiles}
              onChange={(event) =>
                updateSyncConfig({ autoSyncSmallFiles: event.target.checked })
              }
            />
            <span>{t('syncAutoSmallFiles')}</span>
          </label>
          <Select
            ariaLabel={t('syncSmallFileLimit')}
            className={styles.limitSelect}
            value={String(config.smallFileLimitKB)}
            disabled={!config.autoSyncSmallFiles}
            options={LIMIT_OPTIONS}
            onChange={(value) => updateSyncConfig({ smallFileLimitKB: Number(value) || 512 })}
          />
        </div>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={config.syncCustomPrompts}
            onChange={(event) => updateSyncConfig({ syncCustomPrompts: event.target.checked })}
          />
          <span>{t('syncCustomPrompts')}</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={config.syncProviders}
            onChange={(event) => updateSyncConfig({ syncProviders: event.target.checked })}
          />
          <span>{t('syncProviders')}</span>
        </label>
        <div className={styles.desc}>{t('syncProvidersHint')}</div>
      </div>

      {/* 可折叠同步记录 */}
      <details className={styles.logs}>
        <summary>{t('syncLogsTitle', { count: logs.length })}</summary>
        <div className={styles.logList}>
          {logs.length === 0 ? (
            <div className={styles.desc}>{t('syncLogsEmpty')}</div>
          ) : (
            logs.map((entry) => (
              <div key={entry.id}>
                <span className={styles.logTime}>[{formatTime(entry.time)}]</span>
                <span
                  className={clsx(
                    entry.tone === 'ok' && styles.logOk,
                    entry.tone === 'warn' && styles.logWarn,
                    entry.tone === 'err' && styles.logErr
                  )}
                >
                  {entry.text}
                </span>
              </div>
            ))
          )}
        </div>
      </details>
    </div>
  )
}
