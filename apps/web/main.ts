import u from "umbrellajs";
import { Deck, FlyToInterpolator } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { DataFilterExtension } from "@deck.gl/extensions";
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// 🚀 THE MAGIC IMPORT: Natively parses Arrow IPC streams
import { tableFromIPC } from 'apache-arrow';

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

    // Asbestos Cement (AC, AC-E, AC-F, Ac)
    if (m.startsWith('AC')) return 'AC';

    // Iron (CI, CIBL, CICL, DI, DICL, DIEP)
    if (m.includes('CI') || m.includes('DI') || m.includes('IRON')) return 'CI';

    // Steel & Galvanized (ST, STEEL, CORR ST, GS, GI)
    if (m.includes('ST') || m === 'GS' || m === 'GI') return 'STEEL';

    // Plastics (PE, PE80, PE100, HDPE, LDPE, PVC, MPVC, UPVC)
    if (m.includes('PE') || m.includes('PVC')) return 'PE';

    // Everything Else (ABS, BRASS, BUTYL, CU, EW, CONC, RCON, BRICK, AL, PITF, PP)
    return 'OTHER';
};

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

// 🎯 Point to the pre-compressed Arrow files
const UTILITY_CONFIG: Record<string, { file: string, color: [number, number, number], label: string }> = {
    drinking: { file: 'drinking_water_pipes.arrow.br', color: [0, 150, 255], label: 'Drinking' },
    waste: { file: 'waste_water_pipes.arrow.br', color: [168, 85, 247], label: 'Waste' },
    storm: { file: 'storm_water_pipes.arrow.br', color: [34, 197, 94], label: 'Storm' }
};

const populateColor = (target: number[], source: [number, number, number, number?]): [number, number, number, number] => {
    target[0] = source[0];
    target[1] = source[1];
    target[2] = source[2];
    target[3] = source[3] ?? 255;
    return target as unknown as [number, number, number, number];
};

