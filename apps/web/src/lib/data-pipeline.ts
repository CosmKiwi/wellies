import { tableFromIPC } from 'apache-arrow';

const DATA_HOST = 'https://data.wellies.app';
let manifestCache: Record<string, any> | null = null;

export async function getManifest() {
    if (!manifestCache) {
        const manifestRes = await fetch(`${DATA_HOST}/manifest.json`);
        manifestCache = await manifestRes.json();
    }
    return manifestCache;
}

export async function fetchUtilityData(manifestKey: string, isPoint = false) {
    try {
        // 1. Fetch Manifest (Only once)
        if (!manifestCache) {
            const manifestRes = await fetch(`${DATA_HOST}/manifest.json`);
            manifestCache = await manifestRes.json();
        }

        const fileInfo = manifestCache?.[manifestKey];
        if (!fileInfo || !fileInfo.latest_file) {
            throw new Error(`No manifest entry found for: ${manifestKey}`);
        }

        const fileName = fileInfo.latest_file;
        console.log(`📥 Downloading ${fileName}...`);

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
        const coordsCol = table.getChild('coords') || table.getChild('SHAPE') || table.getChild('geometry');
        if (!coordsCol) throw new Error("Geometry column not found.");

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

        if (!flatCoordsArray || !pathOffsetsArray) {
            throw new Error("Arrow file is missing valid coordinate/offset data");
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