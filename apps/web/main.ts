import u from "umbrellajs";
import { Deck } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { ParquetLoader } from "@loaders.gl/parquet";
import { DataFilterExtension } from "@deck.gl/extensions";
import maplibregl from 'maplibre-gl';
import { ZstdCodec } from 'zstd-codec';
import 'maplibre-gl/dist/maplibre-gl.css';

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
    gis: {
        reproject: false
    }
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

    // Key fix: Use a map to store data per utility so we don't have to re-fetch
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

        if (!data || data.length === 0) {
            u("#audit-stat").html(`<div class="text-slate-500 text-xs italic">Loading ${currentActive}...</div>`);
            return;
        }

        let totalMeters = 0;
        let visibleCount = 0;

        // Reset and build bins based on total range
        globalBins = new Array(Math.max(1, endYear - startYear + 1)).fill(0);

        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            const yr = Number(d.install_year) || 0;
            const length = parseFloat(d.length_m) || 0;

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

        // Update SVG paths for Age Profile
        u("#hist-bg").attr("d", binsToPath(globalBins, globalMax));
        const sIdx = Math.max(0, minFilter - startYear);
        const eIdx = Math.min(globalBins.length - 1, maxFilter - startYear);
        u("#hist-fg").attr("d", binsToPath(globalBins, globalMax, sIdx, eIdx));

        // Update Text Stats
        const km = (totalMeters / 1000).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
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
                onError: () => true,

                getPath: (d: any) => {
                    if (d.coords?.list) {
                        return d.coords.list.map((p: any) => {
                            const pair = p.element?.list;
                            if (pair) {
                                return [Number(pair[0].element), Number(pair[1].element)];
                            }
                            return [0, 0];
                        });
                    }
                    return d.coords || [];
                },

                getColor: (d: any) => getAssetColor(d, colorMode, key),
                widthMinPixels: 2,
                pickable: true,
                autoHighlight: true,
                highlightColor: [255, 255, 255, 100],
                extensions: [new DataFilterExtension({ filterSize: 2 })],
                getFilterValue: (d: any) => {
                    const yr = Number(d.install_year) || 0;
                    return [yr === 0 ? maxFilter : yr, yr > 0 ? 1 : 0];
                },
                filterRange: [[minFilter, maxFilter], [showUnknown ? 0 : 1, 1]],
                updateTriggers: {
                    visible: [isVisible],
                    getColor: [colorMode, isVisible],
                    getFilterValue: [maxFilter],
                    filterRange: [minFilter, maxFilter, showUnknown]
                },
                onDataLoad: (data: any) => {
                    dataCache[key] = data; // Cache data globally

                    if (key === 'drinking' && data.length > 0) {
                        let actualMin = 2026;
                        let actualMax = 0;
                        for (let i = 0; i < data.length; i++) {
                            const yr = Number(data[i].install_year) || 0;
                            if (yr > 0) {
                                if (yr < actualMin) actualMin = yr;
                                if (yr > actualMax) actualMax = yr;
                            }
                        }
                        startYear = actualMin;
                        endYear = actualMax;
                        u("#year-min").attr({ min: String(startYear), max: String(endYear) });
                        u("#year-max").attr({ min: String(startYear), max: String(endYear) });
                    }

                    if (activeUtilities.has(key)) {
                        calculateStats();
                    }
                }
            }));
        });

        let hasLoggedLeak = false;

        layers.push(new ScatterplotLayer({
            id: "active-leaks",
            data: "/data/active_leaks.parquet",
            loaders: [ParquetLoader],
            loadOptions: {
                parquet: { shape: 'object-row-table' },
                worker: true
            },
            onDataLoad: (data: any) => {
                console.log("Leak Data Sample:", data[0]);
            },
            visible: showLeaks && activeUtilities.has('drinking'),

            // getPosition: (d: any) => d.coords,
            getPosition: (d: any) => {
                if (d.coords?.list && d.coords.list.length >= 2) {
                    return [
                        Number(d.coords.list[0].element),
                        Number(d.coords.list[1].element)
                    ];
                }
                // Fallback if sync.py is fixed and it's already a clean array
                return Array.isArray(d.coords) ? d.coords : [0, 0];
            },

            getFillColor: (d: any) => {
                const p = (d.priority || '').toLowerCase();
                if (p === 'urgent') return [220, 38, 38, 255]; // Red
                if (p === 'high') return [249, 115, 22, 255];   // Orange
                if (p === 'medium') return [234, 179, 8, 220];  // Yellow
                return [100, 116, 139, 150];                    // Slate
            },
            radiusUnits: 'meters',
            getRadius: 25,
            radiusMinPixels: 3,
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
        if (!deck) return;
        deck.setProps({ layers: getLayers() });
        calculateStats(); // Update UI whenever sliders or colors change
    };

    const switchTab = (id: string) => {
        activeUtilities.clear();
        activeUtilities.add(id);

        u(".utility-tab")
            .removeClass("bg-blue-600 text-white shadow-lg")
            .addClass("text-slate-400 hover:text-slate-200 rounded-lg");

        u(`#tab-${id}`)
            .addClass("bg-blue-600 text-white shadow-lg")
            .removeClass("text-slate-400 hover:text-slate-200");

        // UI Reset
        u("#hist-bg").attr("d", "");
        u("#hist-fg").attr("d", "");

        refresh();
    };

    try {
        deck = new Deck({
            canvas: 'deck-canvas',
            width: '100%', height: '100%',
            initialViewState: { longitude: 174.7762, latitude: -41.2865, zoom: 11 },
            controller: true,
            getTooltip: (info) => {
                if (!info.object || !info.layer || !info.layer.props.visible) return null;
                const d = info.object;
                const isLeak = info.layer.id === 'active-leaks';
                return {
                    html: isLeak ? `<div style="font-family: monospace; padding: 10px;"><b style="color: #f87171;">ACTIVE LEAK</b><hr style="border-top:1px solid #334155; margin:5px 0;"/>${d.address}</div>`
                        : `<div style="font-family: monospace; padding: 10px;"><b style="color: #0cf;">${d.asset_id}</b><hr style="border-top:1px solid #334155; margin:5px 0;"/>${d.material} | ${d.diameter_mm}mm</div>`,
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

        u(".utility-tab").on("click", (e: any) => switchTab(e.target.id.replace('tab-', '')));
        u("#color-mode").on("change", (e: any) => { colorMode = e.target.value; refresh(); });
        u("#year-min").on("input", (e: any) => { minFilter = parseInt(e.target.value); refresh(); });
        u("#year-max").on("input", (e: any) => { maxFilter = parseInt(e.target.value); refresh(); });
        u("#toggle-unknown").on("change", (e: any) => { showUnknown = e.target.checked; refresh(); });
        u("#toggle-leaks").on("change", (e: any) => { showLeaks = e.target.checked; refresh(); });

        setTimeout(() => map.resize(), 100);
    } catch (err) { console.error("💥 INIT FATAL ERROR:", err); }
}

init();