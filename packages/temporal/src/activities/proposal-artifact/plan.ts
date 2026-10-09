import {
	clearLiveContent,
	db,
	isFeatureEnabled,
	isOrganizationMember,
	type ProposalArtifactGuardedOutcome,
	resetLiveSections,
} from "@repo/database";
import {
	PROPOSAL_CLIENT_MAIN_AGENT_KEY,
	PROPOSAL_INTERNAL_ANALYSIS_AGENT_KEY,
} from "@repo/utils/prompt-action-catalog";
import { ApplicationFailure } from "@temporalio/common";
import { contentIdentity } from "../../lib/proposal-artifact/content-identity";
import {
	findBoundProposalPrompt,
	resolveBoundProposalPrompt,
} from "../../lib/proposal-artifact/prompts";
import type {
	PlanProposalArtifactInput,
	PlanProposalArtifactResult,
	ProposalArtifactPlan,
	ProposalArtifactPlanSuperseded,
} from "../../lib/proposal-artifact/types";
import { activityLogger } from "../lib/activity-logger";

const SUPERSEDED: ProposalArtifactPlanSuperseded = { superseded: true };

/**
 * `ApplicationFailure.type` when the document to generate is gone, or is not
 * in the run's project. Non-retryable: a retry reads the same rows.
 */
const PROPOSAL_DOCUMENT_NOT_FOUND = "PROPOSAL_DOCUMENT_NOT_FOUND";

const PROPOSAL_DOCUMENT_NOT_FOUND_MESSAGE =
	"This document no longer exists in the project, so it was not generated.";

function documentNotFound(): ApplicationFailure {
	return ApplicationFailure.nonRetryable(
		PROPOSAL_DOCUMENT_NOT_FOUND_MESSAGE,
		PROPOSAL_DOCUMENT_NOT_FOUND,
	);
}

/**
 * Decide whether this generation is a coordinated Proposal run (Fizzy #2801),
 * and plan it when it is.
 *
 * The rollout gate is read FIRST, for the project's owning organization, and
 * a gate that is off returns null before any prompt is resolved or anything
 * is written: an organization without the gate never depends on the new
 * prompt actions, and its Proposals take today's flow. The organization comes
 * from the project row, never from the caller.
 *
 * With the gate on:
 * - a triggering user with no member row in the owning organization is a
 *   project guest; Internal Analysis never runs for one, so the analysis
 *   prompt is not even resolved for a guest;
 * - the client-only Main prompt must be bound, or the run fails here with
 *   `PROPOSAL_PROMPT_NOT_BOUND`, before the agent is called or any live
 *   section exists;
 * - an unbound analysis prompt only marks the Internal Analysis to be
 *   recorded as failed later;
 * - the live columns are taken over LAST, under the run token the workflow
 *   chose, so a plan that fails never takes them over.
 *
 * The token is the child execution's own run id, so a retried plan takes the
 * document over again with the same token, never one nobody holds. When the
 * run carries the generation attempt's identity, the takeover happens only
 * while the document still carries it: a plan that arrives late, or is
 * retried, after a newer request replaced its attempt answers superseded and
 * writes nothing. That is checked before anything else is resolved, so a
 * superseded run never fails (and so never writes FAILED) for a prompt either.
 */
