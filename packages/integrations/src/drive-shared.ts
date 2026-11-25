/**
 * Small pieces the OneDrive, SharePoint and Google Drive folder reads share.
 */

/** How many items one level of a folder picker lists before it is cut short. */
export const DOCUMENT_FOLDER_BROWSE_MAX_ITEMS = 1000;

/**
 * The drive's own wait after a refused request, in seconds, from its
 * `Retry-After` header; null when it sends none, or a date rather than a
 * number of seconds.
 */
export function retryAfterSeconds(response: Response): number | null {
	const header = response.headers.get("Retry-After");
	const seconds = header === null ? Number.NaN : Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

type CappedRead =
	| { ok: true; bytes: Buffer; size: number }
	| { ok: false; size: number };

/**
 * A body read while counting, stopped once it passes `maxBytes`: the size a
 * drive reports up front is not a promise. A missing body reads as empty.
 */
export async function readCapped(
	response: Response,
	maxBytes: number,
): Promise<CappedRead> {
	if (!response.body) {
		return { ok: true, bytes: Buffer.alloc(0), size: 0 };
	}
	const chunks: Uint8Array[] = [];
	let received = 0;
	const reader = response.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		received += value.byteLength;
		if (received > maxBytes) {
			await reader.cancel();
			return { ok: false, size: received };
		}
		chunks.push(value);
	}
	return { ok: true, bytes: Buffer.concat(chunks), size: received };
}
