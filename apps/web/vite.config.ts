// apps/web/vite.config.ts
import { defineConfig } from 'vite';
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
    plugins: [
        wasm(),
        topLevelAwait(),
        {
            name: 'brotli-header-injector',
            configureServer(server) {
                server.middlewares.use((req, res, next) => {
                    if (req.url?.endsWith('.arrow.br')) {
                        res.setHeader('Content-Encoding', 'br');
                        res.setHeader('Content-Type', 'application/vnd.apache.arrow.stream');
                        req.url = req.url;
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
        outDir: 'dist', // This will be apps/web/dist
        emptyOutDir: true,
    }
});