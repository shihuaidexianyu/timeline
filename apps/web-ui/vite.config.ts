import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined
          }

          if (
            id.includes('echarts-for-react')
          ) {
            return 'vendor-echarts-react'
          }

          if (id.includes('zrender')) {
            return 'vendor-zrender'
          }

          if (id.includes('echarts')) {
            return 'vendor-echarts'
          }

          if (id.includes('react')) {
            return 'vendor-react'
          }

          return 'vendor'
        },
      },
    },
  },
})
