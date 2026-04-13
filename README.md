# Wellies 🚀

Wellies is a high-performance web mapping application built to visualize large-scale geospatial data using **Deck.gl**, **MapLibre**, and **Apache Arrow**. It is structured as a monorepo containing the frontend web application, a data integration pipeline, and a Cloudflare proxy.

## 🏗️ Monorepo Architecture

This repository uses Bun workspaces and is organized into the following components:

- `apps/web`: The main frontend client built with Vite, TypeScript, and Deck.gl.
- `packages/pipeline`: A Python-based ingestion system that fetches raw GIS data, processes it, and continuously publishes zero-copy Apache Arrow buffers.
- `wellies-proxy`: A Cloudflare Worker handling secure proxy routing to the R2 asset bucket.

## 🚀 Getting Started

Ensure you have [Bun](https://bun.sh/) installed.

### 1. Install Dependencies
Run the following from the root directory to install all workspace dependencies:
```bash
bun install
```

### 2. Local Development

**Run the web app (Frontend):**
```bash
bun run dev
```
Starts the Vite development server for the `apps/web` project.

**Run the Proxy:**
```bash
cd wellies-proxy
bun run dev
```
Starts the local Wrangler environment.

**Run the Pipeline Engine:**
The pipeline requires Python. We recommend using `uv` or creating a virtual environment:
```bash
cd packages/pipeline
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt # (or `uv sync`)
python tasks.py
```
> Note: The pipeline uses the `WELLIES_DATA_DIR` environment variable to determine where `.arrow.gz` files are compiled. If unset, it attempts to drop files directly into `apps/web/public/data`.

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
