// Aplica o tema antes da primeira pintura para evitar flash (fora do HTML
// para que a Content-Security-Policy dispense 'unsafe-inline').
(function () {
  try {
    var stored = localStorage.getItem('yudirect:theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = stored === 'light' || stored === 'dark' ? stored : prefersDark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