const getAssetColor = (row: any, mode: string, utility: string, target: number[]): [number, number, number, number] => {
    if (mode === 'material') {
        const cat = getMaterialCategory(row.material);
        if (cat === 'AC') return populateColor(target, COLORS.RED);
        if (cat === 'CI') return populateColor(target, COLORS.PURPLE);
        if (cat === 'STEEL') return populateColor(target, COLORS.YELLOW);
        if (cat === 'PE') return populateColor(target, COLORS.BLUE);
        return populateColor(target, COLORS.GRAY);
    }
    if (mode === 'age') {
        const yr = Number(row.install_year) || 0;
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


async function init() {
    console.log("--- 🕵️ WELLIES ZERO-COPY START ---");

    let activeMaterials = new Set(['AC', 'CI', 'STEEL', 'PE', 'OTHER']);

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

    // ⚡ THE ZERO-COPY PIPELINE
    const fetchArrowData = async (key: string, file: string, isPoint = false) => {
        if (dataCache[key]) return;

        const res = await fetch(`/data/${file}`);
        const table = await tableFromIPC(res);

        const numRows = table.numRows;

        const coordsCol = table.getChild('coords') as any;
        const installYearCol = table.getChild('install_year') as any;
        const lengthMCol = table.getChild('length_m') as any;

        const coordsData = coordsCol?.data[0];

        const flatCoordsArray = coordsData?.children[0]?.values; // The [x,y,x,y...] array
        const pathOffsetsArray = coordsData?.valueOffsets;       // The [0, 4, 8...] float offsets

        // 🛠️ THE SPIDERWEB FIX: Convert float offsets to vertex offsets
        let vertexOffsets;
        if (pathOffsetsArray) {
            vertexOffsets = new Uint32Array(pathOffsetsArray.length);
            for (let i = 0; i < pathOffsetsArray.length; i++) {
                vertexOffsets[i] = pathOffsetsArray[i] / 2;
            }
        }

        const binaryData: any = {
            length: numRows,
            attributes: {},
            table: table,
            years: installYearCol?.data[0]?.values || new Int32Array(numRows),
            lengths: lengthMCol?.data[0]?.values || new Float32Array(numRows)
        };

        if (isPoint) {
            binaryData.attributes.getPosition = { value: flatCoordsArray, size: 2 };
        } else {
            binaryData.startIndices = vertexOffsets; // 👈 Pass the corrected array here
            binaryData.attributes.getPath = { value: flatCoordsArray, size: 2 };
        }

        dataCache[key] = binaryData;
    };

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

        if (!data || data.length === 0) {
            u("#audit-stat").html(`<span class="text-slate-500 italic">No data loaded for ${currentActive}...</span>`);
            u("#hist-bg").attr("d", "");
            u("#hist-fg").attr("d", "");
            return;
        }

        const numRows = data.length;
        const years = data.years;
        const lengths = data.lengths;

        const materialCol = data.table.getChild('material');

        // --- REBUILD BINS ---
        if (lastUtilityId !== currentActive) {
            globalBins = new Array(endYear - startYear + 1).fill(0);

            // Now using raw Int32/Float32 arrays instead of row objects! (0 allocs)
            for (let i = 0; i < numRows; i++) {
                const matCat = getMaterialCategory(materialCol?.get(i));
                if (!activeMaterials.has(matCat)) continue;

                const yr = years[i] || 0;
                if (yr >= startYear && yr <= endYear) {
                    globalBins[yr - startYear] += lengths[i] || 0;
                }
            }
            globalMax = Math.max(...globalBins);

            const pathData = binsToPath(globalBins, globalMax);
            u("#hist-bg").attr("d", pathData);
            u("#hist-fg").attr("d", pathData);
            lastUtilityId = currentActive;
        }

        // --- LIGHTWEIGHT UPDATES ---
        let totalMeters = 0;
        let visibleCount = 0;

        for (let i = 0; i < numRows; i++) {
            const matCat = getMaterialCategory(materialCol?.get(i));
            if (!activeMaterials.has(matCat)) continue;

            const yr = years[i] || 0;
            const yrForSlider = yr === 0 ? maxFilter : yr;

            if (yrForSlider >= minFilter && yrForSlider <= maxFilter && (showUnknown || yr > 0)) {
                totalMeters += lengths[i] || 0;
                visibleCount++;
            }
        }

        const km = (totalMeters / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });
        u("#audit-stat").html(`
            <div class="flex justify-between items-center font-mono text-xs">
                <span class="text-slate-400">${visibleCount.toLocaleString()} assets</span>
                <span class="text-blue-400 font-bold">${km} km</span>
            </div>
        `);

        const range = endYear - startYear;
        const startPct = ((minFilter - startYear) / range) * 100;
        const endPct = ((maxFilter - startYear) / range) * 100;
        u("#hist-fg").attr("style", `clip-path: polygon(${startPct}% 0%, ${endPct}% 0%, ${endPct}% 100%, ${startPct}% 100%)`);
    };

    const getLayers = () => {
        const layers: any[] = [];

        Object.entries(UTILITY_CONFIG).forEach(([key, config]) => {
            if (!dataCache[key]) return; // Only render if loaded

            layers.push(new PathLayer({
                id: `pipes-${key}`,
                data: dataCache[key],
                visible: activeUtilities.has(key),

                // Hybrid Mode: Deck.gl uses our binary coordinates, but evaluates these accessors
                getColor: (_: any, { index, target }: any) => {
                    const row = dataCache[key].table.get(index);
                    return getAssetColor(row, colorMode, key, target as number[]);
                },
                getFilterValue: (_: any, { index, target }: any) => {
                    const yr = dataCache[key].years[index];

                    const rawMat = dataCache[key].table.getChild('material')?.get(index);
                    const matCat = getMaterialCategory(rawMat);
                    const isMatVisible = activeMaterials.has(matCat);

                    const t = target as number[];
                    t[0] = yr === 0 ? maxFilter : yr;

                    const isAgeVisible = yr > 0 || showUnknown;
                    t[1] = isAgeVisible && isMatVisible ? 1 : 0;

                    return t as unknown as [number, number];
                },

                widthMinPixels: 2,
                pickable: true,
                autoHighlight: true,
                extensions: [new DataFilterExtension({ filterSize: 2 })],
                filterRange: [[minFilter, maxFilter], [1, 1]],
                updateTriggers: {
                    getColor: [colorMode],
                    getFilterValue: [maxFilter, showUnknown, Array.from(activeMaterials).join(',')],
                    filterRange: [minFilter, maxFilter]
                }
            }));
        });

        if (dataCache['active_leaks']) {
            layers.push(new ScatterplotLayer({
                id: "active-leaks",
                data: dataCache['active_leaks'],
                visible: showLeaks && activeUtilities.has('drinking'),

                getFillColor: (_: any, { index, target }: any) => {
                    const row = dataCache['active_leaks'].table.get(index);
                    const p = (row.priority || '').toLowerCase();
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
                autoHighlight: true
            }));
        }

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
        // Pre-fetch the default map assets before booting deck.gl
        await fetchArrowData('drinking', UTILITY_CONFIG.drinking.file, false);
        await fetchArrowData('active_leaks', 'active_leaks.arrow.br', true);

        deck = new Deck({
            canvas: 'deck-canvas',
            useDevicePixels: false,
            initialViewState: { longitude: 174.7762, latitude: -41.2865, zoom: 11 },
            controller: true,

            getTooltip: ({ index, layer }: any) => {
                if (!layer?.props.visible || index < 0) return null;
                const binaryData = layer.props.data;
                if (!binaryData || !binaryData.table) return null;

                const row = binaryData.table.get(index);
                if (!row) return null;

                const isLeak = layer.id === 'active-leaks';
                return {
                    html: isLeak
                        ? `<div class="p-2 font-mono text-xs"><b class="text-red-400">ACTIVE LEAK</b><hr class="my-1 opacity-20"/>${row.status || ''} | Priority: ${row.priority || 'N/A'}</div>`
                        : `<div class="p-2 font-mono text-xs"><b class="text-blue-400">${row.asset_id || 'Pipe'}</b><hr class="my-1 opacity-20"/>${row.material || 'Unknown'} | ${row.diameter_mm || '? '}mm</div>`,
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

        // Initial Draw
        refresh();

        // UI Event Bindings
        u(".utility-tab").on("click", async (e: any) => {
            const id = e.target.id.replace('tab-', '');
            activeUtilities.clear();
            activeUtilities.add(id);
            u(".utility-tab").removeClass("bg-blue-600 text-white shadow-md").addClass("text-slate-400");
            u(`#tab-${id}`).addClass("bg-blue-600 text-white shadow-md").removeClass("text-slate-400");
            lastUtilityId = "";

            refresh(); // Triggers loading state in the UI instantly
            await fetchArrowData(id, UTILITY_CONFIG[id].file, false);
            refresh(); // Renders the map once data arrives
        });

        u("#btn-mat-all").on("click", () => {
            activeMaterials = new Set(['AC', 'CI', 'STEEL', 'PE', 'OTHER']);
            u(".mat-filter").each((node) => { (node as HTMLInputElement).checked = true; });
            lastUtilityId = "";
            refresh();
        });

        u("#btn-mat-none").on("click", () => {
            activeMaterials.clear();
            u(".mat-filter").each((node) => { (node as HTMLInputElement).checked = false; });
            lastUtilityId = "";
            refresh();
        });

        u(".mat-filter").on("change", (e: any) => {
            const matValue = e.target.value;
            if (e.target.checked) {
                activeMaterials.add(matValue);
            } else {
                activeMaterials.delete(matValue);
            }
            lastUtilityId = "";
            refresh();
        });

        u("#zoom-location").on("click", () => {
            if (!navigator.geolocation) return alert("Geolocation not supported");
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
                    console.error(err);
                },
                { enableHighAccuracy: true }
            );
        });

        u("#color-mode").on("change", (e: any) => { colorMode = e.target.value; refresh(); });
        u("#toggle-unknown").on("change", (e: any) => { showUnknown = e.target.checked; refresh(); });
        u("#toggle-leaks").on("change", (e: any) => { showLeaks = e.target.checked; refresh(); });

        u("#year-min").on("input", (e: any) => {
            minFilter = parseInt(e.target.value);
            if (minFilter > maxFilter) {
                maxFilter = minFilter;
                (u("#year-max").first() as HTMLInputElement).value = String(maxFilter);
            }
            refresh();
        });

        u("#year-max").on("input", (e: any) => {
            maxFilter = parseInt(e.target.value);
            if (maxFilter < minFilter) {
                minFilter = maxFilter;
                (u("#year-min").first() as HTMLInputElement).value = String(minFilter);
            }
            refresh();
        });

        const toggleAction = () => {
            const body = u("#panel-body");
            const isHidden = body.hasClass("hidden");
            const isMobile = window.innerWidth < 640;
            body.toggleClass("hidden");
            u("#arrow").attr("style", `transform: ${isHidden ? "rotate(0deg)" : "rotate(180deg)"}`);
            if (isMobile) setTimeout(() => map.resize(), 300);
        };

        u("#toggle-ui").on("click", toggleAction);
        u("#mobile-handle").on("click", toggleAction);
        u("#year-min, #year-max").on("mousedown", (e: any) => {
            u("#year-min, #year-max").attr("style", "z-index: 10");
            u(e.target).attr("style", "z-index: 20");
        });

        const modal = u("#modal-overlay");
        u("#open-modal").on("click", () => modal.removeClass("hidden"));
        u("#close-modal").on("click", () => modal.addClass("hidden"));
        modal.on("click", (e: any) => { if (e.target.id === "modal-overlay") modal.addClass("hidden"); });

        new ResizeObserver(() => map.resize()).observe(document.getElementById('map')!);

    } catch (err) {
        console.error("💥 INIT FATAL ERROR:", err);
    }
}

init();