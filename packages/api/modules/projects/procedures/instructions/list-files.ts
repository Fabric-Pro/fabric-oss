import { ORPCError } from "@orpc/client";
import { getInstructionSnapshot, listInstructionFiles } from "@repo/database";
import {
	INSTRUCTION_FILE_KINDS,
	type InstructionFileKind,
} from "@repo/instructions";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import {
	assertInstructionSnapshotMutationAccess,
	isInstructionSnapshotContentReadable,
} from "./proposal-authorization";

const RECEIVING_STATUSES = new Set(["RECEIVING", "VALIDATING"]);

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_READ).
 *
 * Lists the files of one snapshot, tenant-scoped via a preceding
 * `getInstructionSnapshot(id, projectId, organizationId)` (R11) before the
 * snapshot-id-keyed `listInstructionFiles` runs. `storageKey` and `sha256`
 * are stripped from every row: the response never carries a storage
 * location.
 *
 * `includeReceiving` exists for Task 13's upload client, which needs to
 * resolve file ids for a snapshot that has not finished validating yet.
 * With it `false` (the default), only a READY snapshot's full file rows are
 * ever served — a RECEIVING/VALIDATING/REJECTED/FAILED snapshot 404s the
 * same as a missing one. With it `true`, RECEIVING/VALIDATING snapshots are
 * additionally servable only after the ownership-aware mutation check: the
 * proposal author needs live READ access, while a direct upload still needs
 * CREATE. Those responses are reduced to `{ id, path }`, since their files
 * may still be mid-upload and their metadata is not yet final.
 */
export const listFilesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/snapshots/:snapshotId/files",
		tags: ["Projects", "Instructions"],
		summary: "List a snapshot's files",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			snapshotId: z.string(),
			kind: z
				.enum(INSTRUCTION_FILE_KINDS as [string, ...string[]])
				.optional(),
			query: z.string().max(256).optional(),
			includeReceiving: z.boolean().default(false),
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
		if (!snapshot) {
			throw new ORPCError("NOT_FOUND", { message: "Snapshot not found" });
		}
		const isReady = isInstructionSnapshotContentReadable(snapshot);
		const isReceiving = RECEIVING_STATUSES.has(snapshot.status);
		if (!isReady && !(input.includeReceiving && isReceiving)) {
			throw new ORPCError("NOT_FOUND", { message: "Snapshot not found" });
		}
		if (!isReady) {
			// In-flight paths are upload coordination data. The pending proposal
			// owner may see their own rows with live READ access; direct snapshots
			// remain limited to callers with CREATE permission.
			await assertInstructionSnapshotMutationAccess({
				projectId: input.projectId,
				userId: context.user.id,
				snapshot,
			});
		}

		const files = await listInstructionFiles(snapshot.id, organizationId, {
			kind: input.kind as InstructionFileKind | undefined,
			query: input.query,
		});

		if (!isReady) {
			// RECEIVING/VALIDATING: ids and paths only — metadata is not final.
			return files.map((f) => ({ id: f.id, path: f.path }));
		}
		return files.map((f) => ({
			id: f.id,
			path: f.path,
			kind: f.kind,
			name: f.name,
			description: f.description,
			size: f.size,
			mimeType: f.mimeType,
			isText: f.isText,
			mode: f.mode,
		}));
	});
