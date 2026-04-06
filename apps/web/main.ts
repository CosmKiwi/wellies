import u from "umbrellajs";
import { Deck } from "@deck.gl/core";
import { PathLayer, IconLayer } from "@deck.gl/layers";
import { ParquetLoader } from "@loaders.gl/parquet";
import { registerLoaders } from "@loaders.gl/core";
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

registerLoaders(ParquetLoader);

// Helper to handle Parquet's 3-level list nesting
const unwrap = (obj: any): any => {
    if (!obj) return null;
    if (Array.isArray(obj)) {
        return obj.map(val => (typeof val === 'string' && !isNaN(parseFloat(val))) ? parseFloat(val) : unwrap(val));
    }
    if (obj.list && Array.isArray(obj.list)) {
        return obj.list.map((i: any) => i.element.list ? unwrap(i.element) : (typeof i.element === 'string' ? parseFloat(i.element) : i.element));
    }
    return obj;
};

async function init() {
    console.log("--- 🕵️ WELLIES FORENSIC START ---");

    // 1. Initialize MapLibre Basemap
    const map = new maplibregl.Map({
        container: 'map',
        style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
        interactive: false, // Deck.gl drives camera
        center: [174.7762, -41.2865],
        zoom: 12
    });

    try {
        console.log("1. Initializing Deck.gl Instance...");
        new Deck({
            canvas: 'deck-canvas',
            width: '100%',
            height: '100%',
            initialViewState: {
                longitude: 174.7762,
                latitude: -41.2865,
                zoom: 12,
                pitch: 0,
                bearing: 0
            },
            controller: true,

            // THE HIT TEST: 0 network requests required
            getTooltip: (info) => {
                if (!info.object) return null;

                const { object, layer } = info;
                // Forensic check: Log exactly what's inside the clicked object
                // console.log("🔍 Hit Test Result:", object);

                if (layer.id === 'water-pipes') {
                    return {
                        html: `
                            <div style="font-family: monospace; padding: 5px;">
                                <b style="color: #0cf">PIPE INFO</b><br/>
                                ID: ${object.asset_id}<br/>
                                Type: ${object.pipe_type}<br/>
                                Material: ${object.material}<br/>
                                Diameter: ${object.diameter_mm}mm
                            </div>
                        `,
                        style: { backgroundColor: '#111', color: '#fff', fontSize: '12px', borderRadius: '8px', border: '1px solid #333' }
                    };
                }

                if (layer.id === 'active-leaks') {
                    return {
                        html: `
                            <div style="font-family: monospace; padding: 5px;">
                                <b style="color: #f33">LEAK REPORT</b><br/>
                                Status: ${object.status}<br/>
                                Priority: ${object.priority || 'Medium'}<br/>
                                Description: ${object.description}
                            </div>
                        `,
                        style: { backgroundColor: '#111', color: '#fff', fontSize: '12px', borderRadius: '8px', border: '1px solid #333' }
                    };
                }
                return null;
            },

            onViewStateChange: ({ viewState }) => {
                map.jumpTo({
                    center: [viewState.longitude, viewState.latitude],
                    zoom: viewState.zoom,
                    bearing: viewState.bearing,
                    pitch: viewState.pitch
                });
            },

            layers: [
                new PathLayer({
                    id: "water-pipes",
                    data: "/data/water_pipes.parquet",
                    onDataLoad: (data: any) => {
                        console.log("📊 DATA LOADED: water_pipes.parquet");
                        console.log("SAMPLE ROW:", data[0]);
                        u("#audit-stat").text(`${data.length.toLocaleString()} Pipes Rendered`);
                    },
                    getPath: (d: any) => unwrap(d.coords),
                    getColor: [0, 150, 255, 200],
                    widthMinPixels: 2,
                    pickable: true
                }),
                new IconLayer({
                    id: "active-leaks",
                    data: "/data/active_leaks.parquet",
                    onDataLoad: (data: any) => {
                        console.log("📍 DATA LOADED: active_leaks.parquet");
                        console.log("LEAK UNWRAPPED:", unwrap(data[0]?.coords));
                    },
                    getPosition: (d: any) => unwrap(d.coords),
                    iconAtlas: 'https://raw.githubusercontent.com/visgl/deck.gl-data/master/website/icon-atlas.png',
                    iconMapping: {
                        marker: { x: 0, y: 0, width: 128, height: 128, anchorY: 128, mask: true }
                    },
                    getIcon: () => 'marker',
                    getSize: 30,
                    sizeMinPixels: 5,
                    getColor: [255, 50, 50, 255],
                    pickable: true
                })
            ],
            onError: (err) => console.error("🔥 DECK.GL INTERNAL CRASH:", err)
        });

        setTimeout(() => map.resize(), 100);
        console.log("2. Deck.gl is live.");
    } catch (err) {
        console.error("💥 INIT FATAL ERROR:", err);
    }
}

init();