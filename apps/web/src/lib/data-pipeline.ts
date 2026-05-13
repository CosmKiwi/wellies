import { tableFromIPC } from 'apache-arrow';
import * as duckdb from '@duckdb/duckdb-wasm';
import { getDB } from './db';

const DATA_HOST = 'https://data.wellies.app';
let manifestCache: Record<string, any> | null = null;

// Helper to handle OPFS download and sync
async function syncToOPFS(fileName: string, remoteUrl: string) {
	const root = await navigator.storage.getDirectory();

	// Check if file already exists
	try {
		const existingHandle = await root.getFileHandle(fileName);
		const existingFile = await existingHandle.getFile();
		if (existingFile.size > 0) {
			console.log(`📂 OPFS: Cache hit for ${fileName}`);
			return existingHandle;
		}
	} catch (e) {
		console.log(`📂 OPFS: Cache miss. Downloading ${fileName}...`);
	}

	// Download and stream directly to OPFS
	const response = await fetch(remoteUrl);
	if (!response.ok) throw new Error(`Failed to download ${remoteUrl}`);

	const fileHandle = await root.getFileHandle(fileName, { create: true });
	const writable = await fileHandle.createWritable();

	// Use the streaming API for memory efficiency
	await response.body!.pipeTo(writable);

	console.log(`📂 OPFS: ${fileName} successfully synced to local disk.`);
	return fileHandle;
}

export async function getManifest() {
	if (!manifestCache) {
		const manifestRes = await fetch(`${DATA_HOST}/manifest.json`);
		manifestCache = await manifestRes.json();
	}
	return manifestCache;
}

export async function fetchUtilityData(manifestKey: string, isPoint = false) {
	try {
		// --- DUCKDB POC BYPASS WITH OPFS ---
		if (manifestKey === 'test_parquet') {
			const fileName = '01KRDEJXCA0RZVRA11X13GJ3QZ_20260512215355_water_pipe.parquet';
			const remoteUrl = `${window.location.origin}/${fileName}`;

			const opfsHandle = await syncToOPFS(fileName, remoteUrl);

			// 🦆 Fix: Grab both the instance and the connection
			const { db, conn } = await getDB();

			// Now 'db' is properly typed and has registerFileHandle
			await db.registerFileHandle(
				fileName,
				opfsHandle,
				duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
				true
			);

			console.log('🦆 DuckDB: Querying local OPFS file...');

			// 3. Updated Query with new Schema Fields
			// Use COALESCE for fields that might not exist in your current local test file
			const result = await conn.query(`
                SELECT 
                    asset_id, 
                    geometry, 
                    material, 
                    install_year,
                    length_m,
                    --COALESCE(pipe_type, 'Main') as pipe_type,
                    --COALESCE(network, 'Water') as network,
                    --COALESCE(tla, 'Unknown') as tla,
                    --COALESCE(mesh_block, 'Unknown') as mesh_block
                FROM read_parquet('${fileName}')
            `);

			const table = result;
			const numRows = table.numRows;

			// --- [JS WKT Parser remains the same] ---
			const geomCol = table.getChild('geometry');
			if (!geomCol) throw new Error('Geometry column not found!');

			const flatCoords = [];
			const pathOffsets = [0];
			let currentOffset = 0;

			for (let i = 0; i < numRows; i++) {
				const wkt = geomCol.get(i);
				if (wkt && wkt.startsWith('LINESTRING')) {
					const inner = wkt.slice(11, -1);
					const pairs = inner.split(',');
					for (const pair of pairs) {
						const [x, y] = pair.trim().split(' ');
						flatCoords.push(parseFloat(x), parseFloat(y));
						currentOffset += 2;
					}
				}
				pathOffsets.push(currentOffset);
			}

			const flatCoordsArray = new Float64Array(flatCoords);
			const pathOffsetsArray = new Uint32Array(pathOffsets);
			const vertexOffsets = new Uint32Array(pathOffsetsArray.length);
			for (let i = 0; i < pathOffsetsArray.length; i++) {
				vertexOffsets[i] = pathOffsetsArray[i] / 2;
			}

			// --- [Attribute Extraction with .toArray()] ---
			return {
				length: numRows,
				table: table,
				years: table.getChild('install_year')?.toArray() || new Int32Array(numRows),
				lengths: table.getChild('length_m')?.toArray() || new Float32Array(numRows),
				startIndices: vertexOffsets.subarray(0, numRows),
				attributes: {
					getPath: { value: flatCoordsArray, size: 2 }
				}
			};
		}
		// --- END DUCKDB POC BYPASS ---

		// 1. Fetch Manifest (Existing Logic)
		if (!manifestCache) {
			manifestCache = await getManifest();
		}

		const fileInfo = manifestCache?.[manifestKey];
		if (!fileInfo || !fileInfo.latest_file) {
			throw new Error(`No manifest entry found for: ${manifestKey}`);
		}

		const fileName = fileInfo.latest_file;
		console.log(`📥 Downloading legacy ${fileName}...`);

		// 2. Fetch and Decompress Arrow File
		const res = await fetch(`${DATA_HOST}/${fileName}`);
		if (!res.ok) throw new Error(`HTTP Error ${res.status}`);

		const ds = new DecompressionStream('gzip');
		const decompressedStream = res.body!.pipeThrough(ds);
		const buffer = await new Response(decompressedStream).arrayBuffer();

		// 3. Parse Arrow IPC
		const table = tableFromIPC(buffer);
		const numRows = table.numRows;

		// 4. Extract Geometry Columns
		const coordsCol =
			table.getChild('coords') || table.getChild('SHAPE') || table.getChild('geometry');
		if (!coordsCol) throw new Error('Geometry column not found.');

		let flatCoordsArray: any = null;
		let pathOffsetsArray: any = null;

		const leaf = coordsCol.data[0];
		if (leaf?.values) {
			flatCoordsArray = leaf.values;
			pathOffsetsArray = leaf.valueOffsets;
		} else if (leaf?.children?.[0]) {
			flatCoordsArray = leaf.children[0].values;
			pathOffsetsArray = leaf.valueOffsets;
		}

		// 5. Build Binary Data for Deck.gl
		const vertexOffsets = new Uint32Array(pathOffsetsArray.length);
		for (let i = 0; i < pathOffsetsArray.length; i++) {
			vertexOffsets[i] = pathOffsetsArray[i] / 2;
		}

		const yearCol = table.getChild('install_year') || table.getChild('year');
		const rawYearValues = yearCol?.data[0]?.values;

		const binaryData: any = {
			length: numRows,
			attributes: {},
			table: table,
			years: rawYearValues ? Int32Array.from(rawYearValues as any) : new Int32Array(numRows),
			lengths: table.getChild('length_m')?.data[0]?.values || new Float32Array(numRows)
		};

		if (isPoint) {
			binaryData.attributes.getPosition = { value: flatCoordsArray, size: 2 };
		} else {
			binaryData.startIndices = vertexOffsets.subarray(0, numRows);
			binaryData.attributes.getPath = { value: flatCoordsArray, size: 2 };
		}

		return binaryData;
	} catch (err) {
		console.error(`💥 Failed to load ${manifestKey}:`, err);
		return null;
	}
}
