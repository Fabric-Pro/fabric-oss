/**
 * Resolves the prompts of the coordinated Proposal job (Fizzy #2801).
 *
 * Both actions resolve through `getBoundPromptForAgent`, so the precedence is
 * the one every other prompt follows (personal, then project, then
 * organization, then system), with one narrowing: the client-only Main
 * action never consults the personal tier. The bind procedure already refuses
 * a personal binding on it; the resolver ignoring one too means a row that got
 * in another way (a script, a data fix, a future writer) still cannot steer
 * the client document. The reader query itself is unchanged: it adds the
 * personal tier only when it is given a user, and for Main it is not.
 *
 * What also differs is what happens when nothing is bound: the Main prompt
 * fails closed. Falling back to the combined Draft prompt or to the built-in
 * instructions would put internal review material in front of the client,
 * which is the failure this job exists to prevent.
 *
 * Activity-side only: this reads the database.
 */

import { getBoundPromptForAgent } from "@repo/database";
import {
	findPromptAgentTarget,
	PROPOSAL_CLIENT_MAIN_AGENT_KEY,
} from "@repo/utils/prompt-action-catalog";
import { ApplicationFailure } from "@temporalio/common";
import {
	PROPOSAL_PROMPT_NOT_BOUND,
	type ProposalBoundPrompt,
	type ProposalPromptAction,
} from "./types";

/** Both actions are bound at the Proposal document type, for every kind. */
const PROPOSAL_PROMPT_DOCUMENT_TYPE = "PROPOSAL";

export interface ProposalPromptLookup {
	/**
	 * The triggering member, whose personal binding is consulted for the
	 * analysis action only.
	 */
	userId: string;
	/** The project's owning organization. */
	organizationId: string;
	/** Lets a project-narrowed organization binding win, as it does elsewhere. */
	projectId: string;
	action: ProposalPromptAction;
}

/**
 * The prompt bound to `action` for this caller, at the version the binding
 * points at, or null when nothing is bound. A database error propagates, so
 * the activity retries it like any other transient failure.
 */
export async function findBoundProposalPrompt(
	lookup: ProposalPromptLookup,
): Promise<ProposalBoundPrompt | null> {
	const bound = await getBoundPromptForAgent({
		agentName: lookup.action,
		documentType: PROPOSAL_PROMPT_DOCUMENT_TYPE,
		storyKind: null,
		// No user, no personal tier: the client document is never written
		// from a personal prompt.
		userId:
			lookup.action === PROPOSAL_CLIENT_MAIN_AGENT_KEY
				? undefined
				: lookup.userId,
		organizationId: lookup.organizationId,
		projectId: lookup.projectId,
	});
	if (!bound) {
		return null;
	}

	return {
		promptId: bound.id,
		versionNumber: bound.version.version,
		promptVersionId: bound.version.id,
	};
}

/**
 * The prompt bound to `action`, or a non-retryable
 * {@link PROPOSAL_PROMPT_NOT_BOUND} failure whose message tells an
 * administrator what to bind.
 */
export async function resolveBoundProposalPrompt(
	lookup: ProposalPromptLookup,
): Promise<ProposalBoundPrompt> {
	const bound = await findBoundProposalPrompt(lookup);
	if (!bound) {
		throw ApplicationFailure.nonRetryable(
			proposalPromptNotBoundMessage(lookup.action),
			PROPOSAL_PROMPT_NOT_BOUND,
		);
	}
	return bound;
}

/**
 * Written for the person who sees it on the document, and actionable by an
 * administrator: it names the action as the Prompt Library lists it. It names
 * no prompt, tenant or record.
 */
export function proposalPromptNotBoundMessage(
	action: ProposalPromptAction,
): string {
	const label = findPromptAgentTarget(action)?.label ?? action;
	const consequence =
		action === PROPOSAL_CLIENT_MAIN_AGENT_KEY
			? "so this Proposal cannot be generated"
			: "so the internal analysis cannot run";
	return `No prompt is bound to the "${label}" action, ${consequence}. An organization admin can bind one in the Prompt Library under Project Documents.`;
}
