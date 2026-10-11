import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages では https://<user>.github.io/video-editor/ で公開されるため base を合わせる
export default defineConfig({
  base: '/video-editor/',
  plugins: [react()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
});
