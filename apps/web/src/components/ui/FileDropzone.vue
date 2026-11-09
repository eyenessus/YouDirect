<script setup lang="ts">
import { ref } from 'vue';
import { Upload, X, FileText, Loader2 } from 'lucide-vue-next';
import { ApiRequestError, uploadFile, type UploadedFileResponse } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

const props = withDefaults(
  defineProps<{
    purpose: string;
    accept?: string;
    hint?: string;
    title?: string;
    multiple?: boolean;
    files?: Array<{ fileId: string; url: string; originalName: string }>;
    maxLabel?: string;
    disabled?: boolean;
    disabledReason?: string;
  }>(),
  {
    accept: 'image/png,image/jpeg,image/webp,application/pdf',
    title: 'Clique ou arraste o arquivo aqui',
    multiple: false,
    disabled: false,
  },
);

const emit = defineEmits<{
  uploaded: [UploadedFileResponse];
  remove: [string];
}>();

const toasts = useToastStore();
const input = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const busy = ref(false);

async function handleFiles(list: FileList | null) {
  if (!list || list.length === 0 || props.disabled) return;
  busy.value = true;
  try {
    const picked = props.multiple ? Array.from(list) : [list[0]!];
    for (const file of picked) {
      const uploaded = await uploadFile(file, props.purpose);
      emit('uploaded', uploaded);
    }
  } catch (error) {
    const message =
      error instanceof ApiRequestError ? error.message : 'Não foi possível enviar o arquivo.';
    toasts.error('Falha no envio', message);
  } finally {
    busy.value = false;
    if (input.value) input.value.value = '';
  }
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  void handleFiles(event.dataTransfer?.files ?? null);
}
</script>

<template>
  <div>
    <button
      type="button"
      class="flex w-full flex-col items-center justify-center rounded-card border-2 border-dashed px-6 py-10 text-center transition-colors"
      :class="[
        dragging ? 'border-brand-500 bg-brand-50' : 'border-line bg-surface-muted/40 hover:border-brand-400',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
      ]"
      :disabled="disabled || busy"
      :aria-label="title"
      @click="input?.click()"
      @dragover.prevent="dragging = !disabled"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <Loader2 v-if="busy" class="mb-3 size-7 animate-spin text-brand-500" />
      <Upload v-else class="mb-3 size-7 text-ink-muted" aria-hidden="true" />
      <span class="text-[15px] font-medium text-ink">
        {{ disabled ? (disabledReason ?? title) : title }}
      </span>
      <span v-if="hint" class="mt-1 text-[13px] text-ink-muted">{{ hint }}</span>
      <span v-if="maxLabel" class="mt-1 text-[13px] text-ink-muted">{{ maxLabel }}</span>
    </button>

    <input
      ref="input"
      type="file"
      class="sr-only"
      :accept="accept"
      :multiple="multiple"
      :disabled="disabled"
      @change="handleFiles(($event.target as HTMLInputElement).files)"
    />

    <div v-if="files && files.length > 0" class="mt-4">
      <p class="mb-2 text-sm font-medium text-ink">Arquivos anexados ({{ files.length }})</p>
      <ul class="flex flex-wrap gap-3">
        <li v-for="file in files" :key="file.fileId" class="relative">
          <a
            :href="file.url"
            target="_blank"
            rel="noopener"
            class="flex items-center gap-2 rounded-control border border-line bg-surface p-2 pr-8 text-sm text-ink transition-colors hover:border-brand-400"
          >
            <img
              v-if="/\.(png|jpe?g|webp)$/i.test(file.originalName)"
              :src="file.url"
              :alt="file.originalName"
              class="size-16 rounded object-cover"
            />
            <FileText v-else class="size-5 text-ink-muted" />
            <span class="max-w-[160px] truncate">{{ file.originalName }}</span>
          </a>
          <button
            type="button"
            class="absolute right-1 top-1 rounded bg-surface p-1 text-ink-muted transition-colors hover:text-negative"
            :aria-label="`Remover ${file.originalName}`"
            @click="emit('remove', file.fileId)"
          >
            <X class="size-3.5" />
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
