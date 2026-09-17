import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import {
	getInstructionFileByPath,
	getInstructionSnapshot,
} from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";

const BUCKET = config.storage.bucketNames.skills;
const FILE_BODY_DEFAULT_MAX = 50_000;
const FILE_BODY_MAX = 200_000;

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_READ).
 *
 * Reads one file's body (paged, text only) or a short-lived signed URL
 * (binaries). Bytes are only ever served from a READY snapshot (R11):
 * `getInstructionSnapshot(id, projectId, organizationId)` is the scoped
 * lookup this handler runs before touching `getInstructionFileByPath`, and a
 * staging/validating/rejected/failed snapshot 404s exactly like a missing
 * one — never a partial or invalid body. `storageKey` is read from the file
 * row to fetch bytes but never appears on the response.
 */
export const getFileProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/snapshots/:snapshotId/file",
		tags: ["Projects", "Instructions"],
		summary: "Read one file of a snapshot",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			snapshotId: z.string(),
			path: z.string().max(4096),
			offset: z.number().int().min(0).default(0),
			maxLength: z
				.number()
				.int()
				.min(1)
				.max(FILE_BODY_MAX)
				.default(FILE_BODY_DEFAULT_MAX),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const snapshot = await getInstructionSnapshot(
			input.snapshotId,
			input.projectId,
			organizationId,
		);
		// Only READY snapshots ever serve bytes: staging is never readable.
		if (!snapshot || snapshot.status !== "READY") {
			throw new ORPCError("NOT_FOUND", { message: "File not found" });
		}
		const file = await getInstructionFileByPath(
			snapshot.id,
			organizationId,
			input.path,
		);
		if (!file) {
			throw new ORPCError("NOT_FOUND", { message: "File not found" });
		}

		const storage = getStorageProvider();
		const base = {
			path: file.path,
			kind: file.kind,
			name: file.name,
			description: file.description,
			size: file.size,
			mimeType: file.mimeType,
			isText: file.isText,
			mode: file.mode,
		};
		if (!file.isText) {
			const url = await storage.getSignedUrl(file.storageKey, {
				bucket: BUCKET,
				expiresIn: 300,
			});
			return {
				...base,
				body: null,
				offset: 0,
				nextOffset: null,
				truncated: false,
				url,
			};
		}
		const { data } = await storage.downloadFile(file.storageKey, {
			bucket: BUCKET,
		});
		const text = data.toString("utf8");
		const chars = Array.from(text);
		const slice = chars
			.slice(input.offset, input.offset + input.maxLength)
			.join("");
		const end = input.offset + input.maxLength;
		const truncated = end < chars.length;
		return {
			...base,
			body: slice,
			offset: input.offset,
			nextOffset: truncated ? end : null,
			truncated,
			url: null,
		};
	});
