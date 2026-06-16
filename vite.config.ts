import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Project site is served from https://<user>.github.io/samplesquasher/, so the
// production build needs that base path; dev keeps the root for convenience.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/samplesquasher/' : '/',
  plugins: [react()],
}));
