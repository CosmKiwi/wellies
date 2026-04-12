import pandas as pd
import urllib.request
import json
import datetime
from pathlib import Path
import diskcache
import pyarrow as pa
import pyarrow.parquet as pq

cache = diskcache.Cache(Path(__file__).parent / ".cache_db")

def get_paged_data(url, layer_name, ttl_hours=6):
    cache_key = f"raw_gis_{layer_name}"
    
    # 1. Check Cache
    cached_features = cache.get(cache_key)
    if cached_features:
        print(f"📦 Cache Hit! Loading {layer_name} from disk...")
        # Return in the same format as the API logic
        return {"features": cached_features}
    
    # 2. Cache Miss - Fetch from GIS
    print(f"📡 Cache Miss! Downloading {layer_name} from Wellington Water...")
    all_features = []
    offset = 0
    limit = 1000

    while True:
        query_url = (
                f"{url}?where=1%3D1"
                f"&outFields=*"
                f"&f=json"
                f"&outSR=4326"
                f"&resultOffset={offset}"
                f"&resultRecordCount={limit}"
        )
        with urllib.request.urlopen(query_url) as response:
            data = json.loads(response.read().decode())
            features = data.get("features", [])
            all_features.extend(features)
            
            if len(features) < limit:
                break
            offset += limit
            print(f"   ...fetched {len(all_features)} features for {layer_name}")

    # 3. Store the list in cache
    cache.set(cache_key, all_features, expire=ttl_hours * 60 * 60)
    
    # Return consistent dictionary format
    return {"features": all_features}

def get_year_from_ts(ts):
    if ts is None or not isinstance(ts, (int, float)): return None
    try:
        epoch = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
        dt = epoch + datetime.timedelta(milliseconds=ts)
        return dt.year
    except (OverflowError, ValueError): return None

def run_sync(config, logger):
    # Standardize data dir (ensure it exists)
    DATA_DIR = Path(__file__).parent.parent.parent / "apps" / "web" / "public" / "data"
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    logger.info(f"🛰️ Requesting data for {config['name']}...")
    raw_data = get_paged_data(config['url'], config['name'])
    
    all_rows = []
    for f in raw_data["features"]:
        attrs = f["attributes"]
        geom = f.get("geometry")
        if not geom: continue

        # --- OPTIMIZATION 1: FLAT COORDINATES ---
        if config.get('type') == "line":
            # Flatten to a single 1D list: [lon1, lat1, lon2, lat2, ...]
            # This completely eliminates the deep nesting in loaders.gl
            coords = []
            for pt in geom["paths"][0]:
                coords.extend([float(pt[0]), float(pt[1])])
        else:
            coords = [float(geom["x"]), float(geom["y"])]

        # Map requested columns
        row = {col: attrs.get(col) for col in config.get('columns', [])}
        row["coords"] = coords
        
        ts = attrs.get("date_installed")
        # Default missing years to 0 here to avoid NaN handling in JS
        row["install_year"] = get_year_from_ts(ts) or 0 
        
        row["length_m"] = float(attrs.get("length_m") or attrs.get("SHAPE_Length") or 0.0)

        all_rows.append(row)

    # --- OPTIMIZATION 2: DOWNCASTING MEMORY ---
    df = pd.DataFrame(all_rows)
    
    # Force float32 (deck.gl only uses 32-bit floats anyway) and lower-bit integers
    df['length_m'] = df['length_m'].astype('float32')
    df['install_year'] = df['install_year'].astype('int32')

    output_path = DATA_DIR / config['output_file']
    
    # --- OPTIMIZATION 3: ZSTD COMPRESSION ---
    df.to_parquet(
        output_path, 
        index=False, 
        engine='pyarrow', 
        compression='zstd' 
    )
    
    logger.info(f"✅ Saved {len(df)} rows to {output_path}")
    return len(df)