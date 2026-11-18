import { create } from 'zustand'
import type { LinkedMessage, TranslationMessage } from '../i18n/index.js'
import { uploadFile } from './api/client.js'
import { classifyApiError, getUploadErrorInfo, isRetryableApiError } from './api/errors.js'
import type { FilePurpose, InlineAttachment } from './api/types.js'
import type { FileMode, ProviderConfig } from './providers/types.js'
import { ACCEPT_FILE_EXTS } from './uploadExts.js'

/** 允许上传的扩展名，按扩展名白名单过滤，清单见 uploadExts.ts */
export const ACCEPTED_EXTS = ACCEPT_FILE_EXTS
/** 选择文件对话框的过滤条件 */
export const ACCEPT = ACCEPTED_EXTS.map((ext) => `.${ext}`).join(',')
/** 单文件大小上限与 Files API 一致 */
export const MAX_SIZE_MB = 64
/** 按 user_data 上传的文件（纯文本、代码、表格、电子书）原文件上限更小 */
export const MAX_USER_DATA_SIZE_MB = 32
/**
 * 内联图片的上限：base64 后体积约增加三分之一，且图片会进入每一轮上下文，
 * 比文件接口的额度卡得更紧。
 */
export const MAX_INLINE_IMAGE_MB = 8
/** 单个文本附件拼进上下文的最大字符数，超出部分截断并注明 */
export const MAX_INLINE_TEXT_CHARS = 200_000
/**
 * 粘贴内容超过这个 token 估算值就转成附件，避免一大坨文本把输入框和消息挤满；
 * 附件卡片上能看到 token 数，也可以随时还原成普通文本。
 */
export const PASTE_AS_FILE_TOKENS = 1200
export const MAX_COUNT = 50
/** 同时上传的文件数 */
const MAX_CONCURRENT = 3

/** 文件扩展名（小写，不含点）；没有扩展名时为空 */
export const getFileExt = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isAcceptedExt = (name: string) => ACCEPTED_EXTS.includes(getFileExt(name))

/** 需要服务端做版面解析的文档；其余非图片文件（纯文本、代码、表格、电子书）无需解析 */
const LAYOUT_RECOGNITION_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])

/** 二进制文档：无法内联成文本，只能走 Files API */
const BINARY_DOC_EXTS = new Set([
  'pdf',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'epub',
  'mobi',
  'psd',
  'h5',
  'hdf',
  'dds',
  'mpeg',
  'mpg',
])

/** 常见图片扩展名：部分系统给不出 MIME，按扩展名补判 */
const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'svgz',
  'ico',
  'tif',
  'tiff',
  'avif',
  'apng',
  'jfif',
  'xbm',
])

/** 附件在请求里的处理方式：图片内联 base64、文本拼进消息、文档只能上传 */
export type AttachmentKind = 'image' | 'text' | 'document'

/** 主流接口（Anthropic / OpenAI）都只接受这几种图片 MIME，其余无法内联 */
const INLINE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export const isInlineImageMime = (mimeType: string) => INLINE_IMAGE_MIMES.has(mimeType)

export const getAttachmentKind = (name: string, mimeType = ''): AttachmentKind => {
  if (IMAGE_EXTS.has(getFileExt(name)) || mimeType.startsWith('image/')) {
    return 'image'
  }
  return BINARY_DOC_EXTS.has(getFileExt(name)) ? 'document' : 'text'
}

/** 上传时的 purpose：图片不传，PDF 与 Word、PPT 做版面解析，其余按 user_data 上传 */
export const getUploadPurpose = (name: string, isImage: boolean): FilePurpose | null => {
  if (isImage) {
    return null
  }
  return LAYOUT_RECOGNITION_EXTS.has(getFileExt(name)) ? 'rich_layout_recognition' : 'user_data'
}

/** 文件允许的最大体积（MB），按上传时的 purpose 区分 */
const getMaxSizeMB = (file: File) =>
  getUploadPurpose(file.name, isImage(resolveMimeType(file))) === 'user_data'
    ? MAX_USER_DATA_SIZE_MB
    : MAX_SIZE_MB

/**
 * 添加前校验：格式 → 大小 → 数量，任一不满足即整批不添加。
 * 内联模式（非 filesApi）只接受图片与文本，且图片另有更小的上限。
 */
