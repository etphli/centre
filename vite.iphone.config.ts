import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'mobile-web',
  base: '/iphone/',
  plugins: [react()],
  build: { outDir: '../dist-iphone/iphone', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5318, strictPort: true },
});
