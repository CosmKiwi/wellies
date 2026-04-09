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
        attributionControl: false,
        center: [174.7762, -41.2865],
        zoom: 11
    });

    let lastUtilityId = "";

    const calculateStats = () => {
        const currentActive = Array.from(activeUtilities)[0];
        const data = dataCache[currentActive];

        // If data isn't there yet, show a loading/empty state and STOP
        if (!data || data.length === 0) {
            u("#audit-stat").html(`<span class="text-slate-500 italic">No data loaded for ${currentActive}...</span>`);
            u("#hist-bg").attr("d", "");
            u("#hist-fg").attr("d", "");
            return;
        }

        // --- REBUILD BINS IF UTILITY CHANGED ---
        if (lastUtilityId !== currentActive) {
            globalBins = new Array(endYear - startYear + 1).fill(0);

            for (let i = 0; i < data.length; i++) {
                const d = data[i];
                const yr = Number(d.install_year) || 0;
                if (yr >= startYear && yr <= endYear) {
                    globalBins[yr - startYear] += Number(d.length_m) || 0;
                }
            }
            globalMax = Math.max(...globalBins);

            const pathData = binsToPath(globalBins, globalMax);
            u("#hist-bg").attr("d", pathData);
            u("#hist-fg").attr("d", pathData);

            lastUtilityId = currentActive;
        }

        // --- LIGHTWEIGHT UPDATES: Always run on slider/filter move ---
        let totalMeters = 0;
        let visibleCount = 0;

        // We still need to loop for the numeric stats, but this is much faster 
        // than string manipulation for SVG paths.
        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            const yr = Number(d.install_year) || 0;
            const yrForSlider = yr === 0 ? maxFilter : yr;

            if (yrForSlider >= minFilter && yrForSlider <= maxFilter && (showUnknown || yr > 0)) {
                totalMeters += Number(d.length_m) || 0;
                visibleCount++;
            }
        }

        // 1. Update text stats
        const km = (totalMeters / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });
        u("#audit-stat").html(`
        <div class="flex justify-between items-center font-mono text-xs">
            <span class="text-slate-400">${visibleCount.toLocaleString()} assets</span>
            <span class="text-blue-400 font-bold">${km} km</span>
        </div>
    `);

        // 2. CSS-only Clip-Path update (Butter smooth)
        const range = endYear - startYear;
        const startPct = ((minFilter - startYear) / range) * 100;
        const endPct = ((maxFilter - startYear) / range) * 100;

        // This creates a "viewing window" over the foreground SVG
        u("#hist-fg").attr("style", `clip-path: polygon(${startPct}% 0%, ${endPct}% 0%, ${endPct}% 100%, ${startPct}% 100%)`);
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
                    return true;
                },

                getPath: (d: any): Position[] => {
                    if (d.coords?.list) {
                        return d.coords.list.map((p: any) => {
                            const pair = p.element?.list;
                            return (pair
                                ? [Number(pair[0].element), Number(pair[1].element)]
                                : [0, 0]) as unknown as Position;
                        });
                    }
                    return (d.coords || []) as unknown as Position[];
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
                return (Array.isArray(c) && c.length >= 2 ? [Number(c[0]), Number(c[1])] : [0, 0]) as unknown as Position;
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

    let isTicking = false;

    let lastLoggedUtility = "";

    const refresh = () => {
        if (isTicking) return;
        isTicking = true;

        window.requestAnimationFrame(() => {
            u("#year-label").text(`${minFilter} - ${maxFilter}`);

            // --- FORENSIC DEBUG ---
            const currentActive = Array.from(activeUtilities)[0];
            const data = dataCache[currentActive];

            if (data && data.length > 0 && currentActive !== lastLoggedUtility) {
                console.group(`🕵️ Mapping Debug: ${currentActive}`);
                console.log("Total Rows:", data.length);
                console.log("Sample Object:", data[0]);
                console.log("Coords Type:", Array.isArray(data[0].coords) ? "Array" : typeof data[0].coords);
                console.log("First Coord Pair:", data[0].coords?.[0]);
                console.groupEnd();
                lastLoggedUtility = currentActive;
            }
            // --- END DEBUG ---

            if (deck) {
                deck.setProps({ layers: getLayers() });
            }

            calculateStats();
            isTicking = false;
        });
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
                        ? `<div class="p-2 font-mono text-xs"><b class="text-red-400">ACTIVE LEAK</b><hr class="my-1 opacity-20"/>${object.wsadd_formattedaddress || 'Unknown Address'}</div>`
                        : `<div class="p-2 font-mono text-xs"><b class="text-blue-400">${object.asset_id}</b><hr class="my-1 opacity-20"/>${object.material} | ${object.diameter_mm}mm</div>`,
                    style: { backgroundColor: 'rgba(15, 23, 42, 0.95)', color: '#fff', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)' }
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

        u(".utility-tab").on("click", (e: any) => {
            const id = e.target.id.replace('tab-', '');

            // 1. Update active set
            activeUtilities.clear();
            activeUtilities.add(id);

            // 2. UI Styling
            u(".utility-tab").removeClass("bg-blue-600 text-white shadow-md").addClass("text-slate-400");
            u(`#tab-${id}`).addClass("bg-blue-600 text-white shadow-md").removeClass("text-slate-400");

            // 3. IMPORTANT: Reset the "lastUtility" tracker so calculateStats 
            // knows it HAS to rebuild the bins for the new data source.
            lastUtilityId = "";

            refresh();
        });

        u("#color-mode").on("change", (e: any) => { colorMode = e.target.value; refresh(); });
        u("#year-min").on("input", (e: any) => {
            minFilter = parseInt(e.target.value);
            if (minFilter > maxFilter) {
                maxFilter = minFilter;
                // Cast to HTMLInputElement so we can access .value
                const maxSlider = u("#year-max").first() as HTMLInputElement;
                if (maxSlider) maxSlider.value = String(maxFilter);
            }
            refresh();
        });

        u("#year-max").on("input", (e: any) => {
            maxFilter = parseInt(e.target.value);
            if (maxFilter < minFilter) {
                minFilter = maxFilter;
                // Cast to HTMLInputElement so we can access .value
                const minSlider = u("#year-min").first() as HTMLInputElement;
                if (minSlider) minSlider.value = String(minFilter);
            }
            refresh();
        });

        // Define the toggle action
        const toggleAction = () => {
            const body = u("#panel-body");
            const isHidden = body.hasClass("hidden");
            const isMobile = window.innerWidth < 640;

            body.toggleClass("hidden");

            // Handle arrow rotation
            const rotation = isHidden ? "rotate(0deg)" : "rotate(180deg)";
            u("#arrow").attr("style", `transform: ${rotation}`);

            // Forensic Map Resize (Critical for mobile layout shifts)
            if (isMobile) {
                // Delay slightly to allow the CSS transition to finish 
                // before re-calculating map size
                setTimeout(() => map.resize(), 300);
            }
        };

        // Bind to both triggers
        u("#toggle-ui").on("click", toggleAction);
        u("#mobile-handle").on("click", toggleAction);

        // Helper to bring the active slider to the front
        const bringToFront = (selector: string) => {
            u("#year-min, #year-max").attr("style", "z-index: 10"); // Reset both
            u(selector).attr("style", "z-index: 20"); // Bring active to front
        };

        u("#year-min").on("mousedown", () => bringToFront("#year-min"));
        u("#year-max").on("mousedown", () => bringToFront("#year-max"));

        u("#year-min").on("input", (e: any) => {
            bringToFront("#year-min"); // Also ensure front-focus on drag
            minFilter = parseInt(e.target.value);
            if (minFilter > maxFilter) {
                maxFilter = minFilter;
                const maxSlider = u("#year-max").first() as HTMLInputElement;
                if (maxSlider) maxSlider.value = String(maxFilter);
            }
            refresh();
        });

        u("#year-max").on("input", (e: any) => {
            bringToFront("#year-max");
            maxFilter = parseInt(e.target.value);
            if (maxFilter < minFilter) {
                minFilter = maxFilter;
                const minSlider = u("#year-min").first() as HTMLInputElement;
                if (minSlider) minSlider.value = String(minFilter);
            }
            refresh();
        });

        u("#toggle-unknown").on("change", (e: any) => { showUnknown = e.target.checked; refresh(); });
        u("#toggle-leaks").on("change", (e: any) => { showLeaks = e.target.checked; refresh(); });

        // Modal Interaction
        const modal = u("#modal-overlay");

        u("#open-modal").on("click", () => {
            modal.removeClass("hidden");
        });

        u("#close-modal").on("click", () => {
            modal.addClass("hidden");
        });

        // Close if they click the darkened background
        modal.on("click", (e: any) => {
            if (e.target.id === "modal-overlay") {
                modal.addClass("hidden");
            }
        });

        // Resize handler for MapLibre
        const resizeObserver = new ResizeObserver(() => {
            map.resize();
        });
        resizeObserver.observe(document.getElementById('map')!);

    } catch (err) {
        console.error("💥 INIT FATAL ERROR:", err);
    }
}

init();