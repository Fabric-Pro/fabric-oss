/**
 * Fetching only the files a sync writes.
 *
 * The archive route hands back ONE zip of the whole published tree, so a sync
 * that rewrites a single file of a thousand still downloaded all thousand.
 * `published/files` signs a URL per NAMED file instead, and this downloads
 * those, a few at a time.
 *
 * The trust rule is the archive's, unchanged: nothing the server says about a
 * file is believed. The bytes are checked against the MANIFEST entry the plan
 * was made from — its size bounds the read, and its sha256 must match what
 * arrived — so a substituted or truncated object refuses the whole fetch
 * before anything is written.
 */
import { createHash } from "node:crypto";
import { FabricError, type FabricClient } from "@fabricorg/sdk";
import { fetchBundle } from "./bundle.js";

/** More writes than this are cheaper as one archive than as many requests. */
export const PER_FILE_MAX_WRITES = 100;

/** The most paths one URL request names; the server's own limit. */
const URL_REQUEST_CHUNK = 200;

/** Downloads in flight at once. */
const DOWNLOAD_CONCURRENCY = 8;

/** The published version moved after the plan was made. */
export class PublishedChangedError extends Error {
	constructor() {
		super("The published version changed while this command ran.");
		this.name = "PublishedChangedError";
	}
}

interface WantedFile {
	path: string;
	size: number;
	sha256: string;
}

export interface FetchFilesOptions {
	client: FabricClient;
	projectId: string;
	org?: string;
	/** The digest the plan was made from. */
	digest: string;
	files: readonly WantedFile[];
	timeoutMs: number;
	signal?: AbortSignal;
	/** Injectable for tests; defaults to the global fetch. */
	fetchImpl?: typeof fetch;
}

export async function fetchFilesByUrl(
	options: FetchFilesOptions,
): Promise<Map<string, Uint8Array>> {
	const wanted = new Map(options.files.map((file) => [file.path, file]));
	const urls = new Map<string, string>();
	for (let i = 0; i < options.files.length; i += URL_REQUEST_CHUNK) {
		const paths = options.files
			.slice(i, i + URL_REQUEST_CHUNK)
			.map((file) => file.path);
		let response: Awaited<
			ReturnType<FabricClient["instructions"]["createFileDownloadUrls"]>
		>;
		try {
			response = await options.client.instructions.createFileDownloadUrls(
				options.projectId,
				{ digest: options.digest, paths },
				{ org: options.org },
			);
		} catch (error) {
			if (
				error instanceof FabricError &&
				error.status === 409 &&
				error.code === "PUBLISHED_CHANGED"
			) {
				throw new PublishedChangedError();
			}
			throw error;
		}
		if (response.digest !== options.digest) {
			throw new PublishedChangedError();
		}
		for (const file of response.files) {
			if (!wanted.has(file.path) || urls.has(file.path)) {
				throw new Error(
					"The server returned a file that was not asked for. Nothing was written.",
				);
			}
			urls.set(file.path, file.url);
		}
	}
	if (urls.size !== wanted.size) {
		throw new Error(
			`The server returned ${urls.size} of ${wanted.size} requested files. Nothing was written.`,
		);
	}

	const contents = new Map<string, Uint8Array>();
	const queue = options.files.values();
	const failures: unknown[] = [];
	const worker = async (): Promise<void> => {
		while (failures.length === 0) {
			const next = queue.next();
			if (next.done) {
				return;
			}
			const file = next.value;
			try {
				const bytes = await fetchBundle(urls.get(file.path) ?? "", {
					timeoutMs: options.timeoutMs,
					// The manifest's size, not the response's: the read is
					// abandoned the moment it passes what the plan expects.
					maxBytes: file.size,
					signal: options.signal,
					fetchImpl: options.fetchImpl,
				});
				if (
					bytes.length !== file.size ||
					createHash("sha256").update(bytes).digest("hex") !==
						file.sha256
				) {
					throw new Error(
						`A downloaded file does not match the manifest (${file.path}). Nothing was written.`,
					);
				}
				contents.set(file.path, bytes);
			} catch (error) {
				failures.push(error);
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(DOWNLOAD_CONCURRENCY, options.files.length) },
			() => worker(),
		),
	);
	if (failures.length > 0) {
		throw failures[0];
	}
	return contents;
}
