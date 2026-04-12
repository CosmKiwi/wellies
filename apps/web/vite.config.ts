// apps/web/vite.config.ts
import { defineConfig } from 'vite';
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';

export default defineConfig({
    plugins: [
        tailwindcss(),
        wasm(),
        topLevelAwait(),
        {
            name: 'raw-binary-server',
            configureServer(server) {
                server.middlewares.use((req, res, next) => {
                    if (req.url && req.url.endsWith('.arrow.gz')) {
                        const urlPath = req.url.split('?')[0];
                        const filePath = path.join(server.config.publicDir, urlPath);

                        if (fs.existsSync(filePath)) {
                            res.setHeader('Content-Type', 'application/octet-stream');
                            res.setHeader('Cache-Control', 'no-cache');
                            res.setHeader('Access-Control-Allow-Origin', '*');
                            fs.createReadStream(filePath).pipe(res);
                            return;
                        } else {
                            console.error(`🚨 Vite Middleware could not find file at: ${filePath}`);
                        }
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