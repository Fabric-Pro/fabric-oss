import { createHash } from "node:crypto";

export type CappedRepositoryBody =
	| { complete: true; bytes: Uint8Array }
	| { complete: false; head: Uint8Array };

/** Read decoded bytes up to the cap, cancelling the stream when it exceeds it. */
export async function readCappedRepositoryBody(
	response: Response,
	maxBytes: number,
	options: { refuseDeclaredLength: boolean },
): Promise<CappedRepositoryBody> {
	const declared =
		!options.refuseDeclaredLength ||
		response.headers.get("content-encoding")
			? Number.NaN
			: Number(response.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => {});
		return { complete: false, head: new Uint8Array(0) };
	}
	if (!response.body) {
		const whole = new Uint8Array(await response.arrayBuffer());
		return whole.byteLength > maxBytes
			? { complete: false, head: whole.subarray(0, maxBytes) }
			: { complete: true, bytes: whole };
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			return { complete: false, head: chunks[0] ?? value };
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { complete: true, bytes };
}

/** Compute a Git blob identity using the algorithm of the provider's object ID. */
export function repositoryBlobId(
	bytes: Uint8Array,
	objectId: string,
): string | null {
	const algorithm = /^[0-9a-f]{40}$/i.test(objectId)
		? "sha1"
		: /^[0-9a-f]{64}$/i.test(objectId)
			? "sha256"
			: null;
	if (!algorithm) {
		return null;
	}
	return createHash(algorithm)
		.update(`blob ${bytes.byteLength}\0`)
		.update(bytes)
		.digest("hex");
}
