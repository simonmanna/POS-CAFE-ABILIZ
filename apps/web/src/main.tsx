import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { App } from './App';
import { ThemeProvider } from '@/components/theme-provider';
import { SidebarThemeProvider } from '@/lib/sidebar-theme';
import { Toaster } from '@/components/ui/toaster';
import { queryClient, persistOptions } from '@/lib/query-client';
import { installServiceWorkerUpdater } from '@/lib/sw-update';
import '@/lib/i18n/i18n';
import './index.css';

// Keep the till on the latest deployed build: check for service-worker
// updates periodically + on focus, and reload once when a new build takes
// control (see lib/sw-update.ts for why a till must not run stale code).
installServiceWorkerUpdater();

// P3: rehydrate the cached catalog from IndexedDB before the first render, so
// a terminal that reloads while the LAN server is down still shows the menu
// and keeps selling into the offline queue.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <ThemeProvider>
        <SidebarThemeProvider>
          <BrowserRouter>
            <App />
            <Toaster />
          </BrowserRouter>
        </SidebarThemeProvider>
      </ThemeProvider>
    </PersistQueryClientProvider>
  </StrictMode>,
);
