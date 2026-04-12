// apps/web/vite.config.ts
import { defineConfig } from 'vite';
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
    plugins: [
        tailwindcss(),
        wasm(),
        topLevelAwait(),
        {
            name: 'brotli-header-injector',
            configureServer(server) {
                server.middlewares.use((req, res, next) => {
                    // 👻 LOCAL GHOST EXTENSION TRICK
                    // If the frontend asks for an uncompressed file...
                    if (req.url?.endsWith('.arrow')) {
                        // 1. Set the Zero-Copy headers
                        res.setHeader('Content-Encoding', 'br');
                        res.setHeader('Content-Type', 'application/vnd.apache.arrow.stream');

                        // 2. Secretly rewrite the internal URL so Vite finds the compressed file on disk
                        req.url = req.url + '.br';
                    }
                    next();
                });
            }
        }
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