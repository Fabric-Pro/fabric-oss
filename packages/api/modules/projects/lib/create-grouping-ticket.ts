import {
	db,
	FABRIC_SYSTEM_USER_ID,
	type GroupingProposalCreate,
	recordScanActivity,
} from "@repo/database";
import { logger } from "@repo/logs";
import { createStoryFromProposal } from "@repo/temporal";
import { enqueuePmSync } from "./enqueue-pm-sync";

/**
 * Shared "create one generated ticket from a grouping proposal" used by both
 * `scan.grouping.apply` (accepted creates) and `scan.grouping.readd` (re-add a
 * declined ticket). Persists the drafted body verbatim (no re-draft), stamps
 * the hidden theme-identity tag + the visible RULE/CATEGORY tags (+
 * needs-rule-review for accessibility), records the FINDINGS_GROUPED activity
 * row (fingerprints for future dedup), and enqueues the initial PM push when
 * `doSync`. Callers must have already run `ensureFabricSystemUser()`.
 */

const NEEDS_RULE_REVIEW_TAG = "needs-rule-review";

/** Visible, user-facing tags: the category and a tag-safe normalized rule tag. */
function visibleGroupingTagValues(
	category: string,
	ruleSource: string,
): string[] {
	const categoryTag =
		category === "ACCESSIBILITY" ? "Accessibility" : "Security";
	const ruleTag =
		ruleSource
			.replace(/[^\p{L}\p{N} _()/-]+/gu, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 50) || "rule";
	return [categoryTag, ruleTag];
}

export interface CreateGroupingTicketContext {
	projectId: string;
	organizationId: string | null;
	userId: string;
	doSync: boolean;
}

export async function createGroupingTicket(
	proposal: GroupingProposalCreate,
	ctx: CreateGroupingTicketContext,
): Promise<{ storyId: string; storyIdentifier: string }> {
	const { projectId, organizationId, userId, doSync } = ctx;

	const { story } = await createStoryFromProposal({
		projectId,
		organizationId,
		createdById: userId,
		title: proposal.title,
		description: proposal.body,
		kind: "BUG",
		skipClassifier: true,
		skipDrafting: true,
		bodyAlreadyDrafted: true,
		needsMoreInfo: false,
		priority: proposal.priority,
		source: "SECURITY_SCAN",
		enablePmAutoSync: doSync,
	});

	const tagValues = [
		proposal.themeKey,
		...visibleGroupingTagValues(proposal.category, proposal.ruleSource),
	];
	if (proposal.category === "ACCESSIBILITY") {
		tagValues.push(NEEDS_RULE_REVIEW_TAG);
	}
	await db.storyTag.createMany({
		data: tagValues.map((value) => ({
			storyId: story.id,
			value,
			createdById: FABRIC_SYSTEM_USER_ID,
		})),
		skipDuplicates: true,
	});

	await recordScanActivity({
		projectId,
		type: "FINDINGS_GROUPED",
		userId,
		organizationId,
		storyId: story.id,
		summary: `Created ${story.identifier} for "${proposal.ruleSource}" (${proposal.findingCount} finding${proposal.findingCount === 1 ? "" : "s"})`,
		metadata: {
			themeKey: proposal.themeKey,
			category: proposal.category,
			ruleSource: proposal.ruleSource,
			outcome: "created",
			fingerprints: proposal.fingerprints,
		},
	}).catch(() => {
		/* history-feed row only — never fails the create */
	});

	if (doSync) {
		try {
			await enqueuePmSync({
				itemId: story.id,
				itemType: "bug",
				projectId,
				userId,
				forceInitialPush: true,
				triggerSource: "auto-push",
			});
		} catch (error) {
			logger.warn(
				"[createGroupingTicket] enqueuePmSync threw — ticket persisted without initial sync",
				{
					storyId: story.id,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
		}
	}

	return { storyId: story.id, storyIdentifier: story.identifier };
}
