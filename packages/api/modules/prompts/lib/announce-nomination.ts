import { listPromptNominationReviewers } from "@repo/database";
import {
	findPromptAgentTarget,
	promptDocumentTypeLabel,
} from "@repo/utils/prompt-action-catalog";
import { fanOut } from "../../../lib/notification-service";
import { resolveOrgBasePath } from "./org-base-path";

/**
 * Tell the admins who can decide a nomination that one is waiting (FR16).
 *
 * Fire-and-forget on purpose, matching `announceDefaultChange`: the nomination
 * is already written and correct, and a notification failure must not fail the
 * caller's request or suggest the proposal was lost.
 *
 * Recipients come from `listPromptNominationReviewers`, which resolves the same
 * authority the approve procedure enforces. Anyone else would receive a message
 * whose only possible outcome is a permission error.
 */
export async function announceNomination({
	nomination,
	targetScope,
	organizationId,
	targets,
	promptId,
	promptName,
	summary,
	degraded,
	actor,
}: {
	nomination: { id: string };
	targetScope: "SYSTEM" | "ORG";
	organizationId: string | null | undefined;
	targets: ReadonlyArray<{ targetKey: string; documentType: string }>;
	promptId: string;
	promptName: string;
	summary: string;
	degraded: boolean;
	actor: { id: string; name?: string | null };
}) {
	const recipients = await listPromptNominationReviewers({
		targetScope,
		organizationId,
		// The nominator already knows; telling them is noise.
		excludeUserId: actor.id,
	});

	if (recipients.length === 0) {
		return;
	}

	const first = targets[0];
	const agent = first ? findPromptAgentTarget(first.targetKey) : undefined;
	const actionLabel = first
		? agent
			? `${agent.label} — ${promptDocumentTypeLabel(first.documentType)}`
			: promptDocumentTypeLabel(first.documentType)
		: "an action";

	// The queue, which is where the decision is made. An ORG nomination links
	// into that organization's own context — the personal-context page shows a
	// different tier's queue entirely. A SYSTEM nomination stays on /app: its
	// reviewers are platform admins across every organization, and an org URL
	// they hold no membership in would hit the tenant gate.
	const basePath =
		targetScope === "ORG"
			? await resolveOrgBasePath(organizationId)
			: "/app";

	await fanOut.promptNominationPending({
		recipients,
		nominationId: nomination.id,
		promptId,
		promptName,
		targetScope,
		actionLabel,
		actionCount: targets.length,
		changeSummary: summary,
		summaryDegraded: degraded,
		link: `${basePath}/prompts/nominations`,
		nominatedByName: actor.name ?? null,
		actorUserId: actor.id,
	});
}
