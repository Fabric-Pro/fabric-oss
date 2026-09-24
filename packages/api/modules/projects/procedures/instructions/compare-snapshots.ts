import { ORPCError } from "@orpc/client";
import {
	diffInstructionManifests,
	getInstructionSnapshot,
	listInstructionFiles,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { isInstructionSnapshotContentReadable } from "./proposal-authorization";

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_READ).
 *
 * What changed between two of a project's coding-instruction versions, as a
 * PATH manifest only — no bytes are read and no storage location is served.
 * Bodies stay behind `getFile`, which the client calls per expanded row, so
 * this route costs two file-list queries however large the versions are.
 *
 * Both snapshots are loaded through the tenant-scoped
 * `getInstructionSnapshot(id, projectId, organizationId)` (R11), and both must
 * pass the same content gate `get-file.ts` applies before serving a body:
 * READY, and either a direct version or an APPROVED proposal. A pending or
 * rejected proposal 404s exactly like a missing snapshot — otherwise a viewer
 * who cannot read a proposal's files could still enumerate the paths it adds,
 * renames or deletes through this route.
 *
 * `sha256` and `storageKey` are read to compute the diff and are stripped from
 * the response, for the reason spelled out on `list-files.ts`.
 */
export const compareSnapshotsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/compare",
		tags: ["Projects", "Instructions"],
		summary: "Compare two instruction snapshots",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			fromSnapshotId: z.string(),
			toSnapshotId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const [from, to] = await Promise.all([
			getInstructionSnapshot(
				input.fromSnapshotId,
				input.projectId,
				organizationId,
			),
			getInstructionSnapshot(
				input.toSnapshotId,
				input.projectId,
				organizationId,
			),
		]);
		// Fail closed on either side, and with the same message either way:
		// which of the two ids was unreadable is itself an answer about a
		// snapshot the caller may not read.
		if (
			!from ||
			!to ||
			!isInstructionSnapshotContentReadable(from) ||
			!isInstructionSnapshotContentReadable(to)
		) {
			throw new ORPCError("NOT_FOUND", { message: "Snapshot not found" });
		}

		const [fromFiles, toFiles] = await Promise.all([
			listInstructionFiles(from.id, organizationId),
			listInstructionFiles(to.id, organizationId),
		]);
		const fromByPath = new Map(fromFiles.map((f) => [f.path, f]));
		const toByPath = new Map(toFiles.map((f) => [f.path, f]));
		// The one manifest diff this repository has, rather than a second
		// implementation of the same comparison: a different `sha256` OR a
		// different normalised `mode` is the digest's own unit of change, so
		// "changed" here means exactly what it means to the installed-copy
		// diff MCP clients read.
		const changes = diffInstructionManifests(fromFiles, toFiles);

		const added = changes.added.flatMap((path) => {
			const file = toByPath.get(path);
			return file
				? [
						{
							path: file.path,
							kind: file.kind,
							isText: file.isText,
							size: file.size,
						},
					]
				: [];
		});
		const removed = changes.removed.flatMap((path) => {
			const file = fromByPath.get(path);
			return file
				? [
						{
							path: file.path,
							kind: file.kind,
							isText: file.isText,
							size: file.size,
						},
					]
				: [];
		});
		const changed = changes.changed.flatMap((path) => {
			const before = fromByPath.get(path);
			const after = toByPath.get(path);
			return before && after
				? [
						{
							path: after.path,
							kind: after.kind,
							// Diffable only when BOTH sides are text: a file
							// that turned binary (or stopped being one) has no
							// honest line diff to render.
							isText: before.isText && after.isText,
							fromSize: before.size,
							toSize: after.size,
						},
					]
				: [];
		});

		return {
			from: { id: from.id, version: from.version },
			to: { id: to.id, version: to.version },
			added,
			removed,
			changed,
			// Everything the `to` version carries that this diff did not name.
			unchangedCount: toFiles.length - added.length - changed.length,
		};
	});
