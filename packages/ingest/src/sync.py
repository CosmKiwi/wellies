import datetime
import pandas as pd
import json
import urllib.request
import time
from pathlib import Path
import geopandas as gpd
from shapely.geometry import LineString, Point

# Setup paths relative to script location
ROOT_DIR = Path(__file__).parent.parent.parent.parent
DATA_DIR = ROOT_DIR / "apps" / "web" / "public" / "data" 
RAW_DIR = ROOT_DIR / "data" / "raw"

DATA_DIR.mkdir(parents=True, exist_ok=True)
RAW_DIR.mkdir(parents=True, exist_ok=True)

LAYERS = [
    {"url": "https://services7.arcgis.com/2ECs938g489DMWjt/ArcGIS/rest/services/Job_Status_Public_View/FeatureServer/5/query", "name": "active_leaks", "type": "point"},
    # {"url": "https://services7.arcgis.com/2ECs938g489DMWjt/ArcGIS/rest/services/Regional_Water_Pipes/FeatureServer/0/query", "name": "water_pipes", "type": "line"},
    {"url": "https://gis.wellingtonwater.co.nz/server1/rest/services/Councils/Regional_Water_Pipes/MapServer/0/query", "name": "water_pipes", "type": "line"}
]

def get_paged_data(layer_url, name):
    cache_file = RAW_DIR / f"{name}.json"
    if cache_file.exists(): return json.loads(cache_file.read_text(encoding='utf-8'))
    all_features = []
    offset, batch_size = 0, 2000 
    while True:
        print(f"Fetching batch {offset} to {offset + batch_size}")
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
    all_rows = []
    in_use_rows = []
    
    PRODUCTION_COLUMNS = [
        "asset_id", "system_type", "pipe_use", "pipe_type", "diameter_mm", 
        "material", "condition_grade", "length_m", "criticality", 
        "external_protection", "joint_type", "lining_type", 
        "maintenance", "owner", "pipe_class", "uid", "globalid"
    ]
    
    PRETTY_NAMES = {
        "joint_type": {"RRJ": "Rubber Ring", "FLG": "Flanged", "BW": "Butt Weld", "EFSW": "Electrofusion"},
        "external_protection": {"CTE": "Coal Tar Enamel", "PE": "Polyethylene", "BITU": "Bitumen"},
        "maintenance": {"Wellington Water Alliance": "WWA"}
    }

    def get_year(ts):
        if ts is None or not isinstance(ts, (int, float)): return None
        try:
            epoch = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
            dt = epoch + datetime.timedelta(milliseconds=ts)
            return dt.year
        except (OverflowError, ValueError): return None

    for f in data["features"]:
        attrs = f["attributes"]
        geom_raw = f.get("geometry")
        if not geom_raw: continue
        
        # Ensure coords are strictly a list of floats (no strings allowed)
        if layer_type == "line":
            # Flatten to a clean list of [float, float]
            coords = [[float(coord[0]), float(coord[1])] for coord in geom_raw["paths"][0]]
        else:
            coords = [float(geom_raw["x"]), float(geom_raw["y"])]

        # --- EXPORT 1: LEAKS (Generic) ---
        # Don't convert everything to string; keep native types for the dataframe
        row = {k: v for k, v in attrs.items()}
        row["coords"] = coords 
        
        # We don't strictly need lon/lat if we use coords, but keeping for compatibility
        if layer_type == "point":
            row["lon"] = coords[0]
            row["lat"] = coords[1]
            
        all_rows.append(row)

        # --- EXPORT 2: PRODUCTION PIPES ---
        if name == "water_pipes" and attrs.get("operational_status") == "In Use":
            p_row = {k: attrs.get(k, "") for k in PRODUCTION_COLUMNS}
            p_row["coords"] = coords 
            
            raw_len = attrs.get('length_m')
            p_row["length_m"] = float(raw_len) if raw_len is not None else 0.0
            
            p_row["install_year"] = get_year(attrs.get("date_installed"))
            p_row["lined_year"] = get_year(attrs.get("date_lined"))
            p_row["protection_year"] = get_year(attrs.get("external_protection_date"))

            for field, mapping in PRETTY_NAMES.items():
                val = attrs.get(field, "")
                if val in mapping: p_row[field] = mapping[val]
            
            in_use_rows.append(p_row)

    # EXPORT 1 Logic
    if all_rows and name == "active_leaks":
        df_all = pd.DataFrame(all_rows)
        # Drop the redundant geometry column if ArcGIS provided it as an attribute
        if 'geometry' in df_all.columns:
            df_all = df_all.drop(columns=['geometry'])
            
        df_all.to_parquet(DATA_DIR / f"{name}.parquet", index=False, engine='pyarrow')
        print(f"✅ Saved Leaks: {name}.parquet ({len(df_all)} rows)")

    # EXPORT 2 Logic
    if in_use_rows and name == "water_pipes":
        df_prod = pd.DataFrame(in_use_rows)
        for yr in ["install_year", "lined_year", "protection_year"]:
            df_prod[yr] = pd.to_numeric(df_prod[yr], errors='coerce').fillna(0).astype('int16')
        
        df_prod["length_m"] = df_prod["length_m"].astype('float32')
        df_prod.to_parquet(DATA_DIR / f"{name}_in_use.parquet", index=False, engine='pyarrow')
        print(f"⚡ Saved Production Pipes: {name}_in_use.parquet ({len(df_prod):,} rows)")

if __name__ == "__main__":
    for layer in LAYERS:
        data = get_paged_data(layer["url"], layer["name"])
        if data: process_to_parquet(layer["name"], data, layer["type"])