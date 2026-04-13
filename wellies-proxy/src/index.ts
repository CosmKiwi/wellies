export interface Env {
	WELLIES_BUCKET: R2Bucket;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const objectName = url.pathname.slice(1);

		if (!objectName) return new Response('Wellies Proxy Active', { status: 200 });
		if (objectName.includes('..') || objectName.includes('/.') || objectName.startsWith('.')) {
			return new Response('Forbidden', { status: 403 });
		}

		const object = await env.WELLIES_BUCKET.get(objectName);
		if (object === null) return new Response('File Not Found', { status: 404 });

		const headers = new Headers();
		object.writeHttpMetadata(headers);

		const origin = request.headers.get("Origin");
		if (origin) {
			if (
				origin === "https://wellies.app" ||
				origin.endsWith(".wellies.pages.dev") ||
				origin === "https://wellies.pages.dev" ||
				origin.startsWith("http://localhost:")
			) {
				headers.set("Access-Control-Allow-Origin", origin);
			} else {
				return new Response('Forbidden', { status: 403 });
			}
		}

		headers.set("Vary", "Origin");
		headers.set('Cache-Control', 'public, max-age=31536000');

		return new Response(object.body, { headers });
	},
};