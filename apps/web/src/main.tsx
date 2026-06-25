import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ThemeProvider } from '@/components/theme-provider';
import { SidebarThemeProvider } from '@/lib/sidebar-theme';
import { Toaster } from '@/components/ui/toaster';
import { queryClient } from '@/lib/query-client';
import '@/lib/i18n/i18n';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <SidebarThemeProvider>
              <BrowserRouter>
                <App />
                <Toaster />
              </BrowserRouter>
            </SidebarThemeProvider>
          </ThemeProvider>
        </QueryClientProvider>
  </StrictMode>,
);
