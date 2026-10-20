import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const connectionSchema = z.object({ port: z.number().int(), token: z.string().min(1) });
export default defineConfig({
  base: './',
  plugins: [react(), {
    name: 'centre-development-refresh',
    apply: 'serve',
    transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
  }],
  server: {
    host: '127.0.0.1', port: 5186, strictPort: true,
    watch: { ignored: ['**/release/**', '**/dist-electron/**'] },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4319',
        configure(proxy) {
          proxy.on('proxyReq', (req) => {
            try {
              const connection = connectionSchema.parse(JSON.parse(readFileSync('.runtime/connection.json', 'utf8')));
              req.setHeader('Authorization', `Bearer ${connection.token}`);
            } catch {
              req.removeHeader('Authorization');
            }
          });
        },
      },
    },
  },
});
