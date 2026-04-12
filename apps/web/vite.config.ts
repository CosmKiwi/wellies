// apps/web/vite.config.ts
import { defineConfig } from 'vite';
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
    plugins: [
        tailwindcss(),
        wasm(),
        topLevelAwait()
    ],
    resolve: {
        alias: {
            events: 'eventemitter3',
        },
    },
    optimizeDeps: {
        include: [
            '@deck.gl/core',
            '@deck.gl/layers',
            'apache-arrow',
            '@geoarrow/deck.gl-layers'
        ],
    },
    server: {
        port: 4321,
        fs: {
            allow: ['../..']
        }
    },
    build: {
        target: 'esnext',
        outDir: 'dist',
        emptyOutDir: true,
    }
});