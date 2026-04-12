import u from "umbrellajs";
import { Deck, Position, FlyToInterpolator } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { ParquetLoader } from "@loaders.gl/parquet";
import { DataFilterExtension } from "@deck.gl/extensions";
import maplibregl from 'maplibre-gl';
import { ZstdCodec } from 'zstd-codec';
import 'maplibre-gl/dist/maplibre-gl.css';

// --- OPTIMIZATION 1: CONSTANT COLORS ---
// Prevents generating new arrays on every render tick
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
    drinking: { file: 'drinking_water_pipes.parquet', color: [0, 150, 255], label: 'Drinking' },
    waste: { file: 'waste_water_pipes.parquet', color: [168, 85, 247], label: 'Waste' },
    storm: { file: 'storm_water_pipes.parquet', color: [34, 197, 94], label: 'Storm' }
};

const LOAD_OPTIONS = {
    modules: { 'zstd-codec': ZstdCodec },
    worker: true,
    parquet: {}
};

const populateColor = (target: number[], source: [number, number, number, number?]): [number, number, number, number] => {
    target[0] = source[0];
    target[1] = source[1];
    target[2] = source[2];
    target[3] = source[3] ?? 255;
    // Tell TS to trust us: this is exactly 4 numbers now
    return target as unknown as [number, number, number, number];
};

const getAssetColor = (d: any, mode: string, utility: string, target: number[]): [number, number, number, number] => {
    if (mode === 'material') {
        const mat = (d.material || '').toUpperCase();
        if (mat.includes('AC')) return populateColor(target, COLORS.RED);
        if (mat.includes('CI') || mat.includes('IRON')) return populateColor(target, COLORS.PURPLE);
        if (mat.includes('ST') || mat.includes('STEEL')) return populateColor(target, COLORS.YELLOW);
        if (mat.includes('PE') || mat.includes('PVC') || mat.includes('UPVC')) return populateColor(target, COLORS.BLUE);
        return populateColor(target, COLORS.GRAY);
    }
    if (mode === 'age') {
        const yr = Number(d.install_year) || 0;
        if (yr === 0) return populateColor(target, COLORS.UNKNOWN);
        const age = 2026 - yr;
        if (age > 70) return populateColor(target, COLORS.DARK_RED);
        if (age > 50) return populateColor(target, COLORS.ORANGE);
        if (age > 30) return populateColor(target, COLORS.YELLOW);
        return populateColor(target, COLORS.GREEN);
    }
    const baseColor = UTILITY_CONFIG[utility]?.color || [0, 150, 255];
    return populateColor(target, [baseColor[0], baseColor[1], baseColor[2], 200]);
};

const extractFlatCoords = (coords: any): number[] => {
    if (!coords) return [];
    if (Array.isArray(coords)) return coords;

    if (coords.list) {
        const flat: number[] = [];
        for (let i = 0; i < coords.list.length; i++) {
            const el = coords.list[i].element;
            if (el && typeof el === 'object' && el.list) {
                flat.push(Number(el.list[0]?.element || 0));
                flat.push(Number(el.list[1]?.element || 0));
            } else {
                flat.push(Number(el || 0));
            }
        }
        return flat;
    }
    return [];
};

const extractPairs = (coords: any): [number, number][] => {
    const flat = extractFlatCoords(coords);
    const pairs: [number, number][] = [];
    for (let j = 0; j < flat.length; j += 2) {
        pairs.push([flat[j] || 0, flat[j + 1] || 0]);
    }
    return pairs;
};

