// $lib/db.ts
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import MvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?worker';

// Cache both the database instance and the connection
let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;

export async function getDB() {
	// If we already have an active connection, return the cached pair
	if (db && conn) return { db, conn };

	console.log('🦆 DuckDB: Initializing engine...');

	// 1. Initialize the worker and logger
	const worker = new MvpWorker();
	const logger = new duckdb.ConsoleLogger();

	// 2. Create and instantiate the DB instance
	db = new duckdb.AsyncDuckDB(logger, worker);
	await db.instantiate(duckdb_wasm);

	// 3. Create the connection
	conn = await db.connect();

	// 4. Pre-load spatial for all future queries
	// Note: We run this on the connection
	await conn.query(`INSTALL spatial; LOAD spatial;`);

	return { db, conn };
}
