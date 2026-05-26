<script lang="ts">
	import { Deck, FlyToInterpolator } from '@deck.gl/core';
	import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
	import { DataFilterExtension } from '@deck.gl/extensions';
	import maplibregl from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';

	let {
		activeUtility = $bindable(),
		yearRange = $bindable(),
		showUnknown = $bindable(),
		showLeaks = $bindable(),
		colorMode = $bindable(),
		activeMaterials = $bindable(),
		utilityData = $bindable(),
		isLoading = $bindable(),
		jobStatusData = $bindable()
	} = $props();

	let canvas: HTMLCanvasElement;
	let mapContainer: HTMLDivElement;
	let deck: Deck;
	let map: maplibregl.Map;

	let initialViewState = {
		longitude: 174.7762,
		latitude: -41.2865,
		zoom: 11,
		pitch: 0,
		bearing: 0
	};

	// --- COLOR & MATERIAL HELPERS ---
	const COLORS: Record<string, [number, number, number, number]> = {
		RED: [239, 68, 68, 200],
		PURPLE: [168, 85, 247, 200],
		YELLOW: [234, 179, 8, 200],
		BLUE: [59, 130, 246, 200],
		GRAY: [100, 116, 139, 150],
		GREEN: [34, 197, 94, 200],
		ORANGE: [249, 115, 22, 220],
		DARK_RED: [220, 38, 38, 220],
		UNKNOWN: [71, 85, 105, 150]
	};

	const getMaterialCategory = (mat: string | null) => {
		const m = (mat || '').toUpperCase();
		if (m.startsWith('AC')) return 'AC';
		if (m.includes('CI') || m.includes('DI') || m.includes('IRON')) return 'CI';
		if (m.includes('ST') || m === 'GS' || m === 'GI') return 'STEEL';
		if (m.includes('PE') || m.includes('PVC')) return 'PE';
		return 'OTHER';
	};

	// 🚀 Updated to accept raw values instead of an Arrow row object
	const getAssetColor = (
		material: string,
		installYear: number,
		mode: string,
		utility: string,
		target: number[]
	) => {
		if (mode === 'material') {
			const cat = getMaterialCategory(material);
			if (cat === 'AC') return COLORS.RED;
			if (cat === 'CI') return COLORS.PURPLE;
			if (cat === 'STEEL') return COLORS.YELLOW;
			if (cat === 'PE') return COLORS.BLUE;
			return COLORS.GRAY;
		}
		if (mode === 'age') {
			const yr = Number(installYear) || 0;
			if (yr === 0) return COLORS.UNKNOWN;
			const age = 2026 - yr;
			if (age > 70) return COLORS.DARK_RED;
			if (age > 50) return COLORS.ORANGE;
			if (age > 30) return COLORS.YELLOW;
			return COLORS.GREEN;
		}
		if (utility === 'waste') return [168, 85, 247, 200];
		if (utility === 'storm') return [34, 197, 94, 200];
		return [0, 150, 255, 200];
	};

	let isLocating = $state(false);

	function zoomToLocation() {
		if (!navigator.geolocation) return alert('Geolocation not supported');
		isLocating = true;
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				isLocating = false;
				if (deck) {
					deck.setProps({
						initialViewState: {
							longitude: pos.coords.longitude,
							latitude: pos.coords.latitude,
							zoom: 17,
							transitionDuration: 2000,
							transitionInterpolator: new FlyToInterpolator()
						}
					});
				}
			},
			(err) => {
				isLocating = false;
				console.error('Location error:', err);
			},
			{ enableHighAccuracy: true }
		);
	}

	// 🚀 1. The Predictive Threshold Overscanner
	let debounceTimer: number;
	let currentBufferBBox: { minX: number; minY: number; maxX: number; maxY: number } | null = null;

	function triggerSpatialPruning() {
		if (!map) return;

		clearTimeout(debounceTimer);
		debounceTimer = window.setTimeout(async () => {
			const bounds = map.getBounds();
			if (!bounds) return;

			const currentView = {
				minX: bounds.getWest(),
				maxX: bounds.getEast(),
				minY: bounds.getSouth(),
				maxY: bounds.getNorth()
			};

			const viewWidth = currentView.maxX - currentView.minX;
			const viewHeight = currentView.maxY - currentView.minY;

			let needsLoad = false;

			if (!currentBufferBBox) {
				needsLoad = true;
			} else {
				// 🚀 Threshold Check: If within 20% of buffer edge, trigger load!
				const marginX = viewWidth * 0.2;
				const marginY = viewHeight * 0.2;

				if (
					currentView.minX - marginX < currentBufferBBox.minX ||
					currentView.maxX + marginX > currentBufferBBox.maxX ||
					currentView.minY - marginY < currentBufferBBox.minY ||
					currentView.maxY + marginY > currentBufferBBox.maxY
				) {
					needsLoad = true;
				}
			}

			if (!needsLoad) return; // Completely silent if panning inside buffer

			// Calculate 3x Overscan
			const fetchWidth = Math.max(viewWidth, 0.005);
			const fetchHeight = Math.max(viewHeight, 0.005);

			currentBufferBBox = {
				minX: currentView.minX - fetchWidth,
				maxX: currentView.maxX + fetchWidth,
				minY: currentView.minY - fetchHeight,
				maxY: currentView.maxY + fetchHeight
			};

			// 🚀 Calculate the LOD (Level of Detail)
			const zoom = map.getZoom();
			let lodLevel = 'polygon';
			if (zoom >= 15)
				lodLevel = 'all'; // Street level
			else if (zoom >= 12) lodLevel = 'mains'; // City level

			window.dispatchEvent(
				new CustomEvent('wellies:bbox-change', {
					detail: { bbox: currentBufferBBox, lod: lodLevel }
				})
			);
		}, 150);
	}

	// 2. Initialize MapLibre & Deck.gl
	$effect(() => {
		if (!canvas || !mapContainer || deck) return;

		map = new maplibregl.Map({
			container: mapContainer,
			style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
			interactive: false,
			attributionControl: false,
			center: [initialViewState.longitude, initialViewState.latitude],
			zoom: initialViewState.zoom
		});

		deck = new Deck({
			canvas,
			initialViewState,
			controller: true,

			// 🚀 Updated Tooltip to read from primitive arrays
			getTooltip: ({ index, layer }: any) => {
				if (index < 0 || !layer) return null;

				const isLeak = layer.id === 'job_status';
				const data = isLeak ? jobStatusData : utilityData;
				if (!data) return null;

				if (isLeak) {
					const status = data.statuses?.[index] || 'Unknown';
					const priority = data.priorities?.[index] || 'N/A';
					return {
						html: `<div class="p-2 font-mono text-xs"><b class="text-red-400">ACTIVE LEAK</b><hr class="my-1 opacity-20"/>${status} | Priority: ${priority}</div>`,
						style: {
							backgroundColor: 'rgba(15, 23, 42, 0.95)',
							color: '#fff',
							borderRadius: '8px',
							border: '1px solid rgba(255,255,255,0.1)'
						}
					};
				} else {
					const id = data.ids?.[index] || 'Pipe';
					const mat = data.materials?.[index] || 'Unknown';
					const dia = data.diameters?.[index] || '?';
					return {
						html: `<div class="p-2 font-mono text-xs"><b class="text-blue-400">${id}</b><hr class="my-1 opacity-20"/>${mat} | ${dia}mm</div>`,
						style: {
							backgroundColor: 'rgba(15, 23, 42, 0.95)',
							color: '#fff',
							borderRadius: '8px',
							border: '1px solid rgba(255,255,255,0.1)'
						}
					};
				}
			},

			onViewStateChange: ({ viewState }) => {
				map.jumpTo({
					center: [viewState.longitude, viewState.latitude],
					zoom: viewState.zoom,
					bearing: viewState.bearing,
					pitch: viewState.pitch
				});
				triggerSpatialPruning();
			},
			layers: []
		});

		map.on('load', () => triggerSpatialPruning());

		const resizeObserver = new ResizeObserver(() => map.resize());
		resizeObserver.observe(mapContainer);

		return () => {
			clearTimeout(debounceTimer);
			resizeObserver.disconnect();
			deck.finalize();
			map.remove();
		};
	});

	// 3. Update Deck.gl layers reactively
	$effect(() => {
		if (!deck) return;

		const maxFilter = yearRange[1];
		const activeLayers = [];

		// --- LAYER 1: PIPES ---
		if (utilityData && utilityData.length > 0) {
			activeLayers.push(
				new PathLayer({
					id: `pipes-${activeUtility}`,
					data: utilityData,
					widthMinPixels: 2,
					pickable: true,
					autoHighlight: true,
					// 🚀 Read directly from the arrays passed from the Worker
					getColor: (_: any, { index, target }: any) => {
						const rawMat = utilityData.materials?.[index] || '';
						const yr = utilityData.years?.[index] || 0;
						const color = getAssetColor(rawMat, yr, colorMode, activeUtility, target as number[]);
						target[0] = color[0];
						target[1] = color[1];
						target[2] = color[2];
						target[3] = color[3];
						return target;
					},
					getFilterValue: (_: any, { index, target }: any) => {
						const yr = utilityData.years?.[index] || 0;
						const rawMat = utilityData.materials?.[index] || '';
						const matCat = getMaterialCategory(rawMat);

						target[0] = yr === 0 ? maxFilter : yr;
						target[1] = (yr > 0 || showUnknown) && activeMaterials.has(matCat) ? 1 : 0;
						return target;
					},
					extensions: [new DataFilterExtension({ filterSize: 2 })],
					filterRange: [
						[yearRange[0], yearRange[1]],
						[1, 1]
					],
					updateTriggers: {
						getColor: [colorMode, utilityData],
						getFilterValue: [showUnknown, Array.from(activeMaterials).join(','), utilityData],
						filterRange: [yearRange[0], yearRange[1]]
					}
				})
			);
		}

		// --- LAYER 2: JOB STATUS (LEAKS) ---
		if (jobStatusData && jobStatusData.length > 0 && showLeaks) {
			const typeMapping: Record<string, string> = {
				drinking: 'Potable Water',
				waste: 'Waste Water',
				storm: 'Storm Water'
			};

			activeLayers.push(
				new ScatterplotLayer({
					id: 'job_status',
					data: jobStatusData,
					radiusUnits: 'meters',
					getRadius: 25,
					radiusMinPixels: 4,
					stroked: true,
					getLineColor: [255, 255, 255, 200],
					lineWidthMinPixels: 1,
					pickable: true,
					autoHighlight: true,
					// 🚀 Read directly from priority array
					getFillColor: (_: any, { index, target }: any) => {
						const p = (jobStatusData.priorities?.[index] || '').toLowerCase();
						if (p === 'urgent') {
							target[0] = 220;
							target[1] = 38;
							target[2] = 38;
							target[3] = 220;
						} else if (p === 'high') {
							target[0] = 249;
							target[1] = 115;
							target[2] = 22;
							target[3] = 220;
						} else if (p === 'medium') {
							target[0] = 234;
							target[1] = 179;
							target[2] = 8;
							target[3] = 200;
						} else {
							target[0] = 100;
							target[1] = 116;
							target[2] = 139;
							target[3] = 150;
						}
						return target;
					},
					extensions: [new DataFilterExtension({ filterSize: 1 })],
					// 🚀 Read directly from water types array
					getFilterValue: (_: any, { index }: any) => {
						const wType = jobStatusData.watertypes?.[index];
						const expectedType = typeMapping[activeUtility];
						const isMatch = wType === expectedType || wType === 'Not stated';
						return isMatch ? 1 : 0;
					},
					filterRange: [1, 1],
					updateTriggers: {
						getFilterValue: [activeUtility, jobStatusData],
						getFillColor: [jobStatusData]
					}
				})
			);
		}

		deck.setProps({ layers: activeLayers });
	});
</script>

<div class="relative h-full w-full overflow-hidden bg-slate-900">
	<div bind:this={mapContainer} class="absolute inset-0 h-full w-full"></div>
	<canvas bind:this={canvas} class="absolute inset-0 h-full w-full focus:outline-none"></canvas>

	<div
		class="absolute top-4 right-4 z-20 rounded-md border border-slate-800 bg-slate-950/80 px-3 py-1.5 text-[10px] font-bold tracking-widest text-slate-200 uppercase backdrop-blur-sm"
	>
		{#if isLoading}
			<span class="animate-pulse text-orange-400">Loading Cache...</span>
		{:else}
			<span class="text-emerald-400">Lakehouse Active</span>
		{/if}
	</div>
	<button
		onclick={zoomToLocation}
		aria-label="Zoom to current location"
		class="absolute right-6 bottom-12 z-20 cursor-pointer text-slate-400 transition-colors hover:text-white"
	>
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
		>
			<circle cx="12" cy="12" r="3" />
			<path d="M20 12h2M2 12h2M12 2v2M12 20v2" />
		</svg>
	</button>
</div>