function processPipesToBinary(rawData: any[]) {
    const numPaths = rawData.length;
    let totalVertices = 0;

    const flatPaths: number[][] = new Array(numPaths);
    for (let i = 0; i < numPaths; i++) {
        const flat = extractFlatCoords(rawData[i].coords);
        flatPaths[i] = flat;
        totalVertices += flat.length / 2;
    }

    const positions = new Float32Array(totalVertices * 3);
    const pathIndices = new Uint32Array(numPaths + 1);

    let vertexOffset = 0;
    for (let i = 0; i < numPaths; i++) {
        pathIndices[i] = vertexOffset;
        const coords = flatPaths[i];
        const numPoints = coords.length / 2;

        for (let j = 0; j < numPoints; j++) {
            positions[(vertexOffset + j) * 3] = coords[j * 2];         // X
            positions[(vertexOffset + j) * 3 + 1] = coords[j * 2 + 1]; // Y
            positions[(vertexOffset + j) * 3 + 2] = 0;                 // Z
        }
        vertexOffset += numPoints;
    }
    pathIndices[numPaths] = vertexOffset;

    // 🕵️ PIPES FORENSIC LOG
    if (numPaths > 0) {
        console.group("🚧 Pipes Binary Debug");
        console.log("Total Paths (length):", numPaths);
        console.log("Positions Array:", positions instanceof Float32Array ? `Float32Array(${positions.length})` : "FAILED");
        console.log("Start Indices Array:", pathIndices instanceof Uint32Array ? `Uint32Array(${pathIndices.length})` : "FAILED");

        console.log("First Start Index:", pathIndices[0], "| Second Start Index:", pathIndices[1]);

        if (positions.length >= 6) {
            console.log("First Vertex:", [positions[0], positions[1], positions[2]]);
            console.log("Second Vertex:", [positions[3], positions[4], positions[5]]);
        }

        // Scan for GPU-crashing NaNs
        let hasNaN = false;
        let zeroCount = 0;
        for (let i = 0; i < Math.min(positions.length, 300); i++) {
            if (Number.isNaN(positions[i])) hasNaN = true;
            if (positions[i] === 0) zeroCount++;
        }
        console.log("NaNs detected?", hasNaN ? "⚠️ YES (GPU CRASH)" : "No ✅");
        console.log(`Zeros in first 100 vertices (Z-axis expected): ${zeroCount}/300`);
        console.groupEnd();
    }

    return {
        length: numPaths,
        startIndices: pathIndices,
        attributes: { getPath: { value: positions, size: 3 } },
        rawData
    };
}

