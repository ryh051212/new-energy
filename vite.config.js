import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    // Generated QA artifacts can be held open by Chrome on Windows.
    watch: { ignored: ['**/.tmp/**'] },
  },
  build: {
    // MapLibre's indivisible main module builds to about 544 kB.
    chunkSizeWarningLimit: 550,
    rolldownOptions: {
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
})
