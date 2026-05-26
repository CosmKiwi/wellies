<script lang="ts">
	import Map from '$lib/components/Map.svelte';
	import ControlPanel from '$lib/components/ControlPanel.svelte';
	import { queryLakehouse, getManifest } from '$lib/data-pipeline';

	let activeUtility = $state('drinking');
	let yearRange = $state([1870, 2026]);
	let showUnknown = $state(true);
	let showLeaks = $state(true);
	let colorMode = $state('default');
	let activeMaterials = $state(new Set(['AC', 'CI', 'STEEL', 'PE', 'OTHER']));
	let showDisclaimer = $state(false);

	let utilityData = $state<any>(null);
	let jobStatusData = $state<any>(null);
	let manifestData = $state<any>(null);
	let isLoading = $state(false);

	let currentBBox = $state<any>(null);
	let currentLod = $state<string>('all'); // 🚀 Track LOD for future optimizations

	// 🚀 1. Updated BBox catcher to handle the new detail object
	$effect(() => {
		const handleBBox = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			currentBBox = detail.bbox;
			currentLod = detail.lod;
		};
		window.addEventListener('wellies:bbox-change', handleBBox);
		return () => window.removeEventListener('wellies:bbox-change', handleBBox);
	});

	$effect(() => {
		getManifest().then((data: any) => {
			manifestData = data;
		});
	});

	// 🚀 2. Combined the queries so they fire simultaneously to the Web Worker
	$effect(() => {
		if (!currentBBox) return;

		isLoading = true;

		// Pipes
		queryLakehouse({
			network: 'wellington',
			asset: 'pipes',
			type: activeUtility,
			bbox: currentBBox
		})
			.then((data) => {
				utilityData = data;
				isLoading = false; // Turn off spinner when the heavy geometry finishes
			})
			.catch((err) => {
				console.error('Pipe Query Failed:', err);
				isLoading = false;
			});

		// Jobs (Fires at the exact same time without blocking the UI or the Pipe query)
		queryLakehouse({
			network: 'wellington',
			asset: 'jobs',
			type: activeUtility,
			bbox: currentBBox
		})
			.then((data) => {
				jobStatusData = data;
			})
			.catch((err) => {
				console.error('Job Query Failed:', err);
			});
	});

	// 🚀 The Manifest Watchdog
	$effect(() => {
		// 1. Initial Load
		getManifest().then((data: any) => {
			manifestData = data;
		});

		// 2. Start the background polling (e.g., every 5 minutes / 300,000ms)
		const watchdogTimer = setInterval(async () => {
			if (!manifestData || !currentBBox) return;

			try {
				const freshManifest = await getManifest(true);

				// Compare hashes for the jobs file (since jobs change frequently)
				const oldJobs = manifestData.files.find(
					(f: any) => f.network === 'wellington' && f.asset.includes('jobs')
				);
				const newJobs = freshManifest.files.find(
					(f: any) => f.network === 'wellington' && f.asset.includes('jobs')
				);

				if (oldJobs && newJobs && oldJobs.hash !== newJobs.hash) {
					console.log(
						`🚨 Data Change Detected: Jobs hash updated to ${newJobs.hash}. Refreshing map silently!`
					);

					// Trigger a silent re-query for the jobs layer!
					queryLakehouse({
						network: 'wellington',
						asset: 'jobs',
						type: activeUtility,
						bbox: currentBBox
					}).then((data) => {
						jobStatusData = data; // DeckGL will reactively redraw the points!
					});
				}

				// Update the UI "Last Synced" timestamp
				manifestData = freshManifest;
			} catch (err) {
				console.warn('Watchdog failed to reach cloudflare:', err);
			}
		}, 300000); // 5 minutes

		// Cleanup timer if the component ever unmounts
		return () => clearInterval(watchdogTimer);
	});
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (showDisclaimer = false)} />

