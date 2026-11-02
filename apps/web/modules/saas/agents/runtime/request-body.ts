export const MAX_AGENT_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

function payloadTooLarge(): Response {
	return Response.json(
		{
			error: "Payload too large",
			message: "Agent requests are limited to 8 MiB.",
		},
		{ status: 413 },
	);
}

/** Bound transport bytes before either SDK entry point clones or parses JSON. */
export async function withBoundedAgentRequestBody(
	request: Request,
): Promise<Request | Response> {
	if (request.method === "GET" || request.method === "HEAD") {
		return request;
	}
	const declaredLength = Number(request.headers.get("content-length"));
	if (
		Number.isFinite(declaredLength) &&
		declaredLength > MAX_AGENT_REQUEST_BODY_BYTES
	) {
		await request.body?.cancel().catch(() => undefined);
		return payloadTooLarge();
	}
	if (!request.body) {
		return request;
	}
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			size += value.byteLength;
			if (size > MAX_AGENT_REQUEST_BODY_BYTES) {
				await reader.cancel().catch(() => undefined);
				return payloadTooLarge();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const headers = new Headers(request.headers);
	headers.set("content-length", String(size));
	// Next proxies the incoming request; native private fields cannot read through it.
	return new Request(request.url, {
		method: request.method,
		headers,
		body,
		signal: request.signal,
		cache: request.cache,
		credentials: request.credentials,
		mode: request.mode,
		redirect: request.redirect,
		referrer: request.referrer,
		referrerPolicy: request.referrerPolicy,
		integrity: request.integrity,
		keepalive: request.keepalive,
	});
}
