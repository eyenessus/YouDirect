<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { Globe } from 'lucide-vue-next';
import { formatCentsBRL, type VehicleOffer } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/** Oferta do veículo no site da locadora: grupo "ou similar", preço semanal, caução e km. */
const props = defineProps<{ vehicleId: string; offer: VehicleOffer | null | undefined }>();
const emit = defineEmits<{ saved: [VehicleOffer | null] }>();
const auth = useAuthStore();
const toasts = useToastStore();
const editing = ref(false);
const saving = ref(false);
const errors = ref<Record<string, string>>({});
const form = reactive({
  showOnSite: true,
  groupName: '',
  weeklyPriceCents: 0,
  depositCents: 0,
  kmPolicy: 'UNLIMITED' as 'UNLIMITED' | 'FRANCHISE',
  weeklyKmFranchise: '',
  highlights: '',
});

watch(
  () => props.offer,
  (o) => {
    Object.assign(form, {
      showOnSite: o?.showOnSite ?? true,
      groupName: o?.groupName ?? '',
      weeklyPriceCents: o?.weeklyPriceCents ?? 0,
      depositCents: o?.depositCents ?? 0,
      kmPolicy: o?.kmPolicy ?? 'UNLIMITED',
      weeklyKmFranchise: o?.weeklyKmFranchise ? String(o.weeklyKmFranchise) : '',
      highlights: (o?.highlights ?? []).join(', '),
    });
  },
  { immediate: true },
);

async function save() {
  saving.value = true;
  errors.value = {};
  try {
    const res = await api.put<{ offer: VehicleOffer }>(`/vehicles/${props.vehicleId}/offer`, {
      showOnSite: form.showOnSite,
      groupName: form.groupName,
      weeklyPriceCents: form.weeklyPriceCents,
      depositCents: form.depositCents,
      kmPolicy: form.kmPolicy,
      weeklyKmFranchise: form.kmPolicy === 'FRANCHISE' ? Number(form.weeklyKmFranchise) || null : null,
      highlights: form.highlights.split(',').map((h) => h.trim()).filter(Boolean).slice(0, 6),
    });
    editing.value = false;
    emit('saved', res.offer);
    toasts.success('Oferta salva');
  } catch (err) {
    if (err instanceof ApiRequestError) {
      errors.value = err.fieldErrors();
      if (!Object.keys(errors.value).length) toasts.error('Não foi possível salvar', err.message);
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="fo-card p-8" aria-label="Oferta no site">
    <div class="mb-4 flex items-center justify-between gap-3">
      <h2 class="flex items-center gap-2.5 text-xl font-bold text-ink"><Globe class="size-5 text-ink-soft" aria-hidden="true" /> Oferta no site</h2>
      <AppButton v-if="auth.allows('vehicles', 'update') && !editing" size="sm" variant="secondary" @click="editing = true">
        {{ offer ? 'Editar' : 'Definir oferta' }}
      </AppButton>
    </div>

    <template v-if="!editing">
      <p v-if="!offer" class="text-[15px] text-ink-muted">Este carro não aparece no site da locadora.</p>
      <dl v-else class="grid gap-4 sm:grid-cols-4">
        <div>
          <dt class="text-[15px] text-ink-muted">Grupo</dt>
          <dd class="mt-1 font-semibold text-ink">{{ offer.groupName }}</dd>
        </div>
        <div>
          <dt class="text-[15px] text-ink-muted">Semanal</dt>
          <dd class="mt-1 font-semibold tabular text-ink">{{ formatCentsBRL(offer.weeklyPriceCents) }}</dd>
        </div>
        <div>
          <dt class="text-[15px] text-ink-muted">KM</dt>
          <dd class="mt-1 text-ink">{{ offer.kmPolicy === 'UNLIMITED' ? 'Livre' : `${offer.weeklyKmFranchise} km/semana` }}</dd>
        </div>
        <div>
          <dt class="text-[15px] text-ink-muted">No site</dt>
          <dd class="mt-1 text-ink">{{ offer.showOnSite ? 'Visível' : 'Oculto' }}</dd>
        </div>
      </dl>
    </template>

    <div v-else class="grid gap-4 md:grid-cols-3">
      <FormField v-slot="field" label="Grupo" required hint="Ex.: Compacto, Hatch, Sedã, SUV" :error="errors.groupName">
        <AppInput :id="field.id" v-model="form.groupName" :invalid="field.invalid" />
      </FormField>
      <FormField v-slot="field" label="Valor semanal" required :error="errors.weeklyPriceCents">
        <CurrencyInput :id="field.id" v-model="form.weeklyPriceCents" :invalid="field.invalid" />
      </FormField>
      <FormField v-slot="field" label="Caução" :error="errors.depositCents">
        <CurrencyInput :id="field.id" v-model="form.depositCents" />
      </FormField>
      <FormField v-slot="field" label="Quilometragem">
        <AppSelect
          :id="field.id"
          v-model="form.kmPolicy"
          :options="[
            { value: 'UNLIMITED', label: 'KM livre' },
            { value: 'FRANCHISE', label: 'Franquia semanal' },
          ]"
        />
      </FormField>
      <FormField v-if="form.kmPolicy === 'FRANCHISE'" v-slot="field" label="KM por semana" :error="errors.weeklyKmFranchise">
        <AppInput :id="field.id" v-model="form.weeklyKmFranchise" type="number" inputmode="numeric" />
      </FormField>
      <FormField v-slot="field" label="Destaques" hint="Separados por vírgula" :error="errors.highlights">
        <AppInput :id="field.id" v-model="form.highlights" placeholder="Ar-condicionado, Direção elétrica" />
      </FormField>
      <div class="flex items-end gap-3 md:col-span-3">
        <AppCheckbox v-model="form.showOnSite" label="Mostrar no site" />
        <span class="flex-1" />
        <AppButton variant="secondary" @click="editing = false">Cancelar</AppButton>
        <AppButton :loading="saving" @click="save">Salvar</AppButton>
      </div>
    </div>
  </section>
</template>
