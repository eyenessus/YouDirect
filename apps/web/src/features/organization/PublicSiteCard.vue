<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { Globe } from 'lucide-vue-next';
import type { PublicSiteSettings } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppTextarea from '@/components/ui/AppTextarea.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

/** Site da locadora (vitrine + pedido de reserva) e contatos da Área do Motorista. */
const toasts = useToastStore();
const saving = ref(false);
const errors = ref<Record<string, string>>({});
const form = reactive({
  publicSlug: '',
  enabled: false,
  headline: '',
  about: '',
  city: '',
  whatsappPhone: '',
  emergencyPhone: '',
  requirements: '',
});
const url = computed(() => (form.publicSlug ? `${window.location.origin}/l/${form.publicSlug}` : null));

function fill(s: PublicSiteSettings) {
  Object.assign(form, {
    publicSlug: s.publicSlug ?? '',
    enabled: s.enabled,
    headline: s.headline ?? '',
    about: s.about ?? '',
    city: s.city ?? '',
    whatsappPhone: s.whatsappPhone ?? '',
    emergencyPhone: s.emergencyPhone ?? '',
    requirements: s.requirements.join('\n'),
  });
}

async function save() {
  saving.value = true;
  errors.value = {};
  try {
    const saved = await api.patch<PublicSiteSettings>('/public-site/settings', {
      publicSlug: form.publicSlug.trim() || null,
      enabled: form.enabled,
      headline: form.headline,
      about: form.about,
      city: form.city,
      whatsappPhone: form.whatsappPhone,
      emergencyPhone: form.emergencyPhone,
      requirements: form.requirements.split('\n').map((r) => r.trim()).filter(Boolean),
    });
    fill(saved);
    toasts.success('Site da locadora salvo');
  } catch (err) {
    if (err instanceof ApiRequestError) {
      errors.value = err.fieldErrors();
      if (!Object.keys(errors.value).length) toasts.error('Não foi possível salvar', err.message);
    }
  } finally {
    saving.value = false;
  }
}

onMounted(async () => fill(await api.get<PublicSiteSettings>('/public-site/settings')));
</script>

<template>
  <section class="fo-card p-7 xl:col-span-2" aria-label="Site da locadora">
    <h2 class="mb-2 flex items-center gap-2.5 text-xl font-bold text-ink">
      <Globe class="size-5 text-ink-soft" aria-hidden="true" /> Site da locadora e Área do Motorista
    </h2>
    <p class="mb-5 text-[15px] text-ink-muted">
      Vitrine dos grupos de carros com preço semanal e pedido de reserva on-line. Os contatos também aparecem para os motoristas.
      A oferta de cada carro (grupo e preço) é definida na página do veículo.
    </p>
    <div class="grid gap-5 md:grid-cols-2">
      <FormField v-slot="field" label="Endereço do site" hint="Letras minúsculas, números e hífen" :error="errors.publicSlug">
        <AppInput :id="field.id" v-model="form.publicSlug" placeholder="minha-locadora" :invalid="field.invalid" />
      </FormField>
      <div class="flex flex-col justify-end gap-2">
        <AppCheckbox v-model="form.enabled" label="Site publicado" />
        <a v-if="url && form.enabled" :href="url" target="_blank" rel="noopener" class="break-all text-sm font-semibold text-brand-600 hover:underline">{{ url }}</a>
      </div>
      <FormField v-slot="field" label="Título" :error="errors.headline">
        <AppInput :id="field.id" v-model="form.headline" placeholder="Carro para rodar no app, com manutenção inclusa" />
      </FormField>
      <FormField v-slot="field" label="Cidade" :error="errors.city">
        <AppInput :id="field.id" v-model="form.city" placeholder="São Paulo/SP" />
      </FormField>
      <FormField v-slot="field" class="md:col-span-2" label="Sobre a locadora" :error="errors.about">
        <AppTextarea :id="field.id" v-model="form.about" :rows="2" />
      </FormField>
      <FormField v-slot="field" label="WhatsApp da locadora" :error="errors.whatsappPhone">
        <AppInput :id="field.id" v-model="form.whatsappPhone" inputmode="tel" placeholder="(11) 90000-0000" :invalid="field.invalid" />
      </FormField>
      <FormField v-slot="field" label="Telefone de emergência / guincho" :error="errors.emergencyPhone">
        <AppInput :id="field.id" v-model="form.emergencyPhone" inputmode="tel" :invalid="field.invalid" />
      </FormField>
      <FormField v-slot="field" class="md:col-span-2" label="Requisitos (um por linha)" :error="errors.requirements">
        <AppTextarea :id="field.id" v-model="form.requirements" :rows="3" />
      </FormField>
    </div>
    <div class="mt-5 flex justify-end">
      <AppButton :loading="saving" @click="save">Salvar</AppButton>
    </div>
  </section>
</template>
