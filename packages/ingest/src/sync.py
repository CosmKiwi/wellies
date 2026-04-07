import datetime
import pandas as pd
import json
import urllib.request
import time
from pathlib import Path

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
    
    # Updated Production Schema
    PRODUCTION_COLUMNS = [
        "asset_id", "system_type", "pipe_use", "pipe_type", "diameter_mm", 
        "material", "condition_grade", "length_m", "criticality", 
        "external_protection", "joint_type", "lining_type", 
        "maintenance", "owner", "pipe_class", "uid", "globalid"
    ]
    
    # Mapping for Joint Types and Protection (Examples based on your aggregate)
    PRETTY_NAMES = {
        "joint_type": {"RRJ": "Rubber Ring", "FLG": "Flanged", "BW": "Butt Weld", "EFSW": "Electrofusion"},
        "external_protection": {"CTE": "Coal Tar Enamel", "PE": "Polyethylene", "BITU": "Bitumen"},
        "maintenance": {"Wellington Water Alliance": "WWA"}
    }

    def get_year(ts):
        # Use 'is not None' to allow 0 (the epoch itself)
        if ts is None or not isinstance(ts, (int, float)): 
            return None
            
        try:
            # Define the Unix Epoch start point
            epoch = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
            
            # Add the milliseconds as a duration (timedelta)
            # This works perfectly for negative numbers on all Operating Systems
            dt = epoch + datetime.timedelta(milliseconds=ts)
            
            return dt.year
        except (OverflowError, ValueError):
            return None

    for f in data["features"]:
        attrs = f["attributes"]
        geom = f["geometry"]
        
        # Base row
        row = {k: str(v) if v is not None else "" for k, v in attrs.items()}
        row["coords"] = geom["paths"][0] if layer_type == "line" else [float(geom["x"]), float(geom["y"])]
        all_rows.append(row)
        
        if name == "water_pipes" and attrs.get("operational_status") == "In Use":
            p_row = {k: str(attrs.get(k, "")) for k in PRODUCTION_COLUMNS}
            
            # 1. Clean up numeric/length fields
            try: p_row["length_m"] = f"{float(attrs.get('length_m', 0)):.1f}"
            except: p_row["length_m"] = "0"

            # 2. Convert Timestamps to Years (Integers)
            p_row["install_year"] = get_year(attrs.get("date_installed"))
            p_row["lined_year"] = get_year(attrs.get("date_lined"))
            p_row["protection_year"] = get_year(attrs.get("external_protection_date"))

            # 3. Apply Pretty Names (using your aggregate codes)
            for field, mapping in PRETTY_NAMES.items():
                val = attrs.get(field, "")
                if val in mapping: p_row[field] = mapping[val]

            p_row["coords"] = row["coords"]
            in_use_rows.append(p_row)

    pd.DataFrame(all_rows).to_parquet(DATA_DIR / f"{name}.parquet", index=False)
    if in_use_rows:
        df_prod = pd.DataFrame(in_use_rows)
        # Convert year columns to nullable ints for cleaner Parquet storage
        for yr in ["install_year", "lined_year", "protection_year"]:
            df_prod[yr] = pd.to_numeric(df_prod[yr], errors='coerce').astype('Int64')
            
        df_prod.to_parquet(DATA_DIR / f"{name}_in_use.parquet", index=False)
        print(f"⚡ Saved Production: {name}_in_use.parquet ({len(df_prod):,} rows)")

if __name__ == "__main__":
    for layer in LAYERS:
        data = get_paged_data(layer["url"], layer["name"])
        if data: process_to_parquet(layer["name"], data, layer["type"])