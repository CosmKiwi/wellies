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

		const object = await env.WELLIES_BUCKET.get(objectName);

		if (object === null) {
			return new Response('File Not Found', { status: 404 });
		}

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('etag', object.httpEtag);
		if (objectName.endsWith('.arrow.br')) {
			headers.set('Content-Encoding', 'br');
			headers.set('Content-Type', 'application/vnd.apache.arrow.stream');
		}
		headers.set("Access-Control-Allow-Origin", "https://wellies.app");
		headers.set("Vary", "Origin");
		headers.set('Cache-Control', 'public, max-age=31536000');

		return new Response(object.body, {
			headers,
		});
	},
};