import { ORPCError } from "@orpc/client";
import {
	createInstructionSnapshot,
	getProjectInstructionSettings,
} from "@repo/database";
import {
	buildIgnoreMatcher,
	classifyPath,
	resolveIgnoreGlobs,
	SNAPSHOT_LIMITS,
	stagingKey,
	validateRelativePath,
} from "@repo/instructions";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { fileTypingFor } from "./file-typing";
import { requireHostingOrganizationId } from "./hosting-organization";

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
		const resolved = resolveIgnoreGlobs({
			fabricIgnoreText: input.fabricIgnoreText ?? null,
			projectGlobs: settings.ignoreGlobs,
		});
		const isIgnored = buildIgnoreMatcher(resolved);

		const kept: Array<{
			path: string;
			size: number;
			sha256: string;
			mimeType: string;
			isText: boolean;
			kind: ReturnType<typeof classifyPath>;
			storageKey: string;
		}> = [];
		const excluded: Array<{ path: string; rule: string; layer: string }> =
			[];
		const seen = new Set<string>();
		let totalBytes = 0;

		for (const file of input.files) {
			const v = validateRelativePath(file.path);
			if (!v.ok) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Path rejected (${v.reason}): ${file.path}`,
				});
			}
			const lower = v.path.toLowerCase();
			if (seen.has(lower)) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Duplicate path (case-insensitive): ${v.path}`,
				});
			}
			seen.add(lower);
			const match = isIgnored(v.path);
			if (match) {
				excluded.push({
					path: v.path,
					rule: match.rule,
					layer: match.layer,
				});
				continue;
			}
			if (file.size > SNAPSHOT_LIMITS.maxFileBytes) {
				throw new ORPCError("BAD_REQUEST", {
					message: `File too large (${file.size} bytes): ${v.path}`,
				});
			}
			totalBytes += file.size;
			kept.push({
				path: v.path,
				size: file.size,
				sha256: file.sha256,
				...fileTypingFor(v.path),
				kind: classifyPath(v.path),
				storageKey: stagingKey(
					input.projectId,
					"pending",
					String(kept.length),
				),
			});
		}
		if (kept.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Every file was excluded; nothing to upload",
			});
		}
		if (kept.length > SNAPSHOT_LIMITS.maxFiles) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Too many files (${kept.length} > ${SNAPSHOT_LIMITS.maxFiles})`,
			});
		}
		if (totalBytes > SNAPSHOT_LIMITS.maxTotalBytes) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Upload too large (${totalBytes} bytes > ${SNAPSHOT_LIMITS.maxTotalBytes})`,
			});
		}

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
			excludedCount: excluded.length,
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
				excludedCount: excluded.length,
				layer: resolved.layer,
			},
		});

		return {
			snapshotId: snapshot.id,
			version: snapshot.version,
			keptCount: kept.length,
			excludedCount: excluded.length,
			excluded,
		};
	});