export const validateFiles = (
  files: File[],
  currentCount: number,
  mode: FileMode = 'inline'
): TranslationMessage | null => {
  if (files.some((file) => !isAcceptedExt(file.name))) {
    return { key: 'uploadUnsupportedFormat' }
  }
  if (mode === 'none') {
    return { key: 'uploadUnsupportedDocument' }
  }
  if (mode !== 'filesApi') {
    const kinds = files.map((file) => ({
      file,
      kind: getAttachmentKind(file.name, resolveMimeType(file)),
      mimeType: resolveMimeType(file),
    }))
    if (kinds.some((item) => item.kind === 'document')) {
      return { key: 'uploadUnsupportedDocument' }
    }
    // 无法内联的图片格式（bmp、svg、tiff 等）直接拒绝，避免服务商返回 400
    if (kinds.some((item) => item.kind === 'image' && !isInlineImageMime(item.mimeType))) {
      return { key: 'uploadUnsupportedImage' }
    }
    const heavy = kinds.find(
      (item) => item.kind === 'image' && item.file.size > MAX_INLINE_IMAGE_MB * 1024 * 1024
    )
    if (heavy) {
      return { key: 'uploadMaxMBSize', params: { size: MAX_INLINE_IMAGE_MB } }
    }
  } else {
    const oversized = files.find((file) => file.size > getMaxSizeMB(file) * 1024 * 1024)
    if (oversized) {
      return { key: 'uploadMaxMBSize', params: { size: getMaxSizeMB(oversized) } }
    }
  }
  if (currentCount + files.length > MAX_COUNT) {
    return { key: 'uploadMaxFiles', params: { count: MAX_COUNT } }
  }
  return null
}

/**
 * 上传失败在附件上显示的文案：与设计稿状态对应的用具体原因，其余统一「上传失败」。
 * 服务端原文多为英文且较长，不直接展示。
 */
export const describeUploadError = (error: unknown): TranslationMessage => {
  if (classifyApiError(error) === 'serverBusy') {
    return { key: 'uploadServerBusy' }
  }
  if (getUploadErrorInfo(error)?.code === 'parseFailed') {
    return { key: 'uploadParseFailed' }
  }
  return { key: 'uploadFileStatusFailed' }
}

type NoticeListener = (notice: LinkedMessage) => void
const noticeListeners = new Set<NoticeListener>()

/** 订阅需要额外提示的上传失败（配额达到上限），由界面层转成 toast */
export const onUploadNotice = (listener: NoticeListener) => {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}

/** 删除已上传文件的接口文档 */
const DELETE_FILE_DOCS_URL = 'https://api-docs.deepseek.com/api/delete-file'

/** 文件数或存储空间达到上限：附件上只放得下「上传失败」，原因另用 toast 说明并引导删除旧文件 */
export const describeUploadQuota = (error: unknown): LinkedMessage | undefined => {
  const info = getUploadErrorInfo(error)
  const link = { key: 'uploadDeleteFiles', href: DELETE_FILE_DOCS_URL } as const
  if (info?.code === 'fileCountLimit') {
    return { type: 'error', key: 'uploadFileCountLimit', params: { limit: info.limit ?? '' }, link }
  }
  if (info?.code === 'storageLimit') {
    return { type: 'error', key: 'uploadStorageLimit', params: { limit: info.limit ?? '' }, link }
  }
  return undefined
}

type Job = () => Promise<void>
const queue: Job[] = []
let running = 0

const next = () => {
  while (running < MAX_CONCURRENT) {
    const job = queue.shift()
    if (!job) {
      return
    }
    running++
    void job().finally(() => {
      running--
      next()
    })
  }
}

/** 排队上传，最多同时上传 MAX_CONCURRENT 个；排队期间中止的任务不会发出请求 */
const enqueueUpload = (
  provider: ProviderConfig,
  file: Blob,
  name: string,
  isImage: boolean,
  signal: AbortSignal
) =>
  new Promise<string>((resolve, reject) => {
    queue.push(async () => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      try {
        const body = file instanceof File ? file : new File([file], name, { type: file.type })
        resolve((await uploadFile(provider, body, getUploadPurpose(name, isImage), signal)).id)
      } catch (error) {
        reject(error)
      }
    })
    next()
  })

