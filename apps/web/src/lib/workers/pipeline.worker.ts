/// <reference lib="webworker" />
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

const DATA_HOST = import.meta.env.VITE_DATA_HOST || 'https://data.wellies.app';

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;

const ctx: Worker = self as any;

async function syncToOPFS(fileMeta: any) {
    const root = await navigator.storage.getDirectory();
    const parts = fileMeta.path.split('/');
    const targetFileName = parts.pop()!;

    let currentDir = root;
    for (const dir of parts) {
        currentDir = await currentDir.getDirectoryHandle(dir, { create: true });
    }

    let cacheHit = false;

    for await (const [name, handle] of currentDir.entries()) {
        if (name === targetFileName) {
            const file = await (handle as FileSystemFileHandle).getFile();
            if (file.size > 0) cacheHit = true;
        } else if (name.endsWith('.parquet')) {
            console.log(`🧹 [Worker] OPFS Cleanup: Deleting outdated artifact '${name}'...`);
            await currentDir.removeEntry(name);
        }
    }

    const fileHandle = await currentDir.getFileHandle(targetFileName, { create: true });
    if (cacheHit) return fileHandle;

    console.log(`📥 [Worker] Downloading fresh artifact: ${fileMeta.path}...`);
    const remoteUrl = `${DATA_HOST}/${fileMeta.path}`;
    const response = await fetch(remoteUrl);

    if (!response.ok) throw new Error(`Failed to download ${remoteUrl}`);

    const writable = await fileHandle.createWritable();
    await response.body!.pipeTo(writable);

    console.log(`✅ [Worker] Synced: ${fileMeta.path}`);
    return fileHandle;
}

async function initDB() {
    if (db) return;

    console.log("⚙️ [Worker] Booting DuckDB-WASM (Lightning 'eh' Engine)...");

    const worker = new Worker(eh_worker);
    const logger = new duckdb.VoidLogger();

    db = new duckdb.AsyncDuckDB(logger, worker);

    await db.instantiate(duckdb_wasm_eh);

    conn = await db.connect();
    console.log("✅ [Worker] DuckDB Engine Ready!");
}

