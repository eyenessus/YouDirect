<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { AlertCircle, CheckCircle2, Upload } from 'lucide-vue-next';
import {
  formatCentsBRL,
  VEHICLE_IMPORT_MAX_ROWS,
  type VehicleImportPreview,
  type VehicleImportResult,
} from '@frotaone/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

const router = useRouter();
const toasts = useToastStore();

const input = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const uploading = ref(false);
const committing = ref(false);
const preview = ref<VehicleImportPreview | null>(null);
const result = ref<VehicleImportResult | null>(null);
const selected = ref<Set<number>>(new Set());

const validLines = computed(() =>
  (preview.value?.rows ?? []).filter((r) => r.errors.length === 0).map((r) => r.line),
);

async function handleFile(files: FileList | null) {
  const file = files?.[0];
  if (!file) return;
  uploading.value = true;
  result.value = null;
  try {
    const form = new FormData();
    form.append('file', file);
    preview.value = await api.post<VehicleImportPreview>('/vehicles/import/preview', form);
    selected.value = new Set(validLines.value);
  } catch (err) {
    toasts.error(
      'Não foi possível ler a planilha',
      err instanceof ApiRequestError ? err.message : undefined,
    );
  } finally {
    uploading.value = false;
    if (input.value) input.value.value = '';
  }
}

function toggle(line: number) {
  const next = new Set(selected.value);
  if (next.has(line)) next.delete(line);
  else next.add(line);
  selected.value = next;
}

async function commit() {
  if (!preview.value || selected.value.size === 0) return;
  committing.value = true;
  try {
    result.value = await api.post<VehicleImportResult>('/vehicles/import/commit', {
      token: preview.value.token,
      lines: [...selected.value],
    });
    toasts.success(
      `${result.value.created} veículo(s) importado(s)`,
      result.value.errors.length > 0 ? `${result.value.errors.length} linha(s) com erro.` : undefined,
    );
    preview.value = null;
  } catch (err) {
    toasts.error(
      'Falha na importação',
      err instanceof ApiRequestError ? err.message : undefined,
    );
  } finally {
    committing.value = false;
  }
}

async function downloadTemplate() {
  try {
    await downloadFile('/vehicles/import/template', 'modelo-importacao-veiculos.xlsx');
  } catch {
    toasts.error('Não foi possível baixar a planilha modelo');
  }
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="FROTA"
      title="Importar Veículos"
      :subtitle="`Importe até ${VEHICLE_IMPORT_MAX_ROWS} veículos de uma vez via planilha .xlsx ou .csv.`"
    />

    <section v-if="!preview && !result" class="fo-card p-7">
      <button
        type="button"
        class="flex w-full flex-col items-center justify-center rounded-card border-2 border-dashed px-6 py-16 text-center transition-colors"
        :class="dragging ? 'border-brand-500 bg-brand-50' : 'border-line hover:border-brand-400'"
        :disabled="uploading"
        @click="input?.click()"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="
          dragging = false;
          handleFile($event.dataTransfer?.files ?? null);
        "
      >
        <Upload class="mb-4 size-9 text-ink-muted" aria-hidden="true" />
        <span class="text-[17px] font-semibold text-ink">
          {{ uploading ? 'Lendo a planilha…' : 'Arraste a planilha ou clique para selecionar' }}
        </span>
        <span class="mt-1.5 text-[15px] text-ink-muted">
          Formatos aceitos: .xlsx, .csv — máximo 5 MB e {{ VEHICLE_IMPORT_MAX_ROWS }} veículos
        </span>
      </button>
      <input
        ref="input"
        type="file"
        class="sr-only"
        accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        @change="handleFile(($event.target as HTMLInputElement).files)"
      />

      <p class="mt-6 text-center text-[15px] text-ink-muted">
        Não tem o modelo?
        <button type="button" class="font-medium text-brand-600 hover:underline" @click="downloadTemplate">
          Baixar planilha modelo
        </button>
      </p>
    </section>

    <!-- Pré-visualização -->
    <section v-if="preview" class="fo-card overflow-hidden">
      <div class="flex flex-wrap items-center justify-between gap-4 border-b border-line p-6">
        <div>
          <h2 class="text-xl font-bold text-ink">Pré-visualização — {{ preview.fileName }}</h2>
          <p class="mt-1 text-[15px] text-ink-muted">
            {{ preview.totalRows }} linha(s) ·
            <span class="text-[rgb(var(--c-positive))]">{{ preview.validRows }} válida(s)</span> ·
            <span class="text-[rgb(var(--c-negative))]">{{ preview.invalidRows }} com erro</span>
          </p>
        </div>
        <div class="flex gap-3">
          <AppButton variant="secondary" @click="preview = null">Cancelar</AppButton>
          <AppButton :loading="committing" :disabled="selected.size === 0" @click="commit">
            Importar {{ selected.size }} veículo(s)
          </AppButton>
        </div>
      </div>

      <div class="fo-scroll-x">
        <table class="fo-table">
          <thead>
            <tr>
              <th scope="col" class="w-12">
                <span class="sr-only">Selecionar</span>
              </th>
              <th scope="col">Linha</th>
              <th scope="col">Placa</th>
              <th scope="col">Marca</th>
              <th scope="col">Modelo</th>
              <th scope="col">Ano</th>
              <th scope="col">Valor</th>
              <th scope="col">Situação</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in preview.rows" :key="row.line">
              <td>
                <input
                  type="checkbox"
                  class="size-[18px] accent-[rgb(var(--c-brand-500))]"
                  :checked="selected.has(row.line)"
                  :disabled="row.errors.length > 0"
                  :aria-label="`Importar linha ${row.line}`"
                  @change="toggle(row.line)"
                />
              </td>
              <td class="tabular">{{ row.line }}</td>
              <td class="font-semibold">{{ row.data.plate || '—' }}</td>
              <td>{{ row.data.brand || '—' }}</td>
              <td>{{ row.data.model || '—' }}</td>
              <td class="tabular">{{ row.data.year ?? '—' }}</td>
              <td class="tabular">
                {{ row.data.purchaseAmountCents ? formatCentsBRL(row.data.purchaseAmountCents) : '—' }}
              </td>
              <td>
                <span
                  v-if="row.errors.length === 0"
                  class="inline-flex items-center gap-1.5 text-sm text-[rgb(var(--c-positive))]"
                >
                  <CheckCircle2 class="size-4" /> Pronto para importar
                </span>
                <span v-else class="inline-flex items-start gap-1.5 text-sm text-[rgb(var(--c-negative))]">
                  <AlertCircle class="mt-0.5 size-4 shrink-0" />
                  <span>{{ row.errors.join(' ') }}</span>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Resultado -->
    <section v-if="result" class="fo-card p-7">
      <h2 class="text-xl font-bold text-ink">Importação concluída</h2>
      <p class="mt-2 text-[15px] text-ink-soft">
        {{ result.created }} veículo(s) criado(s) · {{ result.skipped }} ignorado(s).
      </p>
      <ul v-if="result.errors.length > 0" class="mt-4 space-y-1.5">
        <li v-for="error in result.errors" :key="error.line" class="text-sm text-[rgb(var(--c-negative))]">
          Linha {{ error.line }}: {{ error.message }}
        </li>
      </ul>
      <div class="mt-6 flex gap-3">
        <AppButton @click="router.push('/dashboard/vehicles')">Ver frota</AppButton>
        <AppButton variant="secondary" @click="result = null">Importar outra planilha</AppButton>
      </div>
    </section>
  </div>
</template>
