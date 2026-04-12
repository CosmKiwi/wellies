export interface Env {
	WELLIES_BUCKET: R2Bucket;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const objectName = url.pathname.slice(1);

		if (!objectName) {
			return new Response('Wellies Proxy Active', { status: 200 });
		}

		let fetchKey = objectName;
		if (objectName.endsWith('.arrow')) {
			fetchKey = objectName + '.br';
		}

		const object = await env.WELLIES_BUCKET.get(fetchKey);

		if (object === null) {
			return new Response(`File Not Found: ${fetchKey}`, { status: 404 });
		}

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('etag', object.httpEtag);

		if (objectName.endsWith('.arrow')) {
			headers.set('Content-Encoding', 'br');
			headers.set('Content-Type', 'application/vnd.apache.arrow.stream');
		}

		const origin = request.headers.get("Origin");
		if (origin && (
			origin === "https://wellies.app" ||
			origin.endsWith("wellies.pages.dev") ||
			origin.startsWith("http://localhost:")
		)) {
			headers.set("Access-Control-Allow-Origin", origin);
		} else {
			headers.set("Access-Control-Allow-Origin", "https://wellies.app");
		}

		headers.set("Vary", "Origin");
		headers.set('Cache-Control', 'public, max-age=31536000, no-transform');

		return new Response(object.body, { headers });
	},
};