import { downloadUrlToHfRepoUrl, isCivitaiModelUrl } from '@/utils/formatUtil'
import { ServerFeatureFlag } from '@/composables/useFeatureFlags'
import { isDesktop, isJarvis } from '@/platform/distribution/types'
import { useElectronDownloadStore } from '@/stores/electronDownloadStore'
import { api } from '@/scripts/api'
import { useMissingModelStore } from '@/platform/missingModel/missingModelStore'
import type { TaskId } from '@/platform/tasks/services/taskService'

const ALLOWED_SOURCES = [
  'https://civitai.com/',
  'https://civitai.red/',
  'https://huggingface.co/',
  'http://localhost:'
] as const

// Intentionally restrictive subset of model extensions permitted for download.
// Does not include .bin, .onnx, .gguf — see MODEL_FILE_EXTENSIONS in
// missingModelScan.ts for the broader scanning set.
const ALLOWED_SUFFIXES = [
  '.safetensors',
  '.sft',
  '.ckpt',
  '.pth',
  '.pt'
] as const

const WHITE_LISTED_URLS: ReadonlySet<string> = new Set([
  'https://huggingface.co/stabilityai/stable-zero123/resolve/main/stable_zero123.ckpt',
  'https://huggingface.co/TencentARC/T2I-Adapter/resolve/main/models/t2iadapter_depth_sd14v1.pth?download=true',
  'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth'
])

export interface ModelWithUrl {
  name: string
  url: string
  directory: string
}

interface ServerModelDownloadResponse {
  task_id?: string | null
  status?: 'created' | 'running' | 'completed' | 'failed' | 'started' | 'exists' | 'downloading'
  filename?: string
  bytes_total?: number
  bytes_downloaded?: number
  progress?: number
  error?: string | null
}

/**
 * Converts a model download URL to a browsable page URL.
 * - HuggingFace: `/resolve/` → `/blob/` (file page with model info)
 * - Civitai: strips `/api/download` or `/api/v1` prefix (model page)
 */
export function toBrowsableUrl(url: string): string {
  if (isCivitaiModelUrl(url)) {
    return url.replace('/api/download/', '/').replace('/api/v1/', '/')
  }
  if (url.includes('huggingface.co')) {
    return url.replace('/resolve/', '/blob/')
  }
  return url
}

export function isModelDownloadable(model: ModelWithUrl): boolean {
  if (WHITE_LISTED_URLS.has(model.url)) return true
  if (!ALLOWED_SOURCES.some((source) => model.url.startsWith(source)))
    return false
  if (!ALLOWED_SUFFIXES.some((suffix) => model.name.endsWith(suffix)))
    return false
  return true
}

async function downloadModelToServer(model: ModelWithUrl): Promise<void> {
  const missingModelStore = useMissingModelStore()
  const res = await api.fetchApi('/jarvis/models/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: model.url,
      filename: model.name,
      directory: model.directory
    })
  })

  if (!res.ok) {
    const errorText = await res.text().catch(() => '')
    throw new Error(errorText || `Model download failed with ${res.status}`)
  }

  const result: ServerModelDownloadResponse | null = await res
    .json()
    .catch(() => null)
  const status = typeof result?.status === 'string' ? result.status : 'started'
  const taskId = result?.task_id

  missingModelStore.setServerModelDownload(model.url, {
    taskId: (taskId ?? `server-model-download:${model.url}`) as TaskId,
    assetName: model.name,
    bytesTotal: result?.bytes_total ?? 0,
    bytesDownloaded: result?.bytes_downloaded ?? 0,
    progress: result?.progress ?? (status === 'exists' ? 1 : 0),
    status: status === 'exists' ? 'completed' : 'created',
    lastUpdate: Date.now(),
    error: result?.error ?? undefined
  })

  if (taskId) {
    pollServerModelDownload(model, taskId)
  }
}

function pollServerModelDownload(model: ModelWithUrl, taskId: string) {
  const missingModelStore = useMissingModelStore()

  const poll = async () => {
    try {
      const res = await api.fetchApi(`/jarvis/models/download/${taskId}`)
      if (!res.ok) return

      const data: ServerModelDownloadResponse = await res.json()
      const status =
        data.status === 'failed' || data.status === 'completed'
          ? data.status
          : data.status === 'running'
            ? 'running'
            : 'created'

      missingModelStore.setServerModelDownload(model.url, {
        taskId: taskId as TaskId,
        assetName: data.filename ?? model.name,
        bytesTotal: data.bytes_total ?? 0,
        bytesDownloaded: data.bytes_downloaded ?? 0,
        progress: data.progress ?? 0,
        status,
        lastUpdate: Date.now(),
        error: data.error ?? undefined
      })

      if (status === 'completed' || status === 'failed') return
      window.setTimeout(poll, 1000)
    } catch {
      window.setTimeout(poll, 2000)
    }
  }

  window.setTimeout(poll, 500)
}

