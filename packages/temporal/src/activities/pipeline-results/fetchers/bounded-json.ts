/**
 * Read a provider's JSON response with a byte ceiling.
 *
 * Every client here already bounds TIME (`AbortSignal.timeout`), and the GitHub
 * artifact download already bounds BYTES. The plain JSON reads did neither:
 * `await res.json()` buffers whatever arrives, and a fast response can deliver
 * hundreds of megabytes inside a 30-second window.
 *
 * That matters because the payload is attacker-influenceable. Anyone who can
 * push a branch or open a PR on a connected repository controls how many
 * automated test results a run publishes and how large each `errorMessage` /
 * `stackTrace` is — and the ADO run-results and GitLab test-report endpoints are
 * fetched without a page-size bound. A single oversized response would be read
 * fully into the worker's memory before any row is written, taking down every
 * other activity sharing that worker.
 *
 * `Content-Length` is used only as a fast rejection. The real enforcement is the
 * running total while streaming, so a missing, chunked or lying header is still
 * caught.
 */

/**
 * Ceiling for one provider JSON response. Generous — a large test run legitimately
 * returns megabytes — but finite. A provider that needs more than this should be
 * paged (ADO `$top`/`$skip`, GitLab keyset) rather than read in one call.
 */
export const MAX_JSON_BYTES = 32 * 1024 * 1024;

export async function readBoundedJson<T>(
	response: Response,
	label: string,
	maxBytes: number = MAX_JSON_BYTES,
): Promise<T> {
	const declared = response.headers.get("content-length");
	if (declared !== null && Number(declared) > maxBytes) {
		throw new Error(
			`${label} response exceeds the ${maxBytes}-byte response limit`,
		);
	}
	if (!response.body) {
		return JSON.parse(await response.text()) as T;
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error(
					`${label} response exceeds the ${maxBytes}-byte response limit`,
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
