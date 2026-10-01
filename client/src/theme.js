// Tema claro/escuro: guarda a escolha neste aparelho; "system" segue o aparelho.
const KEY = 'fluxo_theme';
export const getTheme = () => { try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; } };
export const isDark = (theme = getTheme()) => theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
export function setTheme(theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* sem armazenamento: vale só nesta visita */ }
  document.documentElement.classList.toggle('dark', isDark(theme) && !location.pathname.startsWith('/p/'));
}
