import { ORPCError } from "@orpc/server";
import {
	addDeclinedGroupingThemes,
	db,
	ensureFabricSystemUser,
	FABRIC_SYSTEM_USER_ID,
	type GroupingCreatedTheme,
	type GroupingProposalCreate,
	type GroupingProposalUpdate,
	type GroupingRunResults,
	type GroupingUpdatedTheme,
	getScanFindingGrouping,
	hasProjectAccess,
	recordScanActivity,
	updateScanFindingGrouping,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { createGroupingTicket } from "../../lib/create-grouping-ticket";

/**
 * Apply the accepted proposals from an AWAITING_REVIEW grouping run: create the
 * accepted new tickets (per-ticket PM-sync choice), post the accepted
 * incremental comments, and durably record the declined themes so they stay
 * declined on future runs. Flips the run to COMPLETED.
 *
 * The run is the source of truth for proposal bodies (drafted verbatim during
 * the propose phase), so apply performs no LLM work — just DB writes + optional
 * PM enqueue, mirroring the channel-monitor "approve" procedure.
 */
export const applyGroupingProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/scan/grouping/apply",
		tags: ["Projects", "Security"],
		summary: "Apply reviewed grouping proposals (create/update/decline)",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			groupingId: z.string().min(1),
			/** Proposals to apply. `syncToPM` only applies to create proposals. */
			accepted: z
				.array(
					z.object({
						themeKey: z.string().min(1),
						syncToPM: z.boolean().optional(),
					}),
				)
				.default([]),
			/** Proposals to decline — recorded durably so they stay declined. */
			declinedThemeKeys: z.array(z.string().min(1)).default([]),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, groupingId, accepted, declinedThemeKeys } = input;
		const organizationId = input.organizationId ?? null;
		const userId = context.user.id;

		const hasAccess = await hasProjectAccess(
			projectId,
			userId,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const run = await getScanFindingGrouping(groupingId, projectId);
		if (!run) {
			throw new ORPCError("NOT_FOUND", {
				message: "Grouping run not found",
			});
		}

		// CAS AWAITING_REVIEW -> APPLYING so a concurrent apply can't double-write.
		const claim = await db.scanFindingGrouping.updateMany({
			where: { id: groupingId, projectId, status: "AWAITING_REVIEW" },
			data: { status: "APPLYING" },
		});
		if (claim.count === 0) {
			throw new ORPCError("CONFLICT", {
				message: "This grouping run is not awaiting review",
			});
		}

		const results = (run.results ?? {}) as GroupingRunResults;
		const proposedCreate = results.proposedCreate ?? [];
		const proposedUpdate = results.proposedUpdate ?? [];
		const priorDeclined = results.declinedThemes ?? [];

		const createByKey = new Map(proposedCreate.map((p) => [p.themeKey, p]));
		const updateByKey = new Map(proposedUpdate.map((p) => [p.themeKey, p]));
		// A decline can target a create proposal OR a carried-forward declined one.
		const declinableByKey = new Map<string, GroupingProposalCreate>([
			...proposedCreate.map((p) => [p.themeKey, p] as const),
			...priorDeclined.map((p) => [p.themeKey, p] as const),
		]);

		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				projectManagementMcpConfigId: true,
				projectManagementContainerId: true,
			},
		});
		const pmConfigured =
			!!project?.projectManagementMcpConfigId &&
			!!project?.projectManagementContainerId;

		await ensureFabricSystemUser();

		const createdThemes: GroupingCreatedTheme[] = [];
		const updatedThemes: GroupingUpdatedTheme[] = [];
		const appliedFailed = [...(results.failedThemes ?? [])];

		// ---- Accepted proposals ----
		for (const decision of accepted) {
			const createProposal = createByKey.get(decision.themeKey);
			if (createProposal) {
				try {
					const { storyId, storyIdentifier } =
						await createGroupingTicket(createProposal, {
							projectId,
							organizationId,
							userId,
							doSync: decision.syncToPM === true && pmConfigured,
						});
					createdThemes.push({
						category: createProposal.category,
						ruleSource: createProposal.ruleSource,
						themeKey: createProposal.themeKey,
						findingCount: createProposal.findingCount,
						storyId,
						storyIdentifier,
					});
				} catch (error) {
					logger.warn("[applyGrouping] create failed for theme", {
						themeKey: decision.themeKey,
						error:
							error instanceof Error
								? error.message
								: String(error),
					});
					appliedFailed.push({
						category: createProposal.category,
						ruleSource: createProposal.ruleSource,
						themeKey: createProposal.themeKey,
						findingCount: createProposal.findingCount,
						reason: "apply_failed",
					});
				}
				continue;
			}

			const updateProposal = updateByKey.get(decision.themeKey);
			if (updateProposal) {
				try {
					await applyUpdate(updateProposal, {
						projectId,
						organizationId,
						userId,
						updatedThemes,
					});
				} catch (error) {
					logger.warn("[applyGrouping] update failed for theme", {
						themeKey: decision.themeKey,
						error:
							error instanceof Error
								? error.message
								: String(error),
					});
					appliedFailed.push({
						category: updateProposal.category,
						ruleSource: updateProposal.ruleSource,
						themeKey: updateProposal.themeKey,
						findingCount: updateProposal.findingCount,
						reason: "apply_failed",
					});
				}
			}
		}

		// ---- Declined proposals (durable) ----
		const nowIso = new Date().toISOString();
		const declinedRecords = declinedThemeKeys
			.map((key) => declinableByKey.get(key))
			.filter((p): p is GroupingProposalCreate => p !== undefined);
		if (declinedRecords.length > 0) {
			await addDeclinedGroupingThemes(
				projectId,
				{ userId, organizationId },
				declinedRecords.map((p) => ({
					themeKey: p.themeKey,
					category: p.category,
					ruleSource: p.ruleSource,
					severity: p.severity ?? null,
					declinedByUserId: userId,
					declinedAt: nowIso,
				})),
			);
		}

		// Anything neither accepted nor declined stays as an (un-applied) proposal
		// in the final results so "view last run" still shows it; the run is
		// COMPLETED regardless.
		const acceptedKeys = new Set(accepted.map((a) => a.themeKey));
		const declinedKeySet = new Set(declinedThemeKeys);
		const remainingCreate = proposedCreate.filter(
			(p) =>
				!acceptedKeys.has(p.themeKey) &&
				!declinedKeySet.has(p.themeKey),
		);
		const remainingUpdate = proposedUpdate.filter(
			(p) => !acceptedKeys.has(p.themeKey),
		);

		// Preserve any themes already recorded on the run (e.g. a "Re-add" that
		// created a ticket before this apply) so they aren't dropped from the
		// run-results display.
		const allCreatedThemes = [
			...(results.createdThemes ?? []),
			...createdThemes,
		];
		const allUpdatedThemes = [
			...(results.updatedThemes ?? []),
			...updatedThemes,
		];

		const finalResults: GroupingRunResults = {
			createdThemes: allCreatedThemes,
			updatedThemes: allUpdatedThemes,
			declinedThemes: declinedRecords,
			skippedThemes: results.skippedThemes ?? [],
			failedThemes: appliedFailed,
			proposedCreate: remainingCreate,
			proposedUpdate: remainingUpdate,
		};

		await updateScanFindingGrouping(groupingId, {
			status: "COMPLETED",
			completedAt: new Date(),
			results: finalResults,
			createdCount: allCreatedThemes.length,
			updatedCount: allUpdatedThemes.length,
			failedCount: appliedFailed.length,
		});

		await recordScanActivity({
			projectId,
			type: "FINDINGS_GROUPED",
			userId,
			organizationId,
			summary: `Applied grouping: created ${createdThemes.length} ticket(s), updated ${updatedThemes.length}, declined ${declinedRecords.length}`,
			metadata: {
				groupingId,
				createdCount: createdThemes.length,
				updatedCount: updatedThemes.length,
				declinedCount: declinedRecords.length,
			},
		}).catch(() => {
			/* history-feed row only — never fails the apply */
		});

		return {
			createdCount: createdThemes.length,
			updatedCount: updatedThemes.length,
			declinedCount: declinedRecords.length,
			failedCount: appliedFailed.length,
		};
	});

