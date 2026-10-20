import { ORPCError } from "@orpc/client";
import { repositoryFilesReadSchema } from "./direct-batch-schema";
import { withDirectRead } from "./direct-query";
import {
	listDirectRepositoryFiles,
	readDirectRepositoryFile,
} from "./direct-read";
import { resolveDirectRepositoryIgnore } from "./direct-source";

const MAX_DECODED_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const LAUNCH_DEADLINE_MS = 10_000;
const OPERATION_DEADLINE_MS = 20_000;

/** Bounded, file-boundary pages of a filtered, pinned repository tree. */
export async function readDirectRepositoryFilesForApi(input: {
	projectId: string;
	userId: string;
	generation: number;
	commitSha: string;
	paths: string[];
	startIndex?: number;
	signal?: AbortSignal;
}) {
	const parsed = repositoryFilesReadSchema.safeParse(input);
	if (!parsed.success) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Invalid repository batch",
		});
	}
	const { paths, startIndex } = parsed.data;
	const started = Date.now();
	const deadline = AbortSignal.timeout(OPERATION_DEADLINE_MS);
	const signal = input.signal
		? AbortSignal.any([input.signal, deadline])
		: deadline;
	signal.throwIfAborted();
	const { pin, value } = await withDirectRead(
		{ ...input, signal },
		async (context) => {
			const listing = await listDirectRepositoryFiles(context);
			signal.throwIfAborted();
			if (listing.incomplete || listing.refusal !== null) {
				throw new ORPCError("PRECONDITION_FAILED", {
					message: "Repository listing is incomplete",
				});
			}
			const allowed = new Set(listing.files.map((file) => file.path));
			if (paths.some((path) => !allowed.has(path))) {
				throw new ORPCError("NOT_FOUND", { message: "File not found" });
			}
			const ignore = await resolveDirectRepositoryIgnore(
				context.source,
				context.pin,
			);
			const files: Array<{
				path: string;
				read: Awaited<ReturnType<typeof readDirectRepositoryFile>>;
			}> = [];
			let decodedBytes = 0;
			let jsonBytes = 0;
			let nextIndex = startIndex;
			while (nextIndex < paths.length) {
				signal.throwIfAborted();
				if (
					files.length > 0 &&
					Date.now() - started >= LAUNCH_DEADLINE_MS
				) {
					break;
				}
				const settled = await Promise.allSettled(
					paths.slice(nextIndex, nextIndex + 4).map(async (path) => ({
						path,
						read: await readDirectRepositoryFile({
							...context,
							path,
							ignore,
						}),
					})),
				);
				signal.throwIfAborted();
				for (const result of settled) {
					if (result.status === "rejected") {
						throw result.reason;
					}
				}
				for (const result of settled) {
					if (result.status !== "fulfilled") {
						continue;
					}
					const file = result.value;
					const decoded =
						file.read.state === "found" ? file.read.size : 0;
					const encoded = Buffer.byteLength(JSON.stringify(file));
					// Leave room for the envelope, immutable pin and continuation.
					if (
						decodedBytes + decoded > MAX_DECODED_BYTES ||
						jsonBytes + encoded > MAX_JSON_BYTES - 1024
					) {
						if (files.length === 0) {
							throw new ORPCError("PRECONDITION_FAILED", {
								message:
									"Repository file cannot fit in a batch",
							});
						}
						return { files, nextIndex };
					}
					files.push(file);
					decodedBytes += decoded;
					jsonBytes += encoded + 1;
					nextIndex++;
				}
			}
			return {
				files,
				nextIndex: nextIndex === paths.length ? null : nextIndex,
			};
		},
		{ verifyBeforeRead: true },
	);
	signal.throwIfAborted();
	return { ...pin, ...value };
}
