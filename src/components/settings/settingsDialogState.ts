import { create } from 'zustand'
import { hasUsableProvider } from '../../services/providers/store.js'

/** 设置弹窗的分组：通用设置 / 数据管理 */
export type SettingsSection = 'general' | 'data'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 没有可用的服务商时打开设置，返回当前选择是否已可发请求 */
export const ensureProvider = () => {
  if (hasUsableProvider()) {
    return true
  }
  openSettings('data')
  return false
}
