import React from 'react';
import ReactDOM from 'react-dom/client';
import { emit, listen } from '@tauri-apps/api/event';
import App from './App';
import { APP_FEEDBACK_ERROR_EVENT, normalizeAppError } from './lib/appFeedback';
import { LocaleProvider } from './lib/i18n';
import { bootstrapLocale } from './lib/locale';
import { createLocaleRuntime, type LocaleRuntimeRole } from './lib/localeRuntime';
import { bootstrapTheme } from './lib/theme';
import { createThemeRuntime, type ThemeRuntimeRole } from './lib/themeRuntime';
import { setNativeLocalePreference, setNativeThemePreference } from './lib/tauriCommands';

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
const pane = new URLSearchParams(window.location.search).get('pane');
const role: ThemeRuntimeRole = pane === 'editor' || pane === 'preview'
  ? 'popout'
  : 'main';
const localeRole: LocaleRuntimeRole = role;
const reportThemeError = (error: unknown) => {
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent(APP_FEEDBACK_ERROR_EVENT, {
      detail: normalizeAppError(error),
    }));
  }, 0);
};
const bootstrap = bootstrapTheme({
  root: document.documentElement,
  storage: window.localStorage,
  systemDark: mediaQuery.matches,
  repairStorage: role === 'main',
  onError: reportThemeError,
});
const localeBootstrap = bootstrapLocale({
  root: document.documentElement,
  storage: window.localStorage,
  systemLanguage: navigator.language,
  repairStorage: localeRole === 'main',
  onError: reportThemeError,
});
const themeRuntime = createThemeRuntime({
  role,
  root: document.documentElement,
  storage: window.localStorage,
  mediaQuery,
  storageEvents: window,
  eventApi: {
    emit: (event, payload) => emit(event, payload),
    listen: (event, listener) => listen(event, listener),
  },
  initialPreference: bootstrap.preference,
  syncNativePreference: role === 'main' ? setNativeThemePreference : undefined,
  onError: reportThemeError,
});
void themeRuntime.start();
const localeRuntime = createLocaleRuntime({
  role: localeRole,
  root: document.documentElement,
  storage: window.localStorage,
  storageEvents: window,
  eventApi: {
    emit: (event, payload) => emit(event, payload),
    listen: (event, listener) => listen(event, listener),
  },
  systemLanguage: navigator.language,
  initialPreference: localeBootstrap.preference,
  syncNativePreference: localeRole === 'main' ? setNativeLocalePreference : undefined,
  onError: reportThemeError,
});
void localeRuntime.start();
window.addEventListener('pagehide', () => {
  themeRuntime.stop();
  localeRuntime.stop();
}, { once: true });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocaleProvider runtime={localeRuntime}>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
);
