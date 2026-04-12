import marimo

__generated_with = "0.22.5"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    import polars as pl
    from pathlib import Path
    import brotli
    import io

    # 1. Setup path
    folder_path = Path("../../apps/web/public/data/")
    # Find both parquet and compressed arrow files
    data_files = list(folder_path.glob("*.parquet")) + list(folder_path.glob("*.arrow.br"))

    tab_contents = {}

    for file_path in data_files:
        try:
            if file_path.name.endswith(".arrow.br"):
                # 1. Read compressed bytes
                with open(file_path, "rb") as f:
                    compressed_data = f.read()

                # 2. Decompress in memory
                decompressed_data = brotli.decompress(compressed_data)

                # 3. Load into Polars (Arrow IPC)
                # Note: IPC doesn't support 'scan' (lazy) as easily as parquet
                # so we read it into memory.
                df = pl.read_ipc_stream(io.BytesIO(decompressed_data))
                lf = df.lazy()

            # --- RENDER LOGIC (Same as your parquet version) ---
                schema = lf.collect_schema()
                column_names = schema.names()
                row_count = lf.select(pl.len()).collect().item()
    
                file_header = mo.md(
                    f"### 📂 {file_path.name}\n"
                    f"**Format:** {'Parquet' if file_path.suffix == '.parquet' else 'Compressed Arrow'}\n"
                    f"**Total Rows:** {row_count:,} | **Total Columns:** {len(column_names)}"
                ).style({"position": "sticky", "top": "0", "background": "white", "padding": "10px 0", "border-bottom": "1px solid #ddd"})
    
                column_tables = []
                for col in column_names:
                    if col == "coords":
                        # Get the average length of the coordinate arrays to ensure they aren't empty
                        coord_stats = (
                            lf.select([
                                pl.col("coords").list.len().mean().alias("avg_points"),
                                pl.col("coords").list.get(0).alias("first_lon"),
                                pl.col("coords").list.get(1).alias("first_lat"),
                            ])
                            .collect()
                        )
                    
                        table_view = mo.vstack([
                            mo.md(f"**📍 {col} (Geometry)**"),
                            mo.md(f"Avg sequence: {coord_stats['avg_points'][0]:.1f} values"),
                            mo.md(f"Sample: `{coord_stats['first_lon'][0]:.4f}, {coord_stats['first_lat'][0]:.4f}`")
                        ], align="start")
                        column_tables.append(table_view)
                        continue
            
                    # Skip other truly nested types (if any)
                    if schema[col].is_nested():
                        print(f"Column {col} is nested")
                        continue
    
                    agg_df = (
                        lf.group_by(col)
                        .agg(pl.len().alias("recs"))
                        .sort("recs", descending=True)
                        .limit(10)
                        .collect()
                    )
    
                    table_view = mo.vstack([
                        mo.md(f"**{col}**"),
                        mo.ui.table(agg_df, pagination=True)
                    ], align="start")
                    column_tables.append(table_view)
    
                tab_contents[file_path.name] = mo.vstack([
                    file_header,
                    mo.hstack(column_tables, wrap=True, align="start", gap=2)
                ])

        except Exception as e:
            tab_contents[file_path.name] = mo.md(f"❌ **Error loading {file_path.name}:** {str(e)}")

    mo.vstack([
        mo.md(f"# Parquet Folder Explorer"),
        mo.ui.tabs(tab_contents)
    ])
    return


if __name__ == "__main__":
    app.run()
