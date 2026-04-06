import json
import urllib.request
import time
import pandas as pd
from pathlib import Path

# Setup paths relative to script location
ROOT_DIR = Path(__file__).parent.parent.parent.parent
DATA_DIR = ROOT_DIR / "apps" / "web" / "public" / "data" 
RAW_DIR = ROOT_DIR / "data" / "raw"

DATA_DIR.mkdir(parents=True, exist_ok=True)
RAW_DIR.mkdir(parents=True, exist_ok=True)

LAYERS = [
    {"url": "https://services7.arcgis.com/2ECs938g489DMWjt/ArcGIS/rest/services/Job_Status_Public_View/FeatureServer/5/query", "name": "active_leaks", "type": "point"},
    {"url": "https://services7.arcgis.com/2ECs938g489DMWjt/ArcGIS/rest/services/Regional_Water_Pipes/FeatureServer/0/query", "name": "water_pipes", "type": "line"}
]

def get_paged_data(layer_url, name):
    cache_file = RAW_DIR / f"{name}.json"
    if cache_file.exists(): return json.loads(cache_file.read_text(encoding='utf-8'))
    all_features = []
    offset, batch_size = 0, 2000 
    while True:
        query_params = f"where=1%3D1&outFields=*&outSR=4326&f=json&resultOffset={offset}&resultRecordCount={batch_size}&returnGeometry=true"
        try:
            req = urllib.request.Request(f"{layer_url}?{query_params}", headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req) as res:
                data = json.loads(res.read().decode())
                features = data.get("features", [])
                if not features: break
                all_features.extend(features)
                if len(features) < batch_size: break
                offset += batch_size
                time.sleep(0.1) 
        except Exception: break
    final_data = {"features": all_features}
    cache_file.write_text(json.dumps(final_data), encoding='utf-8')
    return final_data

def process_to_parquet(name, data, layer_type):
    print(f"--- 🛠️ PROCESSING {name} ---")
    rows = []
    for f in data["features"]:
        # Sanitize attributes to strings, keep geometry numeric
        row = {k: str(v) if v is not None else "" for k, v in f["attributes"].items()}
        geom = f["geometry"]
        if layer_type == "line":
            row["coords"] = geom["paths"][0]
        else:
            row["coords"] = [float(geom["x"]), float(geom["y"])]
        rows.append(row)

    df = pd.DataFrame(rows)
    output_path = DATA_DIR / f"{name}.parquet"
    df.to_parquet(output_path, compression="snappy", index=False)
    print(f"✓ Saved {name}.parquet")

if __name__ == "__main__":
    for layer in LAYERS:
        data = get_paged_data(layer["url"], layer["name"])
        if data: process_to_parquet(layer["name"], data, layer["type"])