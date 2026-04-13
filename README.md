<p align="center">
  <a href="https://wellies.app">
    <img src="https://wellies.app/images/gumboots_460.png" alt="Wellies Logo" width="180"/>
  </a>
</p>

# Wellies

View the live app here: <a href="https://wellies.app">https://wellies.app</a></strong>

**Wellies** is an independent, open-source tool designed to visualize the water infrastructure of the Wellington Region. It provides a historical and spatial overview of networks using publicly available data.

---

## 🏗️ System Architecture

Wellies is a high-performance web mapping application built to handle large-scale geospatial data. It uses a fully decoupled, zero-copy binary streaming pipeline.

* **Visuals:** [Deck.gl](https://deck.gl/) & [MapLibre](https://maplibre.org/)
* **Format:** [Apache Arrow](https://arrow.apache.org/) (Zero-copy IPC streams via native HTTP GZIP)
* **Pipeline:** [Plombery](https://github.com/lucafaggianelli/plombery) & [anyio](https://anyio.readthedocs.io/)
* **Interface:** [Umbrella JS](https://umbrellajs.com/)

This repository uses [Bun](https://bun.sh/) workspaces and is organized into the following components:

* `apps/web`: The main frontend client built with Vite and TypeScript.
* `packages/pipeline`: A Python-based ingestion system that fetches raw GIS data, processes it, and continuously publishes compressed Apache Arrow buffers.
* `wellies-proxy`: A Cloudflare Worker handling secure, edge-cached proxy routing to an R2 asset bucket.

## 🚀 Getting Started

Ensure you have [Bun](https://bun.sh/) installed.

### 1. Install Dependencies
Run the following from the root directory to install all workspace dependencies:
```bash
bun install
```

### 2. Local Development
Run the Web App (Frontend):

```bash
bun run dev
```
Starts the Vite development server for the apps/web project.

Run the Proxy:

```bash
cd wellies-proxy
bun run dev
```
Starts the local Cloudflare Wrangler environment.

Run the Pipeline Engine:
The pipeline requires Python. We recommend using uv or creating a virtual environment:

```bash
cd packages/pipeline
uv sync
uv run tasks.py
```
Note: The pipeline uses the WELLIES_DATA_DIR environment variable to determine where .arrow.gz files are compiled. If unset, it attempts to drop files directly into apps/web/public/data.

### 📊 Data & Credits
Infrastructure Data: Wellington Water Open Data Portal (WCC, HCC, UHCC, PCC, SWDC, and GWRC).

Basemaps: © OpenStreetMap contributors, styled by CARTO.

### ⚠️ Disclaimer & Data Accuracy
Third-Party Tool: This application is strictly independent. It is not affiliated with or endorsed by Wellington Water Ltd or any regional council.

Educational Use Only: Not suitable for engineering design, property development, or on-site decision-making.

No Liability: By using this app, you acknowledge that the creators are not responsible for any loss or damage arising from reliance on this information.

### 📜 License
This project is licensed under the MIT License - see the LICENSE file for details.

Copyright (c) 2026 @CosmKiwi