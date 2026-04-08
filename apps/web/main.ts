import u from "umbrellajs";
import { Deck, Position } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { ParquetLoader } from "@loaders.gl/parquet";
import { DataFilterExtension } from "@deck.gl/extensions";
import maplibregl from 'maplibre-gl';
import { ZstdCodec } from 'zstd-codec';
import 'maplibre-gl/dist/maplibre-gl.css';

// --- UTILS ---
const binsToPath = (bins: number[], maxVal: number, startIndex: number = 0, endIndex: number = bins.length - 1) => {
    if (maxVal === 0 || bins.length === 0) return "M 0 100 L 100 100 Z";
    const points = bins.map((km, i) => {
        const x = (i / (bins.length - 1)) * 100;
        const isOutside = i < startIndex || i > endIndex;
        const height = isOutside ? 0 : km;
        const y = 100 - (height / maxVal * 100);
        return `${x},${y}`;
    });
    return `M 0 100 L ${points.join(' ')} L 100 100 Z`;
};

// --- CONFIG ---
const UTILITY_CONFIG: Record<string, { file: string, color: [number, number, number], label: string }> = {
    drinking: { file: 'water_pipes_in_use.parquet', color: [0, 150, 255], label: 'Drinking' },
    waste: { file: 'waste_water_pipes.parquet', color: [168, 85, 247], label: 'Waste' },
    storm: { file: 'storm_water_pipes.parquet', color: [34, 197, 94], label: 'Storm' }
};

const LOAD_OPTIONS = {
    modules: { 'zstd-codec': ZstdCodec },
    worker: true,
    parquet: {}
};

const getAssetColor = (d: any, mode: string, utility: string): [number, number, number, number] => {
    if (mode === 'material') {
        const mat = (d.material || '').toUpperCase();
        if (mat.includes('AC')) return [239, 68, 68, 200];
        if (mat.includes('CI') || mat.includes('IRON')) return [168, 85, 247, 200];
        if (mat.includes('ST') || mat.includes('STEEL')) return [234, 179, 8, 200];
        if (mat.includes('PE') || mat.includes('PVC') || mat.includes('UPVC')) return [59, 130, 246, 200];
        return [100, 116, 139, 150];
    }
    if (mode === 'age') {
        const yr = Number(d.install_year) || 0;
        if (yr === 0) return [71, 85, 105, 150];
        const age = 2026 - yr;
        if (age > 70) return [220, 38, 38, 220];
        if (age > 50) return [249, 115, 22, 220];
        if (age > 30) return [234, 179, 8, 220];
        return [34, 197, 94, 200];
    }
    const baseColor = UTILITY_CONFIG[utility]?.color || [0, 150, 255];
    return [...baseColor, 200] as [number, number, number, number];
};

