/**
 * Fetching and unpacking the published bundle.
 *
 * The archive is held in memory and never written to disk as an archive. A
 * temp zip on disk would be one more thing to clean up after an interrupted
 * run — but "in memory" only works while the size is bounded by something the
 * CLIENT decided, which is what `maxBytes` is. The response body is read in
 * chunks and abandoned the moment it exceeds that; `arrayBuffer()` buffered
 * whatever the server sent before anything could look at it, so a malformed
 * or hostile response sized the allocation itself.
 *
 * Only the paths the plan asked for are extracted, and the manifest's own
 * sizes bound the decompression. The filter is the only place that runs
 * before `fflate` allocates, so per-entry and aggregate limits belong there
 * rather than after the fact: the sha256 check in `apply.ts` catches
 * substituted CONTENT, but it runs on bytes that have already been
 * decompressed into memory.
 */
import { unzipSync } from "fflate";

export interface FetchBundleOptions {
	/** Per-attempt budget when no shared signal is supplied. */
	timeoutMs: number;
	/**
	 * The most compressed bytes worth reading, from `maxArchiveBytes`. A
	 * declared `Content-Length` above it is refused before the body is read;
	 * a body that grows past it is abandoned mid-stream.
	 */
	maxBytes: number;
	/**
	 * A deadline owned by the caller. In hook mode one signal covers the
	 * manifest call and this download together, so the whole command has a
	 * single absolute bound rather than one per request.
	 */
	signal?: AbortSignal;
	/** Injectable for tests; defaults to the global fetch. */
	fetchImpl?: typeof fetch;
}

export async function fetchBundle(
	url: string,
	options: FetchBundleOptions,
): Promise<Uint8Array> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	const onExternalAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onExternalAbort, { once: true });
	if (options.signal?.aborted) {
		controller.abort();
	}
	try {
		const response = await fetchImpl(url, { signal: controller.signal });
		if (!response.ok) {
			throw new Error(
				`Downloading the coding-instructions bundle failed with HTTP ${response.status}.`,
			);
		}

		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > options.maxBytes) {
			throw new Error(
				`The coding-instructions bundle declares ${declared} bytes and this snapshot's manifest allows at most ${options.maxBytes}. Nothing was written.`,
			);
		}

		return await readBounded(response, options.maxBytes);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(
				`Downloading the coding-instructions bundle timed out after ${options.timeoutMs}ms.`,
			);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onExternalAbort);
	}
}

/**
 * Read a response body, refusing it the moment it passes `maxBytes`.
 *
 * The cap is compared against bytes ALREADY RECEIVED, so the refusal costs at
 * most one chunk beyond it rather than the whole body. A response with no
 * readable stream — an older polyfill, a test double built from a string —
 * falls back to `arrayBuffer()` and is length-checked after the fact, which
 * is the best available answer when the body cannot be consumed in pieces.
 */
async function readBounded(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array> {
	const body = response.body;
	if (!body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length > maxBytes) {
			throw new Error(
				`The coding-instructions bundle is larger than the ${maxBytes} bytes this snapshot's manifest allows. Nothing was written.`,
			);
		}
		return bytes;
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (!value) {
				continue;
			}
			total += value.length;
			if (total > maxBytes) {
				throw new Error(
					`The coding-instructions bundle is larger than the ${maxBytes} bytes this snapshot's manifest allows. Nothing was written.`,
				);
			}
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}

	const archive = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		archive.set(chunk, offset);
		offset += chunk.length;
	}
	return archive;
}

export interface WantedEntry {
	path: string;
	/** The manifest's size for this path, in bytes. */
	size: number;
}

/**
 * Extract exactly the wanted paths, within exactly the wanted sizes.
 *
 * A zip entry name is matched literally against the manifest path. Nothing
 * here normalises, joins or resolves anything — a name that does not appear
 * in `wanted` is simply not returned, so an archive carrying `../../etc/x`
 * cannot reach the filesystem even before the path guard sees it.
 *
 * Three bounds, all enforced inside the filter so a hostile archive is
 * refused before it is decompressed:
 *
 *   - a name the manifest does not list is skipped;
 *   - an entry whose declared original size is not the manifest's size for
 *     that path is refused (a zip bomb declaring 4 GB for a 200-byte file
 *     never gets allocated);
 *   - a second entry with a wanted name is refused rather than allowed to
 *     win, which is what "last one wins" would otherwise let it do.
 */
export function extractBundle(
	archive: Uint8Array,
	wanted: Iterable<WantedEntry>,
): Map<string, Uint8Array> {
	const sizes = new Map<string, number>();
	for (const entry of wanted) {
		sizes.set(entry.path, entry.size);
	}
	if (sizes.size === 0) {
		return new Map();
	}

	const seen = new Set<string>();
	const unzipped = unzipSync(archive, {
		filter: (file) => {
			const expected = sizes.get(file.name);
			if (expected === undefined) {
				return false;
			}
			if (seen.has(file.name)) {
				throw new Error(
					`The downloaded bundle contains ${file.name} more than once. Nothing was written.`,
				);
			}
			seen.add(file.name);
			if (
				file.originalSize !== undefined &&
				file.originalSize !== expected
			) {
				throw new Error(
					`The downloaded bundle declares ${file.originalSize} bytes for ${file.name} and the manifest says ${expected}. Nothing was written.`,
				);
			}
			return true;
		},
	});

	const contents = new Map<string, Uint8Array>();
	for (const [name, bytes] of Object.entries(unzipped)) {
		const expected = sizes.get(name);
		if (expected === undefined) {
			continue;
		}
		// The declared size is a claim; this is the measurement.
		if (bytes.length !== expected) {
			throw new Error(
				`The downloaded bundle holds ${bytes.length} bytes for ${name} and the manifest says ${expected}. Nothing was written.`,
			);
		}
		contents.set(name, bytes);
	}
	return contents;
}
