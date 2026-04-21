<script lang="ts">
	import * as ToggleGroup from '$lib/components/ui/toggle-group/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Slider } from '$lib/components/ui/slider/index.js';

	let {
		activeUtility = $bindable('drinking'),
		yearRange = $bindable([1870, 2026]),
		showUnknown = $bindable(true),
		showLeaks = $bindable(true),
		colorMode = $bindable('default'),
		activeMaterials = $bindable(new Set(['AC', 'CI', 'STEEL', 'PE', 'OTHER'])),
		utilityData,
		showDisclaimer = $bindable(false)
	} = $props();

	let isPanelOpen = $state(true);

	function toggleMaterial(mat: string) {
		const newSet = new Set(activeMaterials);
		if (newSet.has(mat)) newSet.delete(mat);
		else newSet.add(mat);
		activeMaterials = newSet;
	}

	const getMaterialCategory = (mat: string | null) => {
		const m = (mat || '').toUpperCase();
		if (m.startsWith('AC')) return 'AC';
		if (m.includes('CI') || m.includes('DI') || m.includes('IRON')) return 'CI';
		if (m.includes('ST') || m === 'GS' || m === 'GI') return 'STEEL';
		if (m.includes('PE') || m.includes('PVC')) return 'PE';
		return 'OTHER';
	};

	let stats = $derived.by(() => {
		if (!utilityData) return { count: 0, km: '0.0', pathData: '', startPct: 0, endPct: 100 };

		const numRows = utilityData.length;
		const years = utilityData.years;
		const lengths = utilityData.lengths;
		const materialCol = utilityData.table.getChild('material');

		let totalMeters = 0;
		let visibleCount = 0;
		let bins = new Array(2026 - 1870 + 1).fill(0);

		for (let i = 0; i < numRows; i++) {
			const matCat = getMaterialCategory(materialCol?.get(i));
			if (!activeMaterials.has(matCat)) continue;

			const yr = years[i] || 0;

			// Build Bins for SVG
			if (yr >= 1870 && yr <= 2026) {
				bins[yr - 1870] += lengths[i] || 0;
			}

			// Calculate active stats based on slider
			const yrForSlider = yr === 0 ? yearRange[1] : yr;
			if (yrForSlider >= yearRange[0] && yrForSlider <= yearRange[1] && (showUnknown || yr > 0)) {
				totalMeters += lengths[i] || 0;
				visibleCount++;
			}
		}

		// SVG Path Generation
		const maxVal = Math.max(...bins);
		const points = bins.map((km, i) => {
			const x = (i / (bins.length - 1)) * 100;
			const y = maxVal === 0 ? 100 : 100 - (km / maxVal) * 100;
			return `${x},${y}`;
		});
		const pathData = `M 0 100 L ${points.join(' ')} L 100 100 Z`;

		// Clip Path percentages
		const range = 2026 - 1870;
		const startPct = ((yearRange[0] - 1870) / range) * 100;
		const endPct = ((yearRange[1] - 1870) / range) * 100;

		return {
			count: visibleCount.toLocaleString(),
			km: (totalMeters / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }),
			pathData,
			startPct,
			endPct
		};
	});
</script>

<div
	class="
    absolute z-[20] flex flex-col border-slate-800 bg-slate-950/80 shadow-2xl backdrop-blur-xl transition-all duration-300
    max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:w-full max-sm:rounded-t-3xl max-sm:border-x-0 max-sm:border-t
    max-sm:border-b-0 max-sm:pb-[calc(24px+env(safe-area-inset-bottom))] sm:top-6 sm:left-6 sm:max-h-[calc(100dvh-48px)] sm:w-80 sm:rounded-2xl sm:border sm:p-6
    {isPanelOpen ? 'max-sm:max-h-[85dvh] max-sm:p-6' : 'max-sm:max-h-[100px] max-sm:p-4'}
