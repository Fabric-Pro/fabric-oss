import { ORPCError } from "@orpc/client";
import {
	createInstructionSnapshot,
	getProjectInstructionSettings,
} from "@repo/database";
import {
	describePortableNameRefusal,
	type PlanRefusal,
	planSnapshotFiles,
	resolveIgnoreGlobs,
	SNAPSHOT_LIMITS,
	stagingKey,
} from "@repo/instructions";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";

/** The sentence a person reads for each planner refusal. Unchanged from the inline loop it replaced. */
function describePlanRefusal(refusal: PlanRefusal): string {
	switch (refusal.code) {
		case "invalid_path":
			return `Path rejected (${refusal.reason}): ${refusal.path}`;
		case "duplicate_path":
			return `Duplicate path (same file on a case-insensitive filesystem): ${refusal.path}`;
		case "file_directory_conflict":
			return `A name cannot be both a file and a folder: ${refusal.conflictsWith} and ${refusal.path}`;
		case "non_portable_name":
			return describePortableNameRefusal(refusal.path, refusal.refusal);
		case "file_too_large":
			return `File too large (${refusal.size} bytes): ${refusal.path}`;
		case "nothing_kept":
			return "Every file was excluded; nothing to upload";
		case "too_many_files":
			return `Too many files (${refusal.count} > ${refusal.max})`;
		case "total_too_large":
			return `Upload too large (${refusal.totalBytes} bytes > ${refusal.max})`;
	}
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_CREATE).
 *
 * Registers a coding-instructions upload: validates every relative path,
 * applies the project's (or the upload's own `.fabricignore`) ignore rules
 * server-side, enforces `@repo/instructions`' `SNAPSHOT_LIMITS` caps, and
 * creates the RECEIVING snapshot with its file rows. Storage keys are
 * ALWAYS server-generated — the client never supplies one — using a
 * provisional `stagingKey(projectId, "pending", <index>)` because the real
 * snapshot id does not exist until `createInstructionSnapshot` returns.
 * `create-upload-urls.ts` rewrites each file's key to the real
 * `(projectId, snapshotId, fileId)` form before minting its signed URL.
 */
export const beginSnapshotProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/snapshots",
		tags: ["Projects", "Instructions"],
		summary: "Begin a coding-instructions upload",
	})
	.input(
		z.object({
			projectId: z.string(),
			// Accepted for shape parity with the other project procedures and
			// ignored: the handler derives the organization from the project
			// itself (see below). It is deliberately NOT removed, so a client
			// that sends it keeps working rather than failing validation.
			organizationId: z.string().nullable().optional(),
			publishOnReady: z.boolean().default(true),
			fabricIgnoreText: z
				.string()
				.max(64 * 1024)
				.nullable()
				.optional(),
			files: z
				.array(
					z.object({
						path: z.string().max(4096),
						size: z.number().int().min(0),
						sha256: z.string().regex(/^[0-9a-f]{64}$/),
					}),
				)
				.min(1)
				.max(SNAPSHOT_LIMITS.maxFiles * 4),
			// The number of entries the client left out under the same rules
			// and therefore never sent. Informational only: it is folded into
			// the snapshot's `excludedCount` so the published view's "N files
			// left out" still describes the whole pick, not just what reached
			// the server. Nothing is enforced from it — the server still
			// applies its own rules to everything it receives, so a client
			// that omits this field, or sends excluded paths anyway, keeps
			// working.
			clientExcludedCount: z
				.number()
				.int()
				.min(0)
				.max(1_000_000)
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// The organization these rows are TAGGED with is the project's own
		// hosting organization, re-derived here rather than taken from the
		// request — a REST/API-key caller could otherwise name any
		// organization and every snapshot and file row this call writes would
		// carry it. Shared with every sibling procedure; see
		// `hosting-organization.ts` for why `resolveOrganizationId` is the
		// wrong answer for a project-scoped operation.
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);

		const settings = await getProjectInstructionSettings(
			input.projectId,
			organizationId,
		);
		// Spec §4: one source of truth per project. While a repository is
		// the source, an upload would publish files the repository never
		// had and nothing would reconcile them until the next sync — the
		// same refusal `derive-snapshot.ts` and `submit-change.ts` give.
		if (settings.sourceOfTruth === "REPOSITORY") {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"This project's coding instructions come from its repository. Change the files there and sync the project.",
			});
		}
		const resolved = resolveIgnoreGlobs({
			fabricIgnoreText: input.fabricIgnoreText ?? null,
			projectGlobs: settings.ignoreGlobs,
		});
		// Which files this upload keeps is judged by the same planner a
		// repository sync uses (`planSnapshotFiles`): path validation, then
		// ignore matching, then collisions/portability/size on the KEPT
		// paths only, so both paths judge a tree identically.
		const plan = planSnapshotFiles({
			files: input.files,
			ignore: resolved,
		});
		if (!plan.ok) {
			throw new ORPCError("BAD_REQUEST", {
				message: describePlanRefusal(plan.refusal),
			});
		}
		const excluded = plan.excluded;
		const kept = plan.kept.map((file, index) => ({
			path: file.path,
			size: file.source.size,
			sha256: file.source.sha256,
			mimeType: file.mimeType,
			isText: file.isText,
			kind: file.kind,
			storageKey: stagingKey(input.projectId, "pending", String(index)),
		}));

		const excludedCount =
			excluded.length + (input.clientExcludedCount ?? 0);

		const snapshot = await createInstructionSnapshot({
			projectId: input.projectId,
			organizationId,
			userId: context.user.id,
			source: "UPLOAD",
			settingsFrozen: {
				ignoreGlobs: resolved.globs,
				layer: resolved.layer,
				limits: SNAPSHOT_LIMITS,
			},
			publishOnReady: input.publishOnReady,
			excludedCount,
			files: kept,
		});

		recordAuditFromRequest(context, {
			action: "project.instructions.upload_started",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_snapshot",
				id: snapshot.id,
				name: `v${snapshot.version}`,
			},
			metadata: {
				keptCount: kept.length,
				excludedCount,
				// Kept apart from the total so an audit reader can tell rules
				// the server applied from a count the client reported.
				serverExcludedCount: excluded.length,
				layer: resolved.layer,
			},
		});

		return {
			snapshotId: snapshot.id,
			version: snapshot.version,
			keptCount: kept.length,
			excludedCount,
			excluded,
		};
	});
