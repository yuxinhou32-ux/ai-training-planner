/**
 * React 入口：QueryClientProvider + App（§8.4 服务端状态全部走 TanStack Query）。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.js';
import './theme.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('缺少 #root 挂载点');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
