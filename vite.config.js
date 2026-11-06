import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'
import { fileURLToPath } from 'node:url'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxy = { '/api': { target: env.API_PROXY_TARGET || 'http://127.0.0.1:8000', changeOrigin: false } }
  return {
  plugins: [vue()],
  server: {
    proxy,
    // Generated QA artifacts can be held open by Chrome on Windows.
    watch: { ignored: ['**/.tmp/**', '**/*.tmpdir/**'] },
  },
  preview: { proxy },
  build: {
    // MapLibre's indivisible main module builds to about 544 kB.
    chunkSizeWarningLimit: 550,
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        constructionReference: fileURLToPath(new URL('./construction-reference.html', import.meta.url)),
      },
      output: {
        codeSplitting: {
          groups: [
            { name: 'maplibre-shared', test: /node_modules[\\/]maplibre-gl[\\/]dist[\\/]maplibre-gl-shared\.mjs/ },
            { name: 'maplibre', test: /node_modules[\\/]maplibre-gl[\\/]/ },
            { name: 'echarts', test: /node_modules[\\/]echarts[\\/]/ },
            { name: 'turf', test: /node_modules[\\/]@turf[\\/]/ },
          ],
        },
      },
    },
  },
  }
})
