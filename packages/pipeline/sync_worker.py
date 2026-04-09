import pandas as pd
import urllib.request
import json
import datetime
from pathlib import Path
import diskcache

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

        # Standardize Coords
        if config.get('type') == "line":
            # Ensure this is a raw Python list of lists
            coords = [[float(c[0]), float(c[1])] for c in geom["paths"][0]]
        else:
            coords = [float(geom["x"]), float(geom["y"])]

        # Map requested columns
        row = {col: attrs.get(col) for col in config.get('columns', [])}
        row["coords"] = coords
        
        ts = attrs.get("date_installed")
        row["install_year"] = get_year_from_ts(ts)
        # Use a safe get for length/diameter
        row["length_m"] = float(attrs.get("length_m") or attrs.get("SHAPE_Length") or 0.0)

        all_rows.append(row)

    df = pd.DataFrame(all_rows)
    
    output_path = DATA_DIR / config['output_file']
    df.to_parquet(output_path, index=False, engine='pyarrow', compression='snappy')
    
    logger.info(f"✅ Saved {len(df)} rows to {output_path}")
    return len(df)