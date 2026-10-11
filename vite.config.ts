import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true, // Listen on all network interfaces for Quest 3 local Wi-Fi debugging
    port: 5173,
    open: false
  },
  build: {
    target: 'esnext'
  }
});