// Helper function to handle OPFS syncing and mounting for both pipelines
async function mountFiles(options: any, manifest: any) {
    const { bbox } = options;

    // 🚀 Log the bounding range for debugging
    if (bbox) {
        console.log(`🔍 [Worker] Spatial Query | Range: X[${bbox.minX.toFixed(4)}, ${bbox.maxX.toFixed(4)}] Y[${bbox.minY.toFixed(4)}, ${bbox.maxY.toFixed(4)}]`);
    } else {
        console.log(`🔍 [Worker] Spatial Query | Full Extent`);
    }

    const matchedFiles = manifest.files.filter((f: any) => {
        const matchNet = !options.network || f.network === options.network;
        const searchAsset = options.asset ? options.asset.replace(/s$/, '') : '';
        const matchAsset = !options.asset || f.asset.includes(searchAsset);

        let inView = true;
        if (bbox && f.bbox) {
            inView = !(
                bbox.minX > f.bbox.maxX ||
                bbox.maxX < f.bbox.minX ||
                bbox.minY > f.bbox.maxY ||
                bbox.maxY < f.bbox.minY
            );
        }
        return matchNet && matchAsset && inView;
    });

    console.log(`📦 [Worker] Registering ${matchedFiles.length} files for DuckDB...`);

    const filePaths = [];
    for (const f of matchedFiles) {
        const opfsHandle = await syncToOPFS(f);
        const file = await opfsHandle.getFile();
        await db!.registerFileHandle(f.path, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
        filePaths.push(`'${f.path}'`);
    }
    return filePaths;
}

ctx.onmessage = async (e) => {
    const { action, id, payload } = e.data;

    try {
        if (action === 'INIT') {
            await initDB();
            ctx.postMessage({ id, status: 'success' });
            return;
        }

        // ==========================================
        // 🚀 PIPELINE 1: PIPES (Lines + Histogram)
        // ==========================================
        if (action === 'QUERY_PIPES') {
            const { options, manifest } = payload;
            await initDB();

            const filePaths = await mountFiles(options, manifest);
            if (filePaths.length === 0) return ctx.postMessage({ id, status: 'success', data: null });

            const whereClause = options.bbox
                ? `max_x >= ${options.bbox.minX} AND min_x <= ${options.bbox.maxX} AND max_y >= ${options.bbox.minY} AND min_y <= ${options.bbox.maxY}`
                : "1=1";

            // 1. Raw Data Query
            const query = `SELECT * FROM read_parquet([${filePaths.join(', ')}]) WHERE ${whereClause}`;
            const table = await conn!.query(query);
            const numRows = table.numRows;

            if (numRows === 0) return ctx.postMessage({ id, status: 'success', data: null });

            // 2. Aggregate Histogram Query (Safe: Only runs on pipe schema)
            const aggQuery = `
                SELECT 
                    install_year as year, 
                    material_category as material, 
                    COUNT(*) as count, 
                    SUM(length_m) as length
                FROM read_parquet([${filePaths.join(', ')}]) 
                WHERE ${whereClause}
                GROUP BY install_year, material_category
            `;
            const aggTable = await conn!.query(aggQuery);
            const histogramStats = aggTable.toArray().map((row: any) => row.toJSON());

            // 3. Geometry Extraction (Paths)
            const columnNames = table.schema.fields.map((f: any) => f.name);
            const geomFieldName = columnNames.find((n: string) => ['geometry', 'shape', 'coords'].includes(n.toLowerCase()));
            const geomCol = geomFieldName ? table.getChild(geomFieldName) : null;

            const flatCoords = [];
            const pathOffsets = [0];
            let currentOffset = 0;

            for (let i = 0; i < numRows; i++) {
                if (geomCol) {
                    const val = geomCol.get(i);
                    const arr = typeof val?.toArray === 'function' ? val.toArray() : (val?.toJSON ? val.toJSON() : val);
                    if (arr && arr.length > 0) {
                        for (let j = 0; j < arr.length; j++) flatCoords.push(arr[j] ?? 0);
                        currentOffset += arr.length;
                    }
                }
                pathOffsets.push(currentOffset);
            }

            const flatCoordsArray = new Float64Array(flatCoords);
            const vertexOffsets = new Uint32Array(pathOffsets.map(o => o / 2));

            // 4. Attribute Extraction (Strict Pipe Schema)
            const yearsArray = table.getChild('install_year')?.toArray() || new Int32Array(numRows);
            const lengthsArray = table.getChild('length_m')?.toArray() || new Float32Array(numRows);
            const diametersArray = table.getChild('diameter_mm')?.toArray() || new Float32Array(numRows);
            const materialsArray = table.getChild('material_category')?.toJSON() || new Array(numRows).fill('Unknown');
            const idsArray = table.getChild('asset_id')?.toJSON() || new Array(numRows).fill('Pipe');
            const statusesArray = table.getChild('status')?.toJSON() || new Array(numRows).fill('Unknown');
            const watertypesArray = table.getChild('watertype')?.toJSON() || new Array(numRows).fill('Not stated');

            const binaryData: any = {
                length: numRows,
                years: yearsArray,
                lengths: lengthsArray,
                diameters: diametersArray,
                materials: materialsArray,
                ids: idsArray,
                statuses: statusesArray,
                watertypes: watertypesArray,
                histogram: histogramStats,
                startIndices: vertexOffsets.subarray(0, numRows),
                attributes: {
                    getPath: { value: flatCoordsArray, size: 2 }
                }
            };

            ctx.postMessage({ id, status: 'success', data: binaryData }, [
                flatCoordsArray.buffer,
                vertexOffsets.buffer,
                (yearsArray as Int32Array).buffer,
                (lengthsArray as Float32Array).buffer,
                (diametersArray as Float32Array).buffer
            ]);
            return;
        }

        // ==========================================
        // 🚀 PIPELINE 2: JOBS (Points only)
        // ==========================================
        if (action === 'QUERY_JOBS') {
            const { options, manifest } = payload;
            await initDB();

            const filePaths = await mountFiles(options, manifest);
            if (filePaths.length === 0) return ctx.postMessage({ id, status: 'success', data: null });

            const whereClause = options.bbox
                ? `max_x >= ${options.bbox.minX} AND min_x <= ${options.bbox.maxX} AND max_y >= ${options.bbox.minY} AND min_y <= ${options.bbox.maxY}`
                : "1=1";

            const query = `SELECT * FROM read_parquet([${filePaths.join(', ')}]) WHERE ${whereClause}`;
            const table = await conn!.query(query);
            const numRows = table.numRows;

            if (numRows === 0) return ctx.postMessage({ id, status: 'success', data: null });

            // 1. Geometry Extraction (Points)
            const columnNames = table.schema.fields.map((f: any) => f.name);
            const geomFieldName = columnNames.find((n: string) => ['geometry', 'shape', 'coords'].includes(n.toLowerCase()));
            const geomCol = geomFieldName ? table.getChild(geomFieldName) : null;

            const flatCoords = [];
            for (let i = 0; i < numRows; i++) {
                if (geomCol) {
                    const val = geomCol.get(i);
                    const arr = typeof val?.toArray === 'function' ? val.toArray() : (val?.toJSON ? val.toJSON() : val);
                    if (arr && arr.length > 0) {
                        for (let j = 0; j < arr.length; j++) flatCoords.push(arr[j] ?? 0);
                    }
                }
            }
            const flatCoordsArray = new Float64Array(flatCoords);

            // 2. Attribute Extraction (Strict Job Schema mapped to your CSV)

            // 🚀 Use 'wonum' for the ID
            const idsArray = table.getChild('wonum')?.toJSON() || new Array(numRows).fill('Job');

            const statusesArray = table.getChild('status')?.toJSON() || new Array(numRows).fill('Unknown');
            const prioritiesArray = table.getChild('priority')?.toJSON() || new Array(numRows).fill('N/A');

            // 🚀 Extract the actual 'watertype' instead of faking it
            const watertypesArray = table.getChild('watertype')?.toJSON() || new Array(numRows).fill('Not stated');

            // Pad missing Pipe arrays so DeckGL accessors don't fail silently
            const yearsArray = new Int32Array(numRows);
            const lengthsArray = new Float32Array(numRows);
            const diametersArray = new Float32Array(numRows);
            const materialsArray = new Array(numRows).fill('Unknown');

            const binaryData: any = {
                length: numRows,
                ids: idsArray,
                statuses: statusesArray,
                priorities: prioritiesArray,
                years: yearsArray,
                lengths: lengthsArray,
                diameters: diametersArray,
                materials: materialsArray,
                watertypes: watertypesArray,
                attributes: {
                    getPosition: { value: flatCoordsArray, size: 2 }
                }
            };

            ctx.postMessage({ id, status: 'success', data: binaryData }, [
                flatCoordsArray.buffer
            ]);
            return;
        }

    } catch (error: any) {
        console.error(`[Worker Error - ${action}]`, error);
        ctx.postMessage({ id, status: 'error', error: error.message });
    }
};