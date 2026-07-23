import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // This output is an Android build intermediate consumed by Capacitor.
  base: './',
  build: {
    outDir: 'android-web',
    emptyOutDir: true,
  },
})
