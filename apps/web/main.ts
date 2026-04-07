import u from "umbrellajs";
import { Deck } from "@deck.gl/core";
import { PathLayer, IconLayer } from "@deck.gl/layers";
import { ParquetLoader } from "@loaders.gl/parquet";
import { registerLoaders } from "@loaders.gl/core";
import { DataFilterExtension } from "@deck.gl/extensions";
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

registerLoaders(ParquetLoader);

// --- UTILS ---
const unwrap = (obj: any): any => {
    if (!obj) return null;
    if (Array.isArray(obj)) return obj.map(val => (typeof val === 'string' && !isNaN(parseFloat(val))) ? parseFloat(val) : unwrap(val));
    if (obj.list && Array.isArray(obj.list)) {
        return obj.list.map((i: any) => i.element.list ? unwrap(i.element) : (typeof i.element === 'string' ? parseFloat(i.element) : i.element));
    }
    return obj;
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

// --- COLOR LOGIC ---
const getAssetColor = (d: any, mode: string): [number, number, number, number] => {
    if (mode === 'material') {
        const mat = (d.material || '').toUpperCase();
        if (mat.includes('AC')) return [239, 68, 68, 200];      // Red: Asbestos (Critical)
        if (mat.includes('CI') || mat.includes('IRON')) return [168, 85, 247, 200]; // Purple: Cast Iron (Legacy)
        if (mat.includes('ST') || mat.includes('STEEL')) return [234, 179, 8, 200];  // Yellow: Steel
        if (mat.includes('PE') || mat.includes('PVC') || mat.includes('UPVC')) return [59, 130, 246, 200]; // Blue: Modern
        return [100, 116, 139, 150]; // Grey: Unknown
    }

    if (mode === 'age') {
        const yr = Number(d.install_year) || 0;
        if (yr === 0) return [71, 85, 105, 150]; // Unknown Age
        const age = 2026 - yr;
        if (age > 70) return [220, 38, 38, 220]; // Over 70 (Red)
        if (age > 50) return [249, 115, 22, 220]; // 50-70 (Orange)
        if (age > 30) return [234, 179, 8, 220];  // 30-50 (Yellow)
        return [34, 197, 94, 200];               // Modern (Green)
    }

    return [0, 150, 255, 200]; // Default Wellies Blue
};

async function init() {
    console.log("--- 🕵️ WELLIES FORENSIC START ---");

    let startYear = 1970;
    let endYear = new Date().getFullYear();
    let minFilter = startYear;
    let maxFilter = endYear;
    let showUnknown = true;
    let colorMode = 'default'; // State for colorization

    let deck: any = null;
    let globalBins: number[] = [];
    let globalMax = 0;

    const map = new maplibregl.Map({
        container: 'map',
        style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
        interactive: false,
        center: [174.7762, -41.2865],
        zoom: 12
    });

    const getLayers = () => [
        new PathLayer({
            id: "water-pipes-in-use",
            data: "/data/water_pipes_in_use.parquet",
            getPath: (d: any) => unwrap(d.coords),
            getColor: (d: any) => getAssetColor(d, colorMode), // Dynamic Color
            widthMinPixels: 2,
            pickable: true,
            autoHighlight: true,
            highlightColor: [255, 255, 255, 100],
            extensions: [new DataFilterExtension({ filterSize: 2 })],
            getFilterValue: (d: any) => {
                const yr = Number(d.install_year) || 0;
                return [yr === 0 ? maxFilter : yr, yr > 0 ? 1 : 0];
            },
            filterRange: [
                [minFilter, maxFilter],
                [showUnknown ? 0 : 1, 1]
            ],
            updateTriggers: {
                getColor: [colorMode], // Trigger repaint when mode changes
                getFilterValue: [maxFilter],
                filterRange: [minFilter, maxFilter, showUnknown]
            },
            onDataLoad: (data: any) => {
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
                minFilter = startYear;
                maxFilter = endYear;
                u("#year-min").attr({ min: String(startYear), max: String(endYear), value: String(startYear) });
                u("#year-max").attr({ min: String(startYear), max: String(endYear), value: String(endYear) });
                refresh();
            }
        }),
        new IconLayer({
            id: "active-leaks",
            data: "/data/active_leaks.parquet",
            getPosition: (d: any) => unwrap(d.coords),
            iconAtlas: 'https://raw.githubusercontent.com/visgl/deck.gl-data/master/website/icon-atlas.png',
            iconMapping: { marker: { x: 0, y: 0, width: 128, height: 128, anchorY: 128, mask: true } },
            getIcon: () => 'marker',
            getSize: 30,
            getColor: [255, 50, 50],
            pickable: true
        })
    ];

    const refresh = () => {
        u("#year-label").text(`${minFilter} - ${maxFilter}`);
        if (deck) {
            const pipeLayer = deck.props.layers.find((l: any) => l.id === 'water-pipes-in-use');
            const pipeData = pipeLayer?.props.data;

            if (pipeData && Array.isArray(pipeData)) {
                if (globalBins.length === 0) {
                    globalBins = new Array(endYear - startYear + 1).fill(0);
                    for (let i = 0; i < pipeData.length; i++) {
                        const yr = Number(pipeData[i].install_year) || 0;
                        if (yr >= startYear && yr <= endYear) {
                            globalBins[yr - startYear] += parseFloat(pipeData[i].length_m) || 0;
                        }
                    }
                    globalMax = Math.max(...globalBins);
                    u("#hist-bg").attr("d", binsToPath(globalBins, globalMax));
                }

                const sIdx = Math.max(0, minFilter - startYear);
                const eIdx = Math.min(globalBins.length - 1, maxFilter - startYear);
                u("#hist-fg").attr("d", binsToPath(globalBins, globalMax, sIdx, eIdx));

                let totalMeters = 0;
                let visibleCount = 0;
                for (let i = 0; i < pipeData.length; i++) {
                    const d = pipeData[i];
                    const yr = Number(d.install_year) || 0;
                    const yrForSlider = yr === 0 ? maxFilter : yr;
                    if (yrForSlider >= minFilter && yrForSlider <= maxFilter && (showUnknown || yr > 0)) {
                        totalMeters += parseFloat(d.length_m) || 0;
                        visibleCount++;
                    }
                }

                const km = (totalMeters / 1000).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
                u("#audit-stat").html(`
                    <div class="flex justify-between items-center font-mono">
                        <span class="text-slate-400 text-xs">${visibleCount.toLocaleString()} pipes</span>
                        <span class="text-blue-400 font-bold">${km} km</span>
                    </div>
                `);
            }
            deck.setProps({ layers: getLayers() });
        }
    };

    try {
        deck = new Deck({
            canvas: 'deck-canvas',
            width: '100%',
            height: '100%',
            initialViewState: { longitude: 174.7762, latitude: -41.2865, zoom: 12 },
            controller: true,
            getTooltip: (info) => {
                if (!info.object || !info.layer) return null;
                const d = info.object;
                if (info.layer.id === 'water-pipes-in-use') {
                    return {
                        html: `
                            <div style="font-family: monospace; padding: 10px; line-height: 1.4;">
                                <b style="color: #0cf; font-size: 1.1em;">${d.asset_id || 'NO ID'}</b>
                                <hr style="border:0; border-top:1px solid #334155; margin:5px 0;"/>
                                <div style="display: grid; grid-template-columns: 80px 1fr; gap: 4px;">
                                    <span style="color: #94a3b8;">Material:</span> <span>${d.material}</span>
                                    <span style="color: #94a3b8;">Diameter:</span> <span>${d.diameter_mm}mm</span>
                                    <span style="color: #94a3b8;">Install:</span>  <span>${d.install_year || 'Unknown'}</span>
                                    <span style="color: #94a3b8;">Condition:</span><span>${d.condition_grade}</span>
                                </div>
                            </div>
                        `,
                        style: { backgroundColor: 'rgba(15, 23, 42, 0.95)', color: '#fff', borderRadius: '8px', border: '1px solid #334155' }
                    };
                }
                return null;
            },
            onViewStateChange: ({ viewState }) => {
                map.jumpTo({ center: [viewState.longitude, viewState.latitude], zoom: viewState.zoom, bearing: viewState.bearing, pitch: viewState.pitch });
            },
            layers: getLayers()
        });

        // --- UI EVENT LISTENERS ---
        u("#color-mode").on("change", (e: any) => {
            colorMode = e.target.value;
            refresh();
        });

        u("#year-min").on("input", (e: any) => {
            let val = parseInt(e.target.value);
            if (val >= maxFilter) { val = maxFilter; e.target.value = val; }
            minFilter = val;
            u("#year-min").toggleClass("min-on-top", minFilter > endYear - 5);
            refresh();
        });

        u("#year-max").on("input", (e: any) => {
            let val = parseInt(e.target.value);
            if (val <= minFilter) { val = minFilter; e.target.value = val; }
            maxFilter = val;
            refresh();
        });

        u("#toggle-unknown").on("change", (e: any) => {
            showUnknown = e.target.checked;
            refresh();
        });

        setTimeout(() => map.resize(), 100);
    } catch (err) {
        console.error("💥 INIT FATAL ERROR:", err);
    }
}

init();