/**
 * 上传任务按附件的本地 id 登记：输入框选中即开始上传，全部成功后携带 serverId 发送，
 * 不会重复上传；导入的历史附件没有任务，发送前按本地原件补传。
 * 任务只在内存里，历史附件补传未完成时，刷新后会在下次请求前重新上传。
 */
export type UploadTask =
  | { status: 'uploading' }
  | { status: 'done'; serverId: string }
  | { status: 'error'; error: TranslationMessage; retryable: boolean }

type UploadState = { tasks: Record<string, UploadTask> }

export const useUploads = create<UploadState>(() => ({ tasks: {} }))

const setTask = (id: string, task: UploadTask | null) =>
  useUploads.setState((state) => ({
    tasks: task
      ? { ...state.tasks, [id]: task }
      : Object.fromEntries(Object.entries(state.tasks).filter(([key]) => key !== id)),
  }))

const pending = new Map<string, { promise: Promise<string>; controller: AbortController }>()

/** 开始（或复用进行中的）上传，返回服务端 file_id；失败时任务记为 error 并抛出原错误 */
export const uploadAttachment = (
  provider: ProviderConfig,
  id: string,
  blob: Blob,
  name: string,
  isImage: boolean
): Promise<string> => {
  const current = pending.get(id)
  if (current) {
    return current.promise
  }
  const controller = new AbortController()
  setTask(id, { status: 'uploading' })
  const promise = enqueueUpload(provider, blob, name, isImage, controller.signal)
    .then((serverId) => {
      setTask(id, { status: 'done', serverId })
      return serverId
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) {
        setTask(id, null)
      } else {
        setTask(id, {
          status: 'error',
          error: describeUploadError(error),
          retryable: isRetryableApiError(error),
        })
        const notice = describeUploadQuota(error)
        if (notice) {
          for (const listener of noticeListeners) {
            listener(notice)
          }
        }
      }
      throw error
    })
    .finally(() => pending.delete(id))
  pending.set(id, { promise, controller })
  return promise
}

export const cancelUpload = (id: string) => {
  pending.get(id)?.controller.abort()
  setTask(id, null)
}

/** 各扩展名对应的 MIME：部分系统（如 Windows）给不出 file.type，按扩展名补齐 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  svgz: 'image/svg+xml',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
  apng: 'image/apng',
  jfif: 'image/jpeg',
  xbm: 'image/x-xbitmap',
  pdf: 'application/pdf',
}

/** 取 MIME：优先用浏览器给出的类型；通用的 octet-stream 与空值按扩展名推断 */
export const mimeTypeOf = (name: string, type = '') =>
  (type && type !== 'application/octet-stream' ? type : '') || MIME_BY_EXT[getFileExt(name)] || ''

export const resolveMimeType = (file: File) => mimeTypeOf(file.name, file.type)

export const isImage = (mimeType: string) => mimeType.startsWith('image/')

/** 读成 base64（去掉 data URL 前缀），供内联图片使用 */
const readBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : '')
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment'))
    reader.readAsDataURL(blob)
  })

/**
 * 把原件读成请求里的内联形态：图片转 base64，文本读成字符串（过长时截断）。
 * 二进制文档返回 null，由调用方按服务商能力拦下，不做假支持。
 */
export const toInlineAttachment = async (
  file: { name: string; mimeType: string },
  blob: Blob
): Promise<InlineAttachment | null> => {
  const mimeType = mimeTypeOf(file.name, file.mimeType || blob.type)
  const kind = getAttachmentKind(file.name, mimeType)
  // 文档与无法内联的图片格式都返回 null：历史里遇到的静默跳过，不会把 400 带进请求
  if (kind === 'document' || (kind === 'image' && !isInlineImageMime(mimeType))) {
    return null
  }
  if (kind === 'image') {
    return { kind: 'image', mediaType: mimeType, data: await readBase64(blob) }
  }
  const text = await blob.text()
  return {
    kind: 'text',
    text:
      text.length > MAX_INLINE_TEXT_CHARS
        ? `${text.slice(0, MAX_INLINE_TEXT_CHARS)}\n\n[内容过长，已截断]`
        : text,
  }
}

/** 文件扩展名（大写），用于卡片元信息 */
export const getExtension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : ''
}

export const formatSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