"
>
	<button
		onclick={() => (isPanelOpen = !isPanelOpen)}
		class="mx-auto mb-4 h-1.5 w-12 cursor-pointer rounded-full bg-slate-700 active:bg-slate-500 sm:hidden"
	></button>

	<div class="mb-6 flex items-center justify-between max-sm:mb-2">
		<div class="flex items-center gap-3">
			<img
				src="/images/gumboots_460.png"
				alt="Wellies"
				class="h-8 w-8 object-contain drop-shadow-md"
			/>
			<h1 class="text-3xl font-black tracking-tighter text-blue-500 uppercase italic select-none">
				Wellies
			</h1>
		</div>
		<button onclick={() => (isPanelOpen = !isPanelOpen)} class="p-1 text-slate-400 sm:hidden">
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="24"
				height="24"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				stroke-linecap="round"
				stroke-linejoin="round"
				style="transform: {isPanelOpen
					? 'rotate(180deg)'
					: 'rotate(0deg)'}; transition: transform 0.3s;"
			>
				<path d="m18 15-6-6-6 6" />
			</svg>
		</button>
	</div>

	<div class="hide-scroll flex-1 overflow-y-auto {isPanelOpen ? 'block' : 'max-sm:hidden'} pr-1">
		<ToggleGroup.Root
			type="single"
			bind:value={activeUtility}
			class="mb-6 w-full rounded-xl border border-slate-800 bg-slate-900 p-1"
		>
			<ToggleGroup.Item
				value="drinking"
				class="flex-1 text-[10px] font-bold tracking-widest uppercase data-[state=on]:bg-blue-600 data-[state=on]:text-white"
				>Drinking</ToggleGroup.Item
			>
			<ToggleGroup.Item
				value="waste"
				class="flex-1 text-[10px] font-bold tracking-widest uppercase data-[state=on]:bg-purple-600 data-[state=on]:text-white"
				>Waste</ToggleGroup.Item
			>
			<ToggleGroup.Item
				value="storm"
				class="flex-1 text-[10px] font-bold tracking-widest uppercase data-[state=on]:bg-emerald-600 data-[state=on]:text-white"
				>Storm</ToggleGroup.Item
			>
		</ToggleGroup.Root>

		<div
			class="mb-6 flex justify-between rounded-xl border border-white/5 bg-black/40 p-3 font-mono text-sm text-slate-300"
		>
			<span class="text-slate-400">{stats.count} assets</span>
			<span class="font-bold text-blue-400">{stats.km} km</span>
		</div>

		<div class="mb-6 space-y-2">
			<div class="flex justify-between text-xs font-bold tracking-widest text-slate-400 uppercase">
				<span>Install Range</span>
				<span class="text-blue-400">{yearRange[0]} - {yearRange[1]}</span>
			</div>

			<div class="pointer-events-none h-12 w-full overflow-hidden rounded-md opacity-80">
				<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="h-full w-full">
					<path d={stats.pathData} fill="rgba(51, 65, 85, 0.3)" />
					<path
						d={stats.pathData}
						fill="rgba(59, 130, 246, 0.5)"
						stroke="#3b82f6"
						stroke-width="0.5"
						vector-effect="non-scaling-stroke"
						style="clip-path: polygon({stats.startPct}% 0%, {stats.endPct}% 0%, {stats.endPct}% 100%, {stats.startPct}% 100%)"
					/>
				</svg>
			</div>

			<div class="px-2 pt-1">
				<Slider bind:value={yearRange} min={1870} max={2026} step={1} class="w-full" />
			</div>
		</div>

		<div class="mb-6 space-y-4">
			<div class="flex items-center justify-between">
				<span class="text-xs font-bold tracking-widest text-slate-400 uppercase"
					>Include Unknown</span
				>
				<Switch bind:checked={showUnknown} />
			</div>
			<div class="flex items-center justify-between">
				<span class="text-xs font-bold tracking-widest text-slate-400 uppercase">Include Leaks</span
				>
				<Switch bind:checked={showLeaks} />
			</div>
		</div>

		<div class="mb-6">
			<div class="mb-2 flex items-center justify-between">
				<span class="text-xs font-bold tracking-widest text-slate-400 uppercase">Materials</span>
			</div>
			<div class="flex flex-wrap gap-1.5">
				<button
					onclick={() => toggleMaterial('AC')}
					class="rounded border px-2 py-1 font-mono text-[10px] transition-all select-none {activeMaterials.has(
						'AC'
					)
						? 'border-red-500 bg-red-500/20 text-red-400'
						: 'border-slate-700 bg-slate-800 text-slate-500'}">AC</button
				>
				<button
					onclick={() => toggleMaterial('CI')}
					class="rounded border px-2 py-1 font-mono text-[10px] transition-all select-none {activeMaterials.has(
						'CI'
					)
						? 'border-purple-500 bg-purple-500/20 text-purple-400'
						: 'border-slate-700 bg-slate-800 text-slate-500'}">CI / IRON</button
				>
				<button
					onclick={() => toggleMaterial('STEEL')}
					class="rounded border px-2 py-1 font-mono text-[10px] transition-all select-none {activeMaterials.has(
						'STEEL'
					)
						? 'border-yellow-500 bg-yellow-500/20 text-yellow-400'
						: 'border-slate-700 bg-slate-800 text-slate-500'}">STEEL</button
				>
				<button
					onclick={() => toggleMaterial('PE')}
					class="rounded border px-2 py-1 font-mono text-[10px] transition-all select-none {activeMaterials.has(
						'PE'
					)
						? 'border-blue-500 bg-blue-500/20 text-blue-400'
						: 'border-slate-700 bg-slate-800 text-slate-500'}">PE / PVC</button
				>
				<button
					onclick={() => toggleMaterial('OTHER')}
					class="rounded border px-2 py-1 font-mono text-[10px] transition-all select-none {activeMaterials.has(
						'OTHER'
					)
						? 'border-slate-500 bg-slate-600/50 text-slate-300'
						: 'border-slate-700 bg-slate-800 text-slate-500'}">OTHER</button
				>
			</div>
		</div>

		<div class="mb-6">
			<span class="mb-2 block text-xs font-bold tracking-widest text-slate-400 uppercase"
				>Color Overlay</span
			>
			<select
				bind:value={colorMode}
				class="w-full cursor-pointer appearance-none rounded-xl border border-slate-700 bg-slate-800 p-2.5 text-xs text-slate-200 outline-none focus:border-blue-500"
			>
				<option value="default">Standard Blue</option>
				<option value="age">Asset Age (Heatmap)</option>
				<option value="material">Material Class</option>
			</select>
		</div>

		<button
			onclick={() => (showDisclaimer = true)}
			class="mt-6 w-full cursor-pointer pb-4 text-center text-[12px] tracking-tighter text-slate-500 uppercase italic transition-colors hover:text-slate-300"
		>
			Data Credits & Disclaimer
		</button>
	</div>
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
