/**
 * Daily Brief — Hide Release-Note Procedure (Fizzy 1869 follow-up).
 *
 * Records a per-project release-notes exclusion (by PR or story identifier)
 * so a flag-gated / noisy PR is suppressed from the Daily Brief's Release
 * Notes panel and the newsletter. The mutation and its audit row commit
 * atomically (`recordAuditTx` inside `db.$transaction`); a best-effort,
 * change-gated regeneration re-runs the VIEWED brief window so the user sees
 * the effect immediately.
 *
 * Tenant safety: the org is resolved from the session and the project is
 * re-fetched under the resolved tenant scope, so a foreign-tenant caller
 * gets NOT_FOUND and the stored tenant columns are derived from the VERIFIED
 * project (never raw input).
 */
import { ORPCError } from "@orpc/server";
import {
	buildExclusionTargetKey,
	createReleaseNoteExclusion,
	db,
	recordAuditTx,
	timeWindowKindSchema,
} from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { requestDailyBriefRegeneration } from "../lib/request-regeneration";

const inputSchema = z
	.object({
		projectId: z.string(),
		organizationId: z.string().nullable().optional(),
		kind: z.enum(["pr", "story"]),
		repoFullName: z.string().optional(),
		prNumber: z.number().int().optional(),
		storyIdentifier: z.string().optional(),
		reason: z.string().max(500).optional(),
		// The window the user is viewing — regenerate THAT brief.
		timeWindow: timeWindowKindSchema.optional(),
	})
	.refine(
		(v) =>
			v.kind === "pr"
				? !!v.repoFullName && v.prNumber != null
				: !!v.storyIdentifier,
		{
			message:
				"pr requires repoFullName+prNumber; story requires storyIdentifier",
		},
	);

export const hideReleaseNoteProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		// `requireProjectPermission` above has already authorized this caller for
		// THIS project — as owner, active ProjectMember, or via an org role. Load
		// the project by id and take the tenant from the loaded row;
		// `input.organizationId` is a guard, never a scoping key.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true, userId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		assertInputOrgMatchesProject(input.organizationId, project);

		const tenant = {
			projectId: project.id,
			organizationId: project.organizationId ?? null,
			userId: project.userId,
		};
		const exclusionInput =
			input.kind === "pr"
				? {
						kind: "pr" as const,
						repoFullName: input.repoFullName!,
						prNumber: input.prNumber!,
						reason: input.reason,
					}
				: {
						kind: "story" as const,
						storyIdentifier: input.storyIdentifier!,
						reason: input.reason,
					};

		const { created, row } = await db.$transaction(async (tx) => {
			const result = await createReleaseNoteExclusion(
				tx,
				tenant,
				exclusionInput,
				context.user.id,
			);
			// Audit is gated on an ACTUAL state change: a duplicate hide
			// (created === false) is a no-op and emits no audit row.
			if (result.created) {
				await recordAuditTx(tx, {
					action: "dailyBrief.releaseNote.hidden",
					actor: {
						type: "user",
						userId: context.user.id,
						emailSnapshot: context.user.email,
						nameSnapshot: context.user.name,
					},
					organizationId: tenant.organizationId,
					projectId: tenant.projectId,
					resource: {
						type: "daily_brief_release_note_exclusion",
						id: result.row.id,
						name: buildExclusionTargetKey(exclusionInput),
					},
					metadata: {
						kind: input.kind,
						targetKey: buildExclusionTargetKey(exclusionInput),
					},
				});
			}
			return result;
		});

		// Regenerate ONLY on an actual state change (created === true). A no-op
		// duplicate hide must NOT force a regen — force bypasses the rate limit,
		// so regenerating on every duplicate call would start unbounded
		// workflows for no change (Codex finding).
		if (created) {
			// Best-effort — never fails or rolls back the persisted exclusion.
			// force: true bypasses the 5-min rate limit (deliberate curation); if
			// a generation is already in-flight it returns in_flight and the
			// workflow's self-rerun converges.
			try {
				await requestDailyBriefRegeneration({
					projectId: project.id,
					project: {
						organizationId: tenant.organizationId,
						userId: tenant.userId,
					},
					triggeredByUserId: context.user.id,
					force: true,
					// Regenerate the VIEWED window so the user sees the effect
					// (helper defaults if absent). CUSTOM has no fixed
					// start/end (resolveTimeWindow throws), so normalize it to
					// the helper's default preset — the exclusion is
					// window-agnostic at generation time, so a default-window
					// regen still applies it rather than throwing into the
					// best-effort catch and starting nothing.
					timeWindow:
						input.timeWindow === "CUSTOM"
							? undefined
							: input.timeWindow,
				});
			} catch {
				/* swallow — exclusion persists; the forced regen / workflow self-rerun applies it */
			}
		}

		return { created, exclusion: row };
	});
