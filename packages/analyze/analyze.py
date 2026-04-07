import marimo

__generated_with = "0.22.5"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    import polars as pl
    from pathlib import Path

    # 1. Setup path
    folder_path = Path("c:/Dev/wellies/apps/web/public/data/")
    parquet_files = list(folder_path.glob("*.parquet"))

    # Dictionary to hold the UI for each file: { "Tab Name": UI_Content }
    tab_contents = {}

    for file_path in parquet_files:
        try:
            # Scan the file lazily
            lf = pl.scan_parquet(file_path)
        
            # Optimized schema/column fetching
            schema = lf.collect_schema()
            column_names = schema.names()
        
            # Quick summary stats
            row_count = lf.select(pl.len()).collect().item()
        
            # Create a sticky header for the file info
            file_header = mo.md(
                f"### 📂 {file_path.name}\n"
                f"**Total Rows:** {row_count:,} | **Total Columns:** {len(column_names)}"
            ).style({"position": "sticky", "top": "0", "background": "white", "z-index": "10", "padding": "10px 0", "border-bottom": "1px solid #ddd"})
        
            column_tables = []
        
            for col in column_names:
                # Skip nested types
                if schema[col].is_nested():
                    continue
                
                # Aggregate: Top 10 by count
                agg_df = (
                    lf.group_by(col)
                    .agg(pl.len().alias("recs"))
                    .sort("recs", descending=True)
                    .limit(10)
                    .collect()
                )
            
                # Build the column card
                table_view = mo.vstack([
                    mo.md(f"**{col}**"),
                    mo.ui.table(agg_df, pagination=True)
                ], align="start")
            
                column_tables.append(table_view)
        
            # Combine header and the grid of tables into the tab body
            tab_contents[file_path.name] = mo.vstack([
                file_header,
                mo.hstack(column_tables, wrap=True, align="start", gap=2)
            ])
        
        except Exception as e:
            tab_contents[file_path.name] = mo.md(f"❌ **Error loading {file_path.name}:** {str(e)}")

    # 2. Render as Tabs
    # Using mo.ui.tabs creates a navigation bar at the top
    mo.vstack([
        mo.md(f"# Parquet Folder Explorer"),
        mo.ui.tabs(tab_contents)
    ])
    return


if __name__ == "__main__":
    app.run()