function processLeaksToBinary(rawData: any[]) {
    const length = rawData.length;
    const positions = new Float32Array(length * 3);

    for (let i = 0; i < length; i++) {
        const flat = extractFlatCoords(rawData[i].coords);
        positions[i * 3] = flat[0] || 0;     // X
        positions[i * 3 + 1] = flat[1] || 0; // Y
        positions[i * 3 + 2] = 0;            // Z
    }

    return {
        length,
        attributes: { getPosition: { value: positions, size: 3 } },
        rawData
    };
}

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
    const dataCache: Record<string, any> = {};

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

        // Now it's just a standard array directly from the cache!
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
                const yr = Number(data[i].install_year) || 0;
                if (yr >= startYear && yr <= endYear) {
                    globalBins[yr - startYear] += Number(data[i].length_m) || 0;
                }
            }
            globalMax = Math.max(...globalBins);

            const pathData = binsToPath(globalBins, globalMax);
            u("#hist-bg").attr("d", pathData);
            u("#hist-fg").attr("d", pathData);

            lastUtilityId = currentActive;
        }

        // --- LIGHTWEIGHT UPDATES: Run on slider/filter move ---
        let totalMeters = 0;
        let visibleCount = 0;

        for (let i = 0; i < data.length; i++) {
            const yr = Number(data[i].install_year) || 0;
            const yrForSlider = yr === 0 ? maxFilter : yr;

            if (yrForSlider >= minFilter && yrForSlider <= maxFilter && (showUnknown || yr > 0)) {
                totalMeters += Number(data[i].length_m) || 0;
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

        // 2. CSS-only Clip-Path update
        const range = endYear - startYear;
        const startPct = ((minFilter - startYear) / range) * 100;
        const endPct = ((maxFilter - startYear) / range) * 100;

        u("#hist-fg").attr("style", `clip-path: polygon(${startPct}% 0%, ${endPct}% 0%, ${endPct}% 100%, ${startPct}% 100%)`);
    };

    const getLayers = () => {
        const layers: any[] = [];

        Object.entries(UTILITY_CONFIG).forEach(([key, config]) => {
            const isVisible = activeUtilities.has(key);
            layers.push(new PathLayer({
                id: `pipes-${key}`,
                data: dataCache[key] || `/data/${config.file}`,
                visible: isVisible,
                loaders: [ParquetLoader],
                loadOptions: LOAD_OPTIONS,

                // Trivial Accessor: 0 calculations, 0 memory allocations
                getPath: (d: any) => d._path || [],

                // We still use the target array mutation for crazy fast colors/filters
                getColor: (d: any, { target }: any) => {
                    return getAssetColor(d, colorMode, key, target as number[]);
                },
                getFilterValue: (d: any, { target }: any) => {
                    const yr = Number(d.install_year) || 0;
                    const t = target as number[];
                    t[0] = yr === 0 ? maxFilter : yr;
                    t[1] = yr > 0 ? 1 : 0;
                    return t as unknown as [number, number];
                },

                widthMinPixels: 2,
                pickable: true,
                autoHighlight: true,
                extensions: [new DataFilterExtension({ filterSize: 2 })],
                filterRange: [[minFilter, maxFilter], [showUnknown ? 0 : 1, 1]],
                updateTriggers: {
                    getColor: [colorMode],
                    getFilterValue: [maxFilter],
                    filterRange: [minFilter, maxFilter, showUnknown]
                },

                onDataLoad: (data: any) => {
                    // 💥 PRE-PROCESS EXACTLY ONCE
                    for (let i = 0; i < data.length; i++) {
                        data[i]._path = extractPairs(data[i].coords);
                        delete data[i].coords;
                    }

                    dataCache[key] = data; // Cache the standard array
                    if (activeUtilities.has(key)) calculateStats();
                    return data;
                }
            }));
        });

        layers.push(new ScatterplotLayer({
            id: "active-leaks",
            data: dataCache['active_leaks'] || "/data/active_leaks.parquet",
            loaders: [ParquetLoader],
            loadOptions: LOAD_OPTIONS,
            visible: showLeaks && activeUtilities.has('drinking'),

            // Trivial Accessor
            getPosition: (d: any) => d._pos || [0, 0, 0],

            getFillColor: (d: any, { target }: any) => {
                const p = (d.priority || '').toLowerCase();
                const t = target as number[];
                if (p === 'urgent') return populateColor(t, COLORS.DARK_RED);
                if (p === 'high') return populateColor(t, COLORS.ORANGE);
                if (p === 'medium') return populateColor(t, COLORS.YELLOW);
                return populateColor(t, COLORS.GRAY);
            },

            radiusUnits: 'meters',
            getRadius: 25,
            radiusMinPixels: 4,
            stroked: true,
            getLineColor: [255, 255, 255, 200],
            lineWidthMinPixels: 1,
            pickable: true,
            autoHighlight: true,

            onDataLoad: (data: any) => {
                // 💥 PRE-PROCESS EXACTLY ONCE
                for (let i = 0; i < data.length; i++) {
                    const flat = extractFlatCoords(data[i].coords);
                    data[i]._pos = flat.length >= 2 ? [flat[0], flat[1], 0] : [0, 0, 0];
                    delete data[i].coords;
                }
                dataCache['active_leaks'] = data;
                return data;
            }
        }));

        return layers;
    };

    let isTicking = false;
    const refresh = () => {
        if (isTicking) return;
        isTicking = true;

        window.requestAnimationFrame(() => {
            u("#year-label").text(`${minFilter} - ${maxFilter}`);
            if (deck) deck.setProps({ layers: getLayers() });
            calculateStats();
            isTicking = false;
        });
    };

    try {
        deck = new Deck({
            canvas: 'deck-canvas',
            useDevicePixels: false, // --- OPTIMIZATION 6: DISABLE RETINA FOR HIGH FRAGMENT COUNTS ---
            initialViewState: { longitude: 174.7762, latitude: -41.2865, zoom: 11 },
            controller: true,

            getTooltip: ({ index, layer }: any) => {
                if (!layer?.props.visible || index < 0) return null;

                const object = layer.props.data[index];
                if (!object) return null;

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

        // UI Event Bindings (Unchanged)
        u(".utility-tab").on("click", (e: any) => {
            const id = e.target.id.replace('tab-', '');
            activeUtilities.clear();
            activeUtilities.add(id);
            u(".utility-tab").removeClass("bg-blue-600 text-white shadow-md").addClass("text-slate-400");
            u(`#tab-${id}`).addClass("bg-blue-600 text-white shadow-md").removeClass("text-slate-400");
            lastUtilityId = "";
            refresh();
        });

        u("#zoom-location").on("click", () => {
            if (!navigator.geolocation) {
                alert("Geolocation is not supported by your browser");
                return;
            }
            u("#zoom-location").addClass("animate-pulse text-blue-500");
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    u("#zoom-location").removeClass("animate-pulse text-blue-500");
                    deck.setProps({
                        initialViewState: {
                            ...deck.props.initialViewState,
                            longitude: pos.coords.longitude,
                            latitude: pos.coords.latitude,
                            zoom: 17,
                            transitionDuration: 2000,
                            transitionInterpolator: new FlyToInterpolator()
                        }
                    });
                },
                (err) => {
                    u("#zoom-location").removeClass("animate-pulse text-blue-500");
                    console.error("GPS Error:", err);
                    alert("Unable to find your location. Check your GPS settings.");
                },
                { enableHighAccuracy: true }
            );
        });

        u("#color-mode").on("change", (e: any) => { colorMode = e.target.value; refresh(); });

        u("#year-min").on("input", (e: any) => {
            minFilter = parseInt(e.target.value);
            if (minFilter > maxFilter) {
                maxFilter = minFilter;
                const maxSlider = u("#year-max").first() as HTMLInputElement;
                if (maxSlider) maxSlider.value = String(maxFilter);
            }
            refresh();
        });

        u("#year-max").on("input", (e: any) => {
            maxFilter = parseInt(e.target.value);
            if (maxFilter < minFilter) {
                minFilter = maxFilter;
                const minSlider = u("#year-min").first() as HTMLInputElement;
                if (minSlider) minSlider.value = String(minFilter);
            }
            refresh();
        });

        const toggleAction = () => {
            const body = u("#panel-body");
            const isHidden = body.hasClass("hidden");
            const isMobile = window.innerWidth < 640;
            body.toggleClass("hidden");
            const rotation = isHidden ? "rotate(0deg)" : "rotate(180deg)";
            u("#arrow").attr("style", `transform: ${rotation}`);
            if (isMobile) setTimeout(() => map.resize(), 300);
        };

        u("#toggle-ui").on("click", toggleAction);
        u("#mobile-handle").on("click", toggleAction);

        const bringToFront = (selector: string) => {
            u("#year-min, #year-max").attr("style", "z-index: 10");
            u(selector).attr("style", "z-index: 20");
        };

        u("#year-min").on("mousedown", () => bringToFront("#year-min"));
        u("#year-max").on("mousedown", () => bringToFront("#year-max"));

        u("#toggle-unknown").on("change", (e: any) => { showUnknown = e.target.checked; refresh(); });
        u("#toggle-leaks").on("change", (e: any) => { showLeaks = e.target.checked; refresh(); });

        const modal = u("#modal-overlay");
        u("#open-modal").on("click", () => modal.removeClass("hidden"));
        u("#close-modal").on("click", () => modal.addClass("hidden"));
        modal.on("click", (e: any) => {
            if (e.target.id === "modal-overlay") modal.addClass("hidden");
        });

        const resizeObserver = new ResizeObserver(() => map.resize());
        resizeObserver.observe(document.getElementById('map')!);

    } catch (err) {
        console.error("💥 INIT FATAL ERROR:", err);
    }
}

init();