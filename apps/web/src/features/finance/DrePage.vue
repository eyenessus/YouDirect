<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Download, FileText, RefreshCw } from 'lucide-vue-next';
import { formatCentsBRL, monthNamesPtBr, type DreReport } from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

const auth = useAuthStore();
const toasts = useToastStore();

const today = new Date();
const month = ref(today.getMonth() + 1);
const year = ref(today.getFullYear());

const report = ref<DreReport | null>(null);
const loading = ref(true);
const exporting = ref(false);

const monthOptions = monthNamesPtBr.map((label, index) => ({ value: String(index + 1), label }));
const yearOptions = Array.from({ length: 6 }, (_, i) => {
  const value = today.getFullYear() - 3 + i;
  return { value: String(value), label: String(value) };
});

const signPrefix = { PLUS: '(+)', MINUS: '(-)', EQUALS: '(=)', NONE: '' } as const;

/**
 * A referência escreve "Novembro De 2026" — o nome do mês com a
 * preposição, capitalizado palavra a palavra (pág. 009). O resto da
 * aplicação usa "Novembro 2026"; só a DRE traz a preposição.
 */
const monthTitle = computed(() => {
  if (!report.value) return '';
  const month = report.value.monthLabel.split(' ')[0] ?? '';
  return `${month} de ${report.value.year}`.replace(/\b(\w)/g, (c) => c.toUpperCase());
});

async function load() {
  loading.value = true;
  try {
    report.value = await api.get<DreReport>('/reports/dre', {
      query: { month: month.value, year: year.value },
    });
  } catch {
    toasts.error('Falha ao carregar a DRE');
  } finally {
    loading.value = false;
  }
}

async function exportPdf() {
  exporting.value = true;
  try {
    await downloadFile('/reports/dre.pdf', `dre-${year.value}-${month.value}.pdf`, {
      month: month.value,
      year: year.value,
    });
  } catch (err) {
    toasts.error('Não foi possível gerar o PDF', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    exporting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="FINANCEIRO"
      title="DRE Mensal"
      subtitle="Demonstração do Resultado do Exercício da locadora"
    >
      <template #actions>
        <div class="w-[170px]">
          <AppSelect
            :model-value="String(month)"
            :options="monthOptions"
            @update:model-value="
              month = Number($event);
              load();
            "
          />
        </div>
        <div class="w-[110px]">
          <AppSelect
            :model-value="String(year)"
            :options="yearOptions"
            @update:model-value="
              year = Number($event);
              load();
            "
          />
        </div>
        <AppButton variant="ghost" aria-label="Atualizar" @click="load">
          <template #icon><RefreshCw class="size-4" /></template>
        </AppButton>
        <AppButton
          v-if="auth.allows('finance', 'export')"
          variant="secondary"
          :loading="exporting"
          @click="exportPdf"
        >
          <template #icon><Download class="size-4" /></template>
          Baixar PDF
        </AppButton>
      </template>
    </PageHeader>

    <AppSkeleton v-if="loading" variant="cards" :rows="3" />

    <template v-else-if="report">
      <div class="grid gap-5 lg:grid-cols-3">
        <div class="fo-card p-6">
          <p class="text-[15px] text-ink-soft">Receita líquida</p>
          <p class="mt-3 text-[30px] font-bold tabular text-[rgb(var(--c-positive))]">
            {{ formatCentsBRL(report.netRevenueCents) }}
          </p>
        </div>
        <div class="fo-card p-6">
          <p class="text-[15px] text-ink-soft">Lucro bruto</p>
          <p class="mt-3 text-[30px] font-bold tabular text-[rgb(var(--c-positive))]">
            {{ formatCentsBRL(report.grossProfitCents) }}
          </p>
        </div>
        <div class="fo-card p-6">
          <p class="text-[15px] text-ink-soft">Resultado do exercício</p>
          <p class="mt-3 text-[30px] font-bold tabular text-[rgb(var(--c-positive))]">
            {{ formatCentsBRL(report.netResultCents) }}
          </p>
        </div>
      </div>

      <section class="fo-card overflow-hidden p-6">
        <div class="mb-5 flex items-center gap-4">
          <span class="flex size-11 items-center justify-center rounded-xl bg-brand-50">
            <FileText class="size-5 text-brand-600" aria-hidden="true" />
          </span>
          <div>
            <h2 class="text-xl font-bold text-ink">{{ monthTitle }}</h2>
            <p class="mt-0.5 text-[15px] text-ink-muted">
              {{ report.organization.name }}
              <span v-if="report.organization.legalId"> · {{ report.organization.legalId }}</span>
            </p>
          </div>
        </div>

        <div class="fo-scroll-x">
          <table class="fo-table">
            <caption class="sr-only">Demonstração do resultado do exercício</caption>
            <tbody>
              <tr
                v-for="line in report.lines"
                :key="line.key"
                :class="line.emphasis ? 'bg-surface-muted/60' : ''"
              >
                <td :style="{ paddingLeft: `${16 + line.level * 20}px` }">
                  <span :class="line.emphasis ? 'font-bold text-ink' : 'text-ink-soft'">
                    <span v-if="signPrefix[line.sign]" class="mr-1">{{ signPrefix[line.sign] }}</span>
                    {{ line.label }}
                  </span>
                </td>
                <td class="text-right">
                  <span
                    class="tabular"
                    :class="[
                      line.emphasis ? 'font-bold' : '',
                      line.emphasis && line.positive
                        ? 'text-[rgb(var(--c-positive))]'
                        : line.key === 'net-result'
                          ? 'text-brand-600'
                          : 'text-ink',
                    ]"
                  >
                    {{ formatCentsBRL(line.amountCents) }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="mt-5 text-[15px] leading-relaxed text-ink-muted">{{ report.footnote }}</p>
      </section>
    </template>
  </div>
</template>
