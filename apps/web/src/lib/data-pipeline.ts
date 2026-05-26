// 🚀 Boot the single background worker
const pipelineWorker = new Worker(new URL('./workers/pipeline.worker.ts', import.meta.url), { type: 'module' });

const DATA_HOST = import.meta.env.VITE_DATA_HOST || 'https://data.wellies.app';

let messageId = 0;
let lakehouseMounted = false;
let initPromise: Promise<void> | null = null;
let manifestPromise: Promise<any> | null = null;

export function getManifest(forceRefresh = false): Promise<any> {
	if (!manifestPromise || forceRefresh) {
		if (forceRefresh) console.log(`🔄 [Watchdog] Polling for fresh manifest...`);
		else console.log(`🌐 [UI] Fetching manifest...`);

		manifestPromise = fetch(`${DATA_HOST}/manifest.json`, { cache: 'no-store' })
			.then(res => {
				if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
				return res.json();
			})
			.catch(err => {
				manifestPromise = null;
				throw err;
			});
	}
	return manifestPromise;
}

function sendToWorker(action: string, payload: any = {}): Promise<any> {
	return new Promise((resolve, reject) => {
		const id = ++messageId;

		const handleMessage = (e: MessageEvent) => {
			if (e.data.id === id) {
				pipelineWorker.removeEventListener('message', handleMessage);
				if (e.data.status === 'success') {
					resolve(e.data.data);
				} else {
					reject(new Error(e.data.error));
				}
			}
		};

		pipelineWorker.addEventListener('message', handleMessage);

		// Strip Svelte Proxies
		const sanitizedPayload = JSON.parse(JSON.stringify(payload));
		pipelineWorker.postMessage({ action, id, payload: sanitizedPayload });
	});
}

export async function initLakehouse() {
	if (lakehouseMounted) return;

	if (!initPromise) {
		initPromise = sendToWorker('INIT').then(() => {
			lakehouseMounted = true;
		}).catch(err => {
			initPromise = null;
			throw err;
		});
	}

	return initPromise;
}

export async function queryLakehouse(options: {
	network?: string,
	asset?: string,
	type?: string,
	bbox?: { minX: number, minY: number, maxX: number, maxY: number }
}) {
	await initLakehouse();
	const manifest = await getManifest();

	// 🚀 Check if it's a job query, and dispatch the correct action to the worker!
	const isJob = options.asset === 'jobs';
	const actionToDispatch = isJob ? 'QUERY_JOBS' : 'QUERY_PIPES';

	return await sendToWorker(actionToDispatch, { options, manifest });
}