/**
 * The shape of a Living Memory write request (ADR-022), shared by every door
 * that submits one: the app's procedures, the v1 REST routes and the MCP tool.
 * Shape and bounds only; the rules a request must satisfy are
 * `evaluateMemoryWrite`'s, applied at admission.
 */
import {
	MAX_MEMORY_WRITE_ENTRIES,
	MAX_MEMORY_WRITE_MESSAGE_LENGTH,
} from "@repo/temporal/memory-write/evaluate";
import { MAX_STAGED_FILE_BYTES } from "@repo/temporal/memory-write/staging";
import { z } from "zod";
import { MAX_CONTEXT_SYNC_PATH_LENGTH } from "../../procedures/contexts/repository-sync/paths";
import { MAX_INLINE_BYTES_PER_REQUEST } from "./admit-memory-write";

/** The fields of `submit`, apart from the project, which each door names its own way. */
export const memoryWriteSubmitFields = {
	targetId: z.string().min(1).max(128),
	message: z.string().min(1).max(MAX_MEMORY_WRITE_MESSAGE_LENGTH),
	entries: z
		.array(
			z.object({
				path: z.string().max(MAX_CONTEXT_SYNC_PATH_LENGTH),
				op: z.enum(["PUT", "DELETE"]),
				ifMatchOid: z.string().max(128).optional(),
				content: z
					.string()
					.max(MAX_INLINE_BYTES_PER_REQUEST)
					.optional(),
				stagedKey: z.string().max(512).optional(),
				bytes: z
					.number()
					.int()
					.min(1)
					.max(MAX_STAGED_FILE_BYTES)
					.optional(),
				sha256: z.string().max(64).optional(),
			}),
		)
		.min(1)
		.max(MAX_MEMORY_WRITE_ENTRIES),
};

/** The files of `createUploadUrls`: one signed PUT per file, for its declared size. */
export const memoryWriteUploadFilesField = z
	.array(
		z.object({
			/** The size of the file, in bytes: signed into its URL. */
			bytes: z.number().int().min(1).max(MAX_STAGED_FILE_BYTES),
		}),
	)
	.min(1)
	.max(MAX_MEMORY_WRITE_ENTRIES);