export async function planProposalArtifact(
	input: PlanProposalArtifactInput,
): Promise<PlanProposalArtifactResult> {
	if (input.documentType !== "PROPOSAL") {
		return null;
	}

	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: { organizationId: true },
	});
	const owningOrganizationId = project?.organizationId;
	// No project or no organization: nothing to read the gate for, so the run
	// takes today's flow, as a gate that cannot be read does.
	if (!owningOrganizationId) {
		return null;
	}

	if (!(await isFeatureEnabled("PROPOSAL_ARTIFACT", owningOrganizationId))) {
		return null;
	}

	if (owningOrganizationId !== input.organizationId) {
		activityLogger.warn(
			"Proposal artifact run's organization differs from the project's; planning for the project's",
			{ projectId: input.projectId, documentId: input.documentId },
		);
	}

	const document = await db.projectDocument.findFirst({
		where: { id: input.documentId, projectId: input.projectId },
		// The version and body are read before the claim below: a save
		// landing between the two changes them and the run is refused at its
		// save, so an edit is never lost to the race, at worst a run is.
		select: {
			id: true,
			generationStartedAt: true,
			version: true,
			content: true,
		},
	});
	if (!document) {
		throw documentNotFound();
	}

	// Not thrown when unreadable: nobody can prove the document belongs to
	// this attempt, and a guessed takeover is worse than none. The dispatch
	// writes an ISO timestamp, so this does not happen in practice.
	const attemptStartedAt =
		input.generationStartedAt === undefined
			? undefined
			: new Date(input.generationStartedAt);
	if (
		attemptStartedAt &&
		(Number.isNaN(attemptStartedAt.getTime()) ||
			document.generationStartedAt?.getTime() !==
				attemptStartedAt.getTime())
	) {
		return supersededPlan(input);
	}

	const triggeredByGuest = !(await isOrganizationMember(
		input.userId,
		owningOrganizationId,
	));

	const lookup = {
		userId: input.userId,
		organizationId: owningOrganizationId,
		projectId: input.projectId,
	};
	const mainPrompt = await resolveBoundProposalPrompt({
		...lookup,
		action: PROPOSAL_CLIENT_MAIN_AGENT_KEY,
	});
	const analysisPrompt = triggeredByGuest
		? null
		: await findBoundProposalPrompt({
				...lookup,
				action: PROPOSAL_INTERNAL_ANALYSIS_AGENT_KEY,
			});
	const analysisSkipReason: ProposalArtifactPlan["analysisSkipReason"] =
		triggeredByGuest
			? "GUEST_TRIGGERED"
			: analysisPrompt
				? null
				: "PROMPT_NOT_BOUND";

	const { liveRunId } = input;
	let claim: ProposalArtifactGuardedOutcome;
	try {
		claim = await resetLiveSections({
			documentId: input.documentId,
			runId: liveRunId,
			...(attemptStartedAt && { generationStartedAt: attemptStartedAt }),
		});
	} catch (error) {
		// The document was deleted between the read above and this write.
		if ((error as { code?: unknown } | null)?.code === "P2025") {
			throw documentNotFound();
		}
		throw error;
	}
	// A newer request replaced this attempt between the read and the claim.
	if (claim === "superseded") {
		return supersededPlan(input);
	}

	activityLogger.info("Planned a coordinated Proposal run", {
		projectId: input.projectId,
		documentId: input.documentId,
		liveRunId,
		mainPromptVersionId: mainPrompt.promptVersionId,
		analysisSkipReason,
		triggeredByGuest,
	});

	return {
		liveRunId,
		baselineVersion: document.version,
		baselineContentHash: contentIdentity(document.content),
		mainPrompt,
		analysisPrompt,
		analysisSkipReason,
		triggeredByGuest,
	};
}

function supersededPlan(
	input: PlanProposalArtifactInput,
): ProposalArtifactPlanSuperseded {
	activityLogger.info(
		"Coordinated Proposal run superseded before it started",
		{
			projectId: input.projectId,
			documentId: input.documentId,
			liveRunId: input.liveRunId,
		},
	);
	return SUPERSEDED;
}

/**
 * Drop a coordinated run's live preview when the run fails. Guarded on the
 * run token: a run clears only its own preview, never a newer run's, so a
 * superseded run's cleanup is a `superseded` no-op.
 */
export async function clearProposalLiveContent(input: {
	documentId: string;
	liveRunId: string;
}): Promise<{ outcome: ProposalArtifactGuardedOutcome }> {
	const outcome = await clearLiveContent({
		documentId: input.documentId,
		runId: input.liveRunId,
	});
	return { outcome };
}