export async function downloadModel(
  model: ModelWithUrl,
  paths: Record<string, string[]>
): Promise<void> {
  const canDownloadToJarvisServer =
    isJarvis &&
    api.getServerFeature(ServerFeatureFlag.JARVIS_MODEL_DOWNLOADS, false)

  if (canDownloadToJarvisServer) {
    await downloadModelToServer(model)
    return
  }

  if (!isDesktop) {
    const anchor = document.createElement('a')
    anchor.href = model.url
    anchor.download = model.name
    anchor.rel = 'noopener noreferrer'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    return
  }

  const modelPaths = paths[model.directory]
  if (modelPaths?.[0]) {
    void useElectronDownloadStore().start({
      url: model.url,
      savePath: modelPaths[0],
      filename: model.name
    })
  }
}

interface ModelMetadata {
  fileSize: number | null
  gatedRepoUrl: string | null
}

interface CivitaiModelFile {
  sizeKB: number
  downloadUrl: string
}

interface CivitaiModelVersionResponse {
  files: CivitaiModelFile[]
}

const metadataCache = new Map<string, ModelMetadata>()
const inflight = new Map<string, Promise<ModelMetadata>>()

async function fetchCivitaiMetadata(url: string): Promise<ModelMetadata> {
  try {
    const pathname = new URL(url).pathname
    const versionIdMatch =
      pathname.match(/^\/api\/download\/models\/(\d+)$/) ??
      pathname.match(/^\/api\/v1\/models-versions\/(\d+)$/)

    if (!versionIdMatch) return { fileSize: null, gatedRepoUrl: null }

    const [, modelVersionId] = versionIdMatch
    const apiUrl = `https://civitai.com/api/v1/model-versions/${modelVersionId}`
    const res = await fetch(apiUrl)
    if (!res.ok) return { fileSize: null, gatedRepoUrl: null }

    const data: CivitaiModelVersionResponse = await res.json()
    const matchingFile = data.files?.find((file) => {
      const downloadUrl = file.downloadUrl
      return (
        typeof downloadUrl === 'string' &&
        downloadUrl.length > 0 &&
        downloadUrl.startsWith(url)
      )
    })
    const fileSize = matchingFile?.sizeKB ? matchingFile.sizeKB * 1024 : null
    return { fileSize, gatedRepoUrl: null }
  } catch {
    return { fileSize: null, gatedRepoUrl: null }
  }
}

const GATED_STATUS_CODES = new Set([401, 403, 451])

async function fetchHeadMetadata(url: string): Promise<ModelMetadata> {
  try {
    const response = await fetch(url, { method: 'HEAD' })
    if (!response.ok) {
      if (
        url.includes('huggingface.co') &&
        GATED_STATUS_CODES.has(response.status)
      ) {
        return { fileSize: null, gatedRepoUrl: downloadUrlToHfRepoUrl(url) }
      }
      return { fileSize: null, gatedRepoUrl: null }
    }
    const size = response.headers.get('content-length')
    const parsedSize = size ? parseInt(size, 10) : null
    return {
      fileSize:
        parsedSize !== null && !Number.isNaN(parsedSize) ? parsedSize : null,
      gatedRepoUrl: null
    }
  } catch {
    return { fileSize: null, gatedRepoUrl: null }
  }
}

function isComplete(metadata: ModelMetadata): boolean {
  return metadata.fileSize !== null || metadata.gatedRepoUrl !== null
}

export async function fetchModelMetadata(url: string): Promise<ModelMetadata> {
  const cached = metadataCache.get(url)
  if (cached !== undefined) return cached

  const existing = inflight.get(url)
  if (existing) return existing

  const promise = (async () => {
    const metadata = isCivitaiModelUrl(url)
      ? await fetchCivitaiMetadata(url)
      : await fetchHeadMetadata(url)

    if (isComplete(metadata)) {
      metadataCache.set(url, metadata)
    }
    return metadata
  })()

  inflight.set(url, promise)
  try {
    return await promise
  } finally {
    inflight.delete(url)
  }
}
