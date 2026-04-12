import pandas as pd
import urllib.request
import json
import datetime
from pathlib import Path
import diskcache
import pyarrow as pa
import pyarrow.parquet as pq
import brotli

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
    DATA_DIR = Path(__file__).parent.parent.parent / "apps" / "web" / "public" / "data"
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    logger.info(f"🛰️ Requesting data for {config['name']}...")
    raw_data = get_paged_data(config['url'], config['name'], config['cache_ttl_hours'])
    
    arrow_rows = []
    parquet_rows = []

    for f in raw_data["features"]:
        attrs = f["attributes"]
        geom = f.get("geometry")
        if not geom: continue

        # Standardize Coords
        if config.get('type') == "line":
            coords = []
            for pt in geom["paths"][0]:
                coords.extend([float(pt[0]), float(pt[1])])
        else:
            coords = [float(geom["x"]), float(geom["y"])]

        # Shared calculated fields
        install_year = get_year_from_ts(attrs.get("date_installed")) or 0
        length_m = float(attrs.get("length_m") or attrs.get("SHAPE_Length") or 0.0)

        # 1. Build Arrow Row (Core Data) - WITH SANITIZATION
        a_row = {}
        for col in config.get('arrow_columns', []):
            val = attrs.get(col)
            # Force to string unless it's a null-type (NaN/None)
            # This prevents "Expected bytes, got a 'float' object" errors
            a_row[col] = str(val) if not pd.isna(val) else None
            
        a_row.update({
            "coords": coords, 
            "install_year": install_year, 
            "length_m": length_m
        })
        arrow_rows.append(a_row)

        # 2. Build Parquet Row (Supplementary Data)
        p_row = {col: attrs.get(col) for col in config.get('parquet_columns', [])}
        p_row.update({"install_year": install_year, "length_m": length_m})
        parquet_rows.append(p_row)

    output_path = DATA_DIR / config['output_file']

    # --- PARQUET EXPORT (Supplementary) ---
    df_p = pd.DataFrame(parquet_rows)
    if not df_p.empty:
        df_p['length_m'] = df_p['length_m'].astype('float32')
        df_p['install_year'] = df_p['install_year'].astype('int32')
        
        parquet_file = output_path.with_suffix('.parquet')
        df_p.to_parquet(parquet_file, index=False, engine='pyarrow', compression='zstd')
        logger.info(f"✅ Saved Parquet (Metadata) to {parquet_file}")

    # --- ARROW EXPORT (Core) ---
    if arrow_rows:
        # Schema definition matches the string-forced columns above
        fields = [(col, pa.string()) for col in config.get('arrow_columns', [])]
        fields.extend([
            ('coords', pa.list_(pa.float32())),
            ('install_year', pa.int32()),
            ('length_m', pa.float32())
        ])
        schema = pa.schema(fields)
        
        # from_pylist will now succeed because all types match the schema
        table = pa.Table.from_pylist(arrow_rows, schema=schema)
        sink = pa.BufferOutputStream()
        with pa.RecordBatchStreamWriter(sink, schema) as writer:
            writer.write_table(table)
            
        compressed_bytes = brotli.compress(sink.getvalue().to_pybytes())
        arrow_file = output_path.with_suffix('.arrow.br')
        with open(arrow_file, "wb") as f:
            f.write(compressed_bytes)
        
        logger.info(f"✅ Saved Arrow (Core) to {arrow_file}")

    return len(arrow_rows)