<div class="relative h-[100dvh] w-full overflow-hidden bg-slate-950">
	<ControlPanel
		bind:activeUtility
		bind:yearRange
		bind:showUnknown
		bind:showLeaks
		bind:colorMode
		bind:activeMaterials
		{utilityData}
		bind:showDisclaimer
	/>

	<main class="absolute inset-0 z-0">
		<Map
			{activeUtility}
			{yearRange}
			{showUnknown}
			{showLeaks}
			{colorMode}
			{activeMaterials}
			{utilityData}
			{isLoading}
			{jobStatusData}
		/>
	</main>

	{#if showDisclaimer}
		<div
			class="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-md"
			role="button"
			tabindex="0"
			onclick={(e) => {
				if (e.target === e.currentTarget) showDisclaimer = false;
			}}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === 'Escape') showDisclaimer = false;
			}}
		>
			<div
				class="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
			>
				<div class="p-8 pb-4">
					<h2 class="text-3xl font-black tracking-tighter text-blue-500 uppercase italic">
						About Wellies
					</h2>
				</div>

				<div class="hide-scroll flex-1 space-y-6 overflow-y-auto p-8 pt-0">
					<section class="space-y-4 leading-relaxed text-slate-300">
						<p>
							<strong class="text-white">Wellies</strong> is an independent, open-source tool designed
							to visualize the water infrastructure of the Wellington Region. It provides a historical
							and spatial overview of networks using publicly available data.
						</p>

						<div class="space-y-3 rounded-r-lg border-l-4 border-red-600 bg-red-500/10 p-5">
							<h3 class="text-xs font-bold tracking-widest text-red-500 uppercase">
								Disclaimer & Data Accuracy
							</h3>
							<p class="text-sm text-red-200/80">
								<strong class="text-red-200">Third-Party Tool:</strong> This application is strictly independent.
								It is not affiliated with or endorsed by Wellington Water Ltd or any regional council.
							</p>
							<p class="text-sm text-red-200/80">
								<strong class="text-red-200">Educational Use Only:</strong> Not suitable for engineering
								design, property development, or on-site decision-making.
							</p>
							<p class="text-sm text-red-200/80">
								<strong class="text-red-200">No Liability:</strong> By using this app, you acknowledge
								that creators are not responsible for any loss or damage arising from reliance on this
								information.
							</p>
						</div>

						<div class="space-y-4 border-t border-slate-800 pt-4">
							<h3 class="text-xs font-bold tracking-widest text-slate-500 uppercase">
								Technical & Data Credits
							</h3>
							<ul class="space-y-3 text-sm text-slate-400">
								<li>
									<strong class="text-slate-300">Infrastructure Data:</strong> Wellington Water Open Data
									Portal (WCC, HCC, UHCC, PCC, SWDC, and GWRC).
								</li>
								<li>
									<strong class="text-slate-300">Basemaps:</strong> ©
									<a
										href="https://www.openstreetmap.org/copyright"
										target="_blank"
										class="text-blue-400 hover:underline">OpenStreetMap</a
									>
									contributors, styled by
									<a
										href="https://carto.com/attributions"
										target="_blank"
										class="text-blue-400 hover:underline">CARTO</a
									>.
								</li>
							</ul>
						</div>
						<div class="space-y-4 border-t border-slate-800 pt-4">
							<h3 class="text-xs font-bold tracking-widest text-slate-500 uppercase">
								Lakehouse Sync Status
							</h3>
							<div class="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] text-slate-400">
								{#if manifestData}
									<div class="truncate capitalize">
										<span class="text-slate-300">Last Synced:</span>
									</div>
									<div class="text-right font-mono text-blue-400">
										{new Date(manifestData.manifest_updated).toLocaleString()}
									</div>
									<div class="truncate capitalize">
										<span class="text-slate-300">Total Artifacts:</span>
									</div>
									<div class="text-right font-mono text-blue-400">
										{manifestData.files.length} Parquet Files
									</div>
								{:else}
									<div class="col-span-2 animate-pulse text-slate-500">Checking sync status...</div>
								{/if}
							</div>
						</div>
						<div class="space-y-4 border-t border-slate-800 pt-4">
							<h3 class="text-xs font-bold tracking-widest text-slate-500 uppercase">
								System Architecture
							</h3>
							<div class="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] text-slate-400">
								<div><span class="text-slate-300">Visuals:</span> Deck.gl & MapLibre</div>
								<div><span class="text-slate-300">Pipeline:</span> Kea</div>
								<div><span class="text-slate-300">Format:</span> Apache Arrow</div>
								<div><span class="text-slate-300">Interface:</span> Svelte 5 & Shadcn</div>
							</div>
						</div>

						<div class="px-8 pb-4">
							<a
								href="https://github.com/CosmKiwi/wellies"
								target="_blank"
								class="flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 p-3 text-xs font-bold tracking-widest text-slate-300 uppercase transition-all hover:bg-slate-700"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path
										d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"
									/>
									<path d="M9 18c-4.51 2-5-2-7-2" />
								</svg>
								View Source on GitHub
							</a>
						</div>
					</section>
				</div>

				<div class="border-t border-slate-800 bg-slate-900 p-8 pt-4">
					<button
						onclick={() => (showDisclaimer = false)}
						class="w-full cursor-pointer rounded-xl bg-blue-600 py-4 text-xs font-bold tracking-widest text-white uppercase shadow-lg shadow-blue-900/20 transition-all hover:bg-blue-500"
					>
						Acknowledge & Close
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.hide-scroll::-webkit-scrollbar {
		display: none;
	}
	.hide-scroll {
		-ms-overflow-style: none;
		scrollbar-width: none;
	}
</style>