async function applyUpdate(
	proposal: GroupingProposalUpdate,
	ctx: {
		projectId: string;
		organizationId: string | null;
		userId: string;
		updatedThemes: GroupingUpdatedTheme[];
	},
): Promise<void> {
	const { projectId, organizationId, userId, updatedThemes } = ctx;

	await db.$transaction([
		db.userStoryComment.create({
			data: {
				storyId: proposal.storyId,
				authorId: FABRIC_SYSTEM_USER_ID,
				authorType: "AGENT",
				content: proposal.commentBody,
				organizationId: organizationId ?? null,
				metadata: {
					source: "security_finding_grouping",
					themeKey: proposal.themeKey,
				},
			},
		}),
		db.scanActivity.create({
			data: {
				projectId,
				type: "FINDINGS_GROUPED",
				userId,
				organizationId: organizationId ?? null,
				storyId: proposal.storyId,
				summary: `Added ${proposal.newFindingCount} new finding${proposal.newFindingCount === 1 ? "" : "s"} to ${proposal.storyIdentifier}`,
				metadata: {
					themeKey: proposal.themeKey,
					category: proposal.category,
					ruleSource: proposal.ruleSource,
					outcome: "updated",
					fingerprints: proposal.cumulativeFingerprints,
				},
			},
		}),
	]);

	updatedThemes.push({
		category: proposal.category,
		ruleSource: proposal.ruleSource,
		themeKey: proposal.themeKey,
		findingCount: proposal.findingCount,
		storyId: proposal.storyId,
		storyIdentifier: proposal.storyIdentifier,
		newFindingCount: proposal.newFindingCount,
	});
}