async function init() {
    console.log("--- 🕵️ WELLIES FORENSIC START ---");

    let activeUtilities = new Set(['drinking']);
    let startYear = 1870;
    let endYear = 2026;
    let minFilter = startYear;
    let maxFilter = endYear;
    let showUnknown = true;
    let showLeaks = true;
    let colorMode = 'default';

    let deck: any = null;
    let globalBins: number[] = [];
    let globalMax = 0;
    const dataCache: Record<string, any[]> = {};

    const map = new maplibregl.Map({
        container: 'map',
        style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
        interactive: false,
        center: [174.7762, -41.2865],
        zoom: 11
    });

    const calculateStats = () => {
        const currentActive = Array.from(activeUtilities)[0];
        const data = dataCache[currentActive];

        if (!data || data.length === 0) return;

        let totalMeters = 0;
        let visibleCount = 0;
        globalBins = new Array(endYear - startYear + 1).fill(0);

        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            const yr = Number(d.install_year) || 0;
            const length = Number(d.length_m) || 0;

            if (yr >= startYear && yr <= endYear) {
                globalBins[yr - startYear] += length;
            }

            const yrForSlider = yr === 0 ? maxFilter : yr;
            if (yrForSlider >= minFilter && yrForSlider <= maxFilter && (showUnknown || yr > 0)) {
                totalMeters += length;
                visibleCount++;
            }
        }

        globalMax = Math.max(...globalBins);
        u("#hist-bg").attr("d", binsToPath(globalBins, globalMax));
        const sIdx = Math.max(0, minFilter - startYear);
        const eIdx = Math.min(globalBins.length - 1, maxFilter - startYear);
        u("#hist-fg").attr("d", binsToPath(globalBins, globalMax, sIdx, eIdx));

        const km = (totalMeters / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });
        u("#audit-stat").html(`
            <div class="flex justify-between items-center font-mono">
                <span class="text-slate-400 text-xs">${visibleCount.toLocaleString()} assets</span>
                <span class="text-blue-400 font-bold">${km} km</span>
            </div>
        `);
    };

    const getLayers = () => {
        const layers: any[] = [];

        Object.entries(UTILITY_CONFIG).forEach(([key, config]) => {
            const isVisible = activeUtilities.has(key);
            layers.push(new PathLayer({
                id: `pipes-${key}`,
                data: `/data/${config.file}`,
                visible: isVisible,
                loaders: [ParquetLoader],
                loadOptions: LOAD_OPTIONS,

                onError: (error) => {
                    if (error.message.includes('magic=<!DO') || error.message.includes('404')) {
                        console.warn(`⚠️ Utility "${key}" data not found. Skipping layer.`);
                    } else {
                        console.error(`💥 Unexpected error on "${key}":`, error);
                    }
                    return true; // Prevents the error from bubbling up further
                },

                getPath: (d: any) => {
                    // Handle experimental Arrow clumping for Path data
                    if (d.coords?.list) {
                        return d.coords.list.map((p: any) => {
                            const pair = p.element?.list;
                            return pair ? [Number(pair[0].element), Number(pair[1].element)] : [0, 0];
                        });
                    }
                    return d.coords || [];
                },

                getColor: (d: any) => getAssetColor(d, colorMode, key),
                widthMinPixels: 2,
                pickable: true,
                autoHighlight: true,
                extensions: [new DataFilterExtension({ filterSize: 2 })],
                getFilterValue: (d: any) => {
                    const yr = Number(d.install_year) || 0;
                    return [yr === 0 ? maxFilter : yr, yr > 0 ? 1 : 0];
                },
                filterRange: [[minFilter, maxFilter], [showUnknown ? 0 : 1, 1]],
                updateTriggers: {
                    visible: [isVisible],
                    getColor: [colorMode, isVisible],
                    filterRange: [minFilter, maxFilter, showUnknown]
                },
                onDataLoad: (data: any) => {
                    dataCache[key] = data;
                    if (activeUtilities.has(key)) calculateStats();
                }
            }));
        });

        layers.push(new ScatterplotLayer({
            id: "active-leaks",
            data: "/data/active_leaks.parquet",
            loaders: [ParquetLoader],
            loadOptions: LOAD_OPTIONS,
            visible: showLeaks && activeUtilities.has('drinking'),

            getPosition: (d: any): Position => {
                const c = d.coords;
                if (c?.list && c.list.length >= 2) {
                    return [
                        Number(c.list[0].element),
                        Number(c.list[1].element)
                    ] as unknown as Position;
                }
                return (Array.isArray(c) && c.length >= 2 ? c : [0, 0]) as unknown as Position;
            },

            getFillColor: (d: any) => {
                const p = (d.priority || '').toLowerCase();
                if (p === 'urgent') return [220, 38, 38, 255];
                if (p === 'high') return [249, 115, 22, 255];
                if (p === 'medium') return [234, 179, 8, 220];
                return [100, 116, 139, 150];
            },
            radiusUnits: 'meters',
            getRadius: 25,
            radiusMinPixels: 4,
            stroked: true,
            getLineColor: [255, 255, 255, 200],
            lineWidthMinPixels: 1,
            pickable: true,
            autoHighlight: true,
            updateTriggers: {
                visible: [showLeaks, activeUtilities.has('drinking')]
            }
        }));

        return layers;
    };

    const refresh = () => {
        u("#year-label").text(`${minFilter} - ${maxFilter}`);
        if (deck) deck.setProps({ layers: getLayers() });
        calculateStats();
    };

    try {
        deck = new Deck({
            canvas: 'deck-canvas',
            initialViewState: { longitude: 174.7762, latitude: -41.2865, zoom: 11 },
            controller: true,
            getTooltip: ({ object, layer }) => {
                if (!object || !layer?.props.visible) return null;
                const isLeak = layer.id === 'active-leaks';
                return {
                    html: isLeak
                        ? `<div class="p-2 font-mono"><b class="text-red-400">ACTIVE LEAK</b><hr class="my-1 opacity-20"/>${object.wsadd_formattedaddress || 'Unknown Address'}</div>`
                        : `<div class="p-2 font-mono"><b class="text-blue-400">${object.asset_id}</b><hr class="my-1 opacity-20"/>${object.material} | ${object.diameter_mm}mm</div>`,
                    style: { backgroundColor: 'rgba(15, 23, 42, 0.95)', color: '#fff', borderRadius: '8px' }
                };
            },
            onViewStateChange: ({ viewState }) => {
                map.jumpTo({
                    center: [viewState.longitude, viewState.latitude],
                    zoom: viewState.zoom,
                    bearing: viewState.bearing,
                    pitch: viewState.pitch
                });
            },
            layers: getLayers()
        });

        // --- UI BINDINGS ---
        u(".utility-tab").on("click", (e: any) => {
            const id = e.target.id.replace('tab-', '');
            activeUtilities.clear();
            activeUtilities.add(id);
            u(".utility-tab").removeClass("bg-blue-600 text-white").addClass("text-slate-400");
            u(`#tab-${id}`).addClass("bg-blue-600 text-white").removeClass("text-slate-400");
            refresh();
        });

        u("#color-mode").on("change", (e: any) => { colorMode = e.target.value; refresh(); });
        u("#year-min").on("input", (e: any) => { minFilter = parseInt(e.target.value); refresh(); });
        u("#year-max").on("input", (e: any) => { maxFilter = parseInt(e.target.value); refresh(); });
        u("#toggle-unknown").on("change", (e: any) => { showUnknown = e.target.checked; refresh(); });
        u("#toggle-leaks").on("change", (e: any) => { showLeaks = e.target.checked; refresh(); });

        setTimeout(() => map.resize(), 100);
    } catch (err) { console.error("💥 INIT FATAL ERROR:", err); }
}

init();