import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { setUnauthorizedHandler } from './lib/api';
import { useAuthStore } from './stores/auth';
import './styles/main.css';

const app = createApp(App);
app.use(createPinia());

setUnauthorizedHandler(() => {
  const auth = useAuthStore();
  auth.clear();
  if (router.currentRoute.value.meta.public !== true) {
    void router.replace({ name: 'login', query: { expired: '1' } });
  }
});

app.use(router);
app.mount('#app');
