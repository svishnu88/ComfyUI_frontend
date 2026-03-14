<template>
  <div
    class="flex w-full max-w-[490px] flex-col border-t border-border-default"
  >
    <div class="flex size-full flex-col gap-4 p-4">
      <p class="m-0 text-sm/5 text-muted-foreground">
        {{ $t('missingModelsDialog.description') }}
      </p>

      <div
        class="flex scrollbar-custom max-h-[300px] flex-col overflow-y-auto rounded-lg bg-secondary-background"
      >
        <div
          v-for="model in processedModels"
          :key="model.name"
          class="flex items-center justify-between px-3 py-2"
        >
          <div class="flex items-center gap-2 overflow-hidden">
            <span
              class="text-foreground min-w-0 truncate text-sm"
              :title="model.name"
            >
              {{ model.name }}
            </span>
            <span
              class="inline-flex h-4 shrink-0 items-center rounded-full bg-muted-foreground/20 px-1.5 text-xxxs font-semibold text-muted-foreground uppercase"
            >
              {{ model.badgeLabel }}
            </span>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Skeleton v-if="showSkeleton(model)" class="ml-1.5 h-4 w-12" />
            <template v-else-if="model.isDownloadable">
              <span
                v-if="fileSizes.get(model.url)"
                class="pl-1.5 text-xs text-muted-foreground"
              >
                {{ formatSize(fileSizes.get(model.url)) }}
              </span>
              <a
                v-if="gatedModelUrls.has(model.url)"
                :href="gatedModelUrls.get(model.url)"
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs text-primary hover:underline"
              >
                {{ $t('missingModelsDialog.acceptTerms') }}
              </a>
              <template
                v-else-if="downloadProgress.has(model.url)"
              >
                <div class="flex items-center gap-2">
                  <div
                    v-if="downloadProgress.get(model.url)?.status === 'downloading'"
                    class="flex items-center gap-1.5"
                  >
                    <div class="h-1.5 w-16 overflow-hidden rounded-full bg-muted-foreground/20">
                      <div
                        class="h-full rounded-full bg-primary transition-all duration-300"
                        :style="{ width: (downloadProgress.get(model.url)?.progress ?? 0) + '%' }"
                      />
                    </div>
                    <span class="min-w-[3ch] text-right text-xxxs text-muted-foreground">
                      {{ Math.round(downloadProgress.get(model.url)?.progress ?? 0) }}%
                    </span>
                  </div>
                  <i
                    v-else-if="downloadProgress.get(model.url)?.status === 'completed'"
                    class="icon-[lucide--check] size-4 text-green-500"
                  />
                  <span
                    v-else-if="downloadProgress.get(model.url)?.status === 'error'"
                    class="text-xs text-red-500"
                  >
                    Failed
                  </span>
                </div>
              </template>
              <Button
                v-else
                variant="textonly"
                size="icon"
                :title="model.url"
                :aria-label="$t('g.download')"
                @click="handleDownload(model)"
              >
                <i class="icon-[lucide--download] size-4" />
              </Button>
            </template>
            <Button
              v-else
              variant="textonly"
              size="icon"
              :title="model.url"
              :aria-label="$t('g.copyURL')"
              @click="void copyToClipboard(model.url)"
            >
              <i class="icon-[lucide--copy] size-4" />
            </Button>
          </div>
        </div>

        <div
          v-if="totalDownloadSize > 0"
          class="sticky bottom-0 flex items-center justify-between border-t border-border-default bg-secondary-background px-3 py-2"
        >
          <span class="text-xs font-medium text-muted-foreground">
            {{ $t('missingModelsDialog.totalSize') }}
          </span>
          <span class="text-xs text-muted-foreground">
            {{ formatSize(totalDownloadSize) }}
          </span>
        </div>
      </div>

      <p class="m-0 text-xs/5 whitespace-pre-line text-muted-foreground">
        {{ $t('missingModelsDialog.footerDescription') }}
      </p>

      <div
        v-if="hasCustomModels"
        class="flex gap-3 rounded-lg border border-warning-background bg-warning-background/10 p-3"
      >
        <i
          class="mt-0.5 icon-[lucide--triangle-alert] size-4 shrink-0 text-warning-background"
        />
        <div class="flex flex-col gap-1">
          <p class="m-0 text-xs/5 font-semibold text-warning-background">
            {{ $t('missingModelsDialog.customModelsWarning') }}
          </p>
          <p class="m-0 text-xs/5 text-warning-background">
            {{ $t('missingModelsDialog.customModelsInstruction') }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

import Button from '@/components/ui/button/Button.vue'
import Skeleton from '@/components/ui/skeleton/Skeleton.vue'
import { useCopyToClipboard } from '@/composables/useCopyToClipboard'
import { formatSize } from '@/utils/formatUtil'
import { api } from '@/scripts/api'

import type { ModelWithUrl } from './missingModelsUtils'
import {
  downloadModel,
  fetchModelMetadata,
  getBadgeLabel,
  hasValidDirectory,
  isModelDownloadable
} from './missingModelsUtils'

const { missingModels, paths } = defineProps<{
  missingModels: ModelWithUrl[]
  paths: Record<string, string[]>
}>()

interface ProcessedModel {
  name: string
  url: string
  directory: string
  badgeLabel: string
  isDownloadable: boolean
}

const processedModels = computed<ProcessedModel[]>(() =>
  missingModels.map((model) => ({
    name: model.name,
    url: model.url,
    directory: model.directory,
    badgeLabel: getBadgeLabel(model.directory),
    isDownloadable:
      hasValidDirectory(model, paths) && isModelDownloadable(model)
  }))
)

const hasCustomModels = computed(() =>
  processedModels.value.some((m) => !m.isDownloadable)
)

const loading = ref(true)
const fileSizes = reactive(new Map<string, number>())

const totalDownloadSize = computed(() =>
  processedModels.value
    .filter((model) => model.isDownloadable)
    .reduce((total, model) => total + (fileSizes.get(model.url) ?? 0), 0)
)

const gatedModelUrls = reactive(new Map<string, string>())

function showSkeleton(model: ProcessedModel): boolean {
  return (
    model.isDownloadable &&
    loading.value &&
    !fileSizes.has(model.url) &&
    !gatedModelUrls.has(model.url)
  )
}

onMounted(async () => {
  const downloadableUrls = processedModels.value
    .filter((m) => m.isDownloadable)
    .map((m) => m.url)

  await Promise.allSettled(
    downloadableUrls.map(async (url) => {
      const metadata = await fetchModelMetadata(url)
      if (metadata.fileSize !== null) fileSizes.set(url, metadata.fileSize)
      if (metadata.gatedRepoUrl) gatedModelUrls.set(url, metadata.gatedRepoUrl)
    })
  )
  loading.value = false
})

const { copyToClipboard } = useCopyToClipboard()

interface DownloadProgress {
  progress: number
  status: 'downloading' | 'completed' | 'error'
}

const downloadProgress = reactive(new Map<string, DownloadProgress>())

function onDownloadProgress(event: CustomEvent) {
  const data = event.detail as {
    url: string
    progress: number
    status: string
  }
  downloadProgress.set(data.url, {
    progress: data.progress,
    status: data.status as DownloadProgress['status']
  })
}

onMounted(() => {
  api.addEventListener(
    'model_download_progress',
    onDownloadProgress as EventListener
  )
})

onUnmounted(() => {
  api.removeEventListener(
    'model_download_progress',
    onDownloadProgress as EventListener
  )
})

async function handleDownload(model: ProcessedModel) {
  downloadProgress.set(model.url, { progress: 0, status: 'downloading' })
  try {
    const result = await downloadModel(model, paths)
    if (result?.status === 'exists' || result?.status === 'already_downloading') {
      downloadProgress.set(model.url, { progress: 100, status: 'completed' })
    }
    // For status "started", progress updates come via WebSocket
  } catch {
    downloadProgress.set(model.url, { progress: 0, status: 'error' })
  }
}
</script>
