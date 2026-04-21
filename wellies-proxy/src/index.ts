export interface Env {
	WELLIES_BUCKET: R2Bucket;
}

// 🚀 Helper to safely attach CORS to ANY response
function attachCors(headers: Headers, request: Request) {
	const origin = request.headers.get("Origin");
	if (origin && (
		origin === "https://wellies.app" ||
		origin.endsWith(".wellies.pages.dev") ||
		origin === "https://wellies.pages.dev" ||
		origin.startsWith("http://localhost:")
	)) {
		headers.set("Access-Control-Allow-Origin", origin);
		headers.set("Vary", "Origin");
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.protocol === 'http:' && url.hostname !== 'localhost') {
			url.protocol = 'https:';
			return Response.redirect(url.toString(), 301);
		}

		if (request.method === 'OPTIONS') {
			const headers = new Headers();
			attachCors(headers, request);
			headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
			headers.set("Access-Control-Allow-Headers", "Content-Type");
			headers.set("Access-Control-Max-Age", "86400");
			return new Response(null, { headers, status: 204 });
		}

		const objectName = url.pathname.slice(1);

		if (!objectName) {
			const headers = new Headers();
			attachCors(headers, request);
			return new Response('Wellies Proxy Active', { status: 200, headers });
		}

		if (objectName.includes('..') || objectName.includes('/.') || objectName.startsWith('.')) {
			const headers = new Headers();
			attachCors(headers, request);
			return new Response('Forbidden', { status: 403, headers });
		}

		const object = await env.WELLIES_BUCKET.get(objectName);

		// 🚨 THE FIX: Attach CORS to the 404 response!
		if (object === null) {
			const headers = new Headers();
			attachCors(headers, request);
			return new Response('File Not Found', { status: 404, headers });
		}

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		attachCors(headers, request);

		if (objectName === 'manifest.json') {
			headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
		} else {
			headers.set('Cache-Control', 'public, max-age=31536000, immutable');
		}

		headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
		headers.set('X-Content-Type-Options', 'nosniff');

		return new Response(object.body, { headers });
	},
};