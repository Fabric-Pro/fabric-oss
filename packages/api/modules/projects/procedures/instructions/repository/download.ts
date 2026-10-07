import { ORPCError } from "@orpc/client";
import { readRepositoryFileAtCommit } from "@repo/connectors";
import { SNAPSHOT_LIMITS, validateRelativePath } from "@repo/instructions";
import archiver from "archiver";
import { commitShaSchema } from "./commit-sha";
import { listDirectRepositoryFiles } from "./direct-read";
import {
	assertDirectRepositoryPin,
	assertDirectRepositorySourceCurrent,
	directRepositoryPath,
	loadDirectRepositorySource,
} from "./direct-source";

const MAX_DOWNLOADS = 4;
const ZIP_READ_BATCH_SIZE = 4;
let activeDownloads = 0;

/** On-demand export of a pinned, filtered Git tree; nothing is stored in Fabric. */
export async function downloadDirectRepository(input: {
	projectId: string;
	userId: string;
	generation: number;
	commitSha: string;
	path?: string;
	signal: AbortSignal;
}): Promise<Response> {
	if (
		!Number.isSafeInteger(input.generation) ||
		input.generation < 0 ||
		!commitShaSchema.safeParse(input.commitSha).success
	) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Invalid repository version",
		});
	}
	if (activeDownloads >= MAX_DOWNLOADS) {
		throw new ORPCError("TOO_MANY_REQUESTS", {
			message: "Try the download again shortly",
		});
	}
	activeDownloads++;
	let released = false;
	const release = () => {
		if (!released) {
			released = true;
			activeDownloads--;
		}
	};
	try {
		const source = await loadDirectRepositorySource(input);
		const pin = {
			generation: input.generation,
			commitSha: input.commitSha,
		};
		await assertDirectRepositoryPin(source, pin);
		const listed = await listDirectRepositoryFiles({ source, pin });
		if (listed.incomplete || listed.refusal !== null) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"The repository listing is incomplete. Refresh and try again.",
			});
		}
		const readFile = async (path: string, signal = input.signal) => {
			signal.throwIfAborted();
			const read = await readRepositoryFileAtCommit({
				...source.repository,
				sha: pin.commitSha,
				path: directRepositoryPath(source, path),
				maxBytes: SNAPSHOT_LIMITS.maxFileBytes,
				signal,
			});
			if (!read.ok || read.state !== "found") {
				throw new ORPCError("PRECONDITION_FAILED", {
					message: "A repository file could not be downloaded",
				});
			}
			return read.bytes;
		};
		const headers = new Headers({
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		});
		if (input.path !== undefined) {
			const checked = validateRelativePath(input.path);
			if (
				!checked.ok ||
				!listed.files.some((file) => file.path === checked.path)
			) {
				throw new ORPCError("NOT_FOUND", { message: "File not found" });
			}
			const bytes = await readFile(checked.path);
			input.signal.throwIfAborted();
			await assertDirectRepositorySourceCurrent({ ...input, source });
			headers.set("Content-Type", "application/octet-stream");
			headers.set(
				"Content-Disposition",
				`attachment; filename*=UTF-8''${encodeURIComponent(checked.path.split("/").at(-1) ?? "file")}`,
			);
			release();
			return new Response(new Uint8Array(bytes), { headers });
		}
		await assertDirectRepositorySourceCurrent({ ...input, source });
		const archive = archiver("zip", { zlib: { level: 6 } });
		let cancelled = false;
		const pendingReads = new AbortController();
		const signal = AbortSignal.any([input.signal, pendingReads.signal]);
		const abort = () => {
			pendingReads.abort();
			archive.destroy(new Error("Download cancelled"));
		};
		input.signal.addEventListener("abort", abort, { once: true });
		const finish = () => {
			input.signal.removeEventListener("abort", abort);
			release();
		};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				archive.on("data", (chunk: Buffer) => {
					controller.enqueue(new Uint8Array(chunk));
					if ((controller.desiredSize ?? 0) <= 0) archive.pause();
				});
				archive.once("end", () => {
					if (!cancelled) controller.close();
					finish();
				});
				archive.once("error", () => {
					if (!cancelled)
						controller.error(
							new Error("Repository download failed"),
						);
					finish();
				});
				const produce = async () => {
					for (
						let offset = 0;
						offset < listed.files.length;
						offset += ZIP_READ_BATCH_SIZE
					) {
						const batch = await Promise.all(
							listed.files
								.slice(offset, offset + ZIP_READ_BATCH_SIZE)
								.map(async (file) => ({
									file,
									bytes: await readFile(file.path, signal),
								})),
						);
						for (const { file, bytes } of batch) {
							signal.throwIfAborted();
							await assertDirectRepositorySourceCurrent({
								...input,
								source,
							});
							signal.throwIfAborted();
							const consumed = new Promise<void>(
								(resolve, reject) => {
									const failed = (error: Error) => {
										archive.off("entry", written);
										reject(error);
									};
									const written = () => {
										archive.off("error", failed);
										resolve();
									};
									archive.once("error", failed);
									archive.once("entry", written);
								},
							);
							archive.append(Buffer.from(bytes), {
								name: file.path,
								mode:
									file.mode === undefined
										? undefined
										: Number.parseInt(file.mode, 8),
								date: new Date("1980-01-01T00:00:00Z"),
							});
							await consumed;
						}
					}
					await archive.finalize();
				};
				void produce().catch((error) => {
					pendingReads.abort();
					archive.destroy(
						error instanceof Error
							? error
							: new Error("Repository download failed"),
					);
				});
			},
			pull() {
				archive.resume();
			},
			cancel() {
				cancelled = true;
				abort();
				finish();
			},
		});
		headers.set("Content-Type", "application/zip");
		headers.set(
			"Content-Disposition",
			`attachment; filename="instructions-${pin.commitSha.slice(0, 7)}.zip"`,
		);
		return new Response(body, { headers });
	} catch (error) {
		release();
		throw error;
	}
}
