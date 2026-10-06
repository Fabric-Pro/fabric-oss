import { PassThrough, type Readable, Transform } from "node:stream";
import { getObjectStream, putObjectStream } from "@repo/storage";
import archiver from "archiver";
import { SNAPSHOT_LIMITS } from "../limits";

const DOWNLOAD_CONCURRENCY = 16;

export interface FileForZip {
	path: string;
	storageKey: string;
	mode: number | null;
	size?: number;
}

/** Stream an ordered archive with a bounded window of paused object streams. */
export async function streamInstructionZip(input: {
	key: string;
	bucket: string;
	date: Date;
	files: readonly FileForZip[];
}): Promise<void> {
	const archive = archiver("zip", { zlib: { level: 6 } });
	const output = new PassThrough();
	const sources = new Set<Readable>();
	let failed = false;
	let firstError: unknown;
	const fail = (error: unknown) => {
		if (failed) {
			return;
		}
		failed = true;
		firstError = error;
		const streamError =
			error instanceof Error ? error : new Error("Archive export failed");
		archive.destroy(streamError);
		output.destroy(streamError);
		for (const source of sources) {
			source.destroy();
		}
	};
	archive.on("error", fail);
	output.on("error", fail);
	archive.pipe(output);
	const uploaded = putObjectStream(input.key, output, {
		bucket: input.bucket,
		contentType: "application/zip",
	}).then(
		() => true,
		(error: unknown) => {
			fail(error);
			return false;
		},
	);

	const pending = new Map<number, Promise<Readable | null>>();
	const prefetch = (index: number) => {
		const file = input.files[index];
		if (!file || failed) {
			return;
		}
		pending.set(
			index,
			getObjectStream(file.storageKey, { bucket: input.bucket }).then(
				(source) => {
					source.on("error", fail);
					if (failed) {
						source.destroy();
						return null;
					}
					sources.add(source);
					source.once("end", () => sources.delete(source));
					return source;
				},
				(error: unknown) => {
					fail(error);
					return null;
				},
			),
		);
	};
	for (
		let i = 0;
		i < Math.min(DOWNLOAD_CONCURRENCY, input.files.length);
		i++
	) {
		prefetch(i);
	}

	try {
		for (const [index, file] of input.files.entries()) {
			const source = await pending.get(index);
			if (failed) {
				throw firstError;
			}
			if (!source) {
				throw new Error("Archive source is missing");
			}
			let size = 0;
			const bounded = new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					size += chunk.length;
					if (
						size > SNAPSHOT_LIMITS.maxFileBytes ||
						(file.size !== undefined && size > file.size)
					) {
						callback(
							new Error(
								"Archive source exceeds its approved size",
							),
						);
					} else {
						callback(null, chunk);
					}
				},
				flush(callback) {
					callback(
						file.size !== undefined && size !== file.size
							? new Error(
									"Archive source does not match its approved size",
								)
							: undefined,
					);
				},
			});
			bounded.on("error", fail);
			const consumed = new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => {
					archive.off("entry", onEntry);
					reject(error);
				};
				const onEntry = () => {
					archive.off("error", onError);
					resolve();
				};
				archive.once("error", onError);
				archive.once("entry", onEntry);
			});
			archive.append(source.pipe(bounded), {
				name: file.path,
				mode: file.mode ?? undefined,
				date: input.date,
			});
			await consumed;
			pending.delete(index);
			prefetch(index + DOWNLOAD_CONCURRENCY);
		}
		if (failed) {
			throw firstError;
		}
		await archive.finalize();
		await uploaded;
		if (failed) {
			throw firstError;
		}
	} catch (error) {
		fail(error);
		await uploaded;
		throw firstError;
	} finally {
		await Promise.all(pending.values());
		for (const source of sources) {
			source.destroy();
		}
	}
}
