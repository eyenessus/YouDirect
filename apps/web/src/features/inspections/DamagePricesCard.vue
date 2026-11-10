<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { Wrench } from 'lucide-vue-next';
import type { DamagePrice } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/** Tabela de avarias: preços usados na cobrança de avarias das vistorias. */
const auth = useAuthStore();
const toasts = useToastStore();
const prices = ref<DamagePrice[]>([]);
const editing = ref<Record<string, number>>({});
const draft = reactive({ name: '', category: '', priceCents: 0 });
const canEdit = computed(() => auth.allows('inspections', 'update'));

async function load() {
  prices.value = (await api.get<{ data: DamagePrice[] }>('/damage-prices')).data;
}

async function save(p: DamagePrice, patch: Partial<DamagePrice>) {
  try {
    const updated = await api.patch<DamagePrice>(`/damage-prices/${p.id}`, patch);
    Object.assign(p, updated);
    delete editing.value[p.id];
    toasts.success('Avaria atualizada');
  } catch (err) {
    toasts.error('Não foi possível salvar', err instanceof ApiRequestError ? err.message : undefined);
  }
}

async function add() {
  try {
    await api.post('/damage-prices', { ...draft });
    Object.assign(draft, { name: '', category: '', priceCents: 0 });
    await load();
    toasts.success('Avaria adicionada');
  } catch (err) {
    toasts.error('Não foi possível adicionar', err instanceof ApiRequestError ? err.message : undefined);
  }
}

onMounted(() => void load().catch(() => undefined));
</script>

<template>
  <section class="fo-card p-7" aria-label="Tabela de avarias">
    <h2 class="mb-2 flex items-center gap-2.5 text-xl font-bold text-ink"><Wrench class="size-5 text-ink-soft" aria-hidden="true" /> Tabela de avarias</h2>
    <p class="mb-5 text-[15px] text-ink-muted">Valores cobrados do motorista quando a vistoria encontra avarias. Ajuste à sua realidade.</p>
    <div class="divide-y divide-line">
      <div v-for="p in prices" :key="p.id" class="grid grid-cols-[1fr_140px_auto] items-center gap-3 py-2" :class="p.active ? '' : 'opacity-50'">
        <div>
          <p class="text-[15px] text-ink">{{ p.name }}</p>
          <p class="text-sm text-ink-muted">{{ p.category }}</p>
        </div>
        <CurrencyInput
          :model-value="editing[p.id] ?? p.priceCents"
          :disabled="!canEdit"
          :aria-label="`Preço de ${p.name}`"
          @update:model-value="(v: number) => (editing[p.id] = v)"
        />
        <div v-if="canEdit" class="flex gap-2">
          <AppButton v-if="editing[p.id] !== undefined" size="sm" @click="save(p, { priceCents: editing[p.id] })">Salvar</AppButton>
          <AppButton size="sm" variant="ghost" @click="save(p, { active: !p.active })">{{ p.active ? 'Desativar' : 'Ativar' }}</AppButton>
        </div>
      </div>
    </div>
    <div v-if="canEdit" class="mt-5 grid gap-3 md:grid-cols-[1fr_180px_140px_auto]">
      <AppInput v-model="draft.name" placeholder="Nova avaria (ex.: Tapete)" aria-label="Nome da avaria" />
      <AppInput v-model="draft.category" placeholder="Categoria" aria-label="Categoria da avaria" />
      <CurrencyInput v-model="draft.priceCents" aria-label="Preço da nova avaria" />
      <AppButton :disabled="!draft.name || !draft.category || !draft.priceCents" @click="add">Adicionar</AppButton>
    </div>
  </section>
</template>
