// apps/web/vite.config.ts
import { defineConfig } from 'vite';
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
    plugins: [
        wasm(),
        topLevelAwait()
    ],
    resolve: {
        alias: {
            events: 'eventemitter3',
        },
    },
    optimizeDeps: {
        // Exclude the WASM-heavy lib so Vite doesn't try to bundle it
        exclude: ['@geoarrow/geoparquet-wasm'],
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
        target: 'esnext'
    }
});