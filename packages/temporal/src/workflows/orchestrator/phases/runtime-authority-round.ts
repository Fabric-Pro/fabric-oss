/**
 * One inline approval round for a chat tool call that needs runtime authority.
 *
 * `executeMcpTool` (with `requestRuntimeAuthority`) refuses a WRITE the run
 * holds no grant for, raises a PENDING authority session, and says so in
 * `authorityRequired`. This puts that session in front of the user as the
 * chat's inline approval, the same shape plan mode uses for a step blocked on
 * authority: an explicit decision (approve-all does not cover it), the session
 * approved or denied by the workflow's own activity, and a re-check before
 * anything runs — here the re-check is simply running the tool again, since
 * the activity checks authority before every call.
 *
 * Exactly one round: a tool still refused after approval (revoked in between,
 * a grant that does not cover it) comes back as a tool error, never a loop.
 * Every outcome is a tool result the model can relay; none fails the run.
 *
 * Workflow code: deterministic, no I/O of its own — everything it does goes
 * through the injected activities and the workflow's own `waitForApproval`.
 */

import { log } from "@temporalio/workflow";
import type {
	ExecuteMcpToolOutput,
	RuntimeAuthorityRequest,
} from "../../../activities/orchestrator/types";
import type { ApprovalSignalData, WorkflowState } from "../types";

interface RuntimeAuthorityRoundDeps {
	state: Pick<
		WorkflowState,
		"pendingApproval" | "approvalDecision" | "status"
	>;
	toolCallId: string;
	/** Re-runs the same tool call, with the same input as the first attempt */
	runTool: () => Promise<ExecuteMcpToolOutput>;
	waitForApproval: (options: {
		requireExplicitDecision: boolean;
	}) => Promise<ApprovalSignalData | null>;
	approveSession: (input: {
		authoritySessionId: string;
		instructions?: string;
	}) => Promise<unknown>;
	denySession: (input: {
		authoritySessionId: string;
		reason: string;
	}) => Promise<unknown>;
	updateProgress: (phase: string, message: string) => void;
}

/**
 * The reason line the chat's approval card renders. `parseApprovalReason`
 * reads the leading risk level, so it must stay `<LEVEL> RISK: …`.
 */
export function runtimeAuthorityApprovalReason(
	request: RuntimeAuthorityRequest,
): string {
	return `HIGH RISK: Allow ${request.accessLevel} access to ${request.providerDisplayName} for this conversation? The assistant wants to run "${request.toolName}". Approving lets this conversation make changes in ${request.providerDisplayName} until the grant expires.`;
}

function toolError(
	first: ExecuteMcpToolOutput,
	message: string,
): ExecuteMcpToolOutput {
	return {
		output: { error: message },
		durationMs: first.durationMs,
		success: false,
		cached: false,
	};
}

export async function resolveRuntimeAuthority(
	first: ExecuteMcpToolOutput,
	deps: RuntimeAuthorityRoundDeps,
): Promise<ExecuteMcpToolOutput> {
	const request = first.authorityRequired;
	if (!request) {
		return first;
	}
	const sessionId = request.pendingSessionId;
	if (!sessionId) {
		// Nothing to approve (no run to bind a session to). The activity's
		// own error text already says what is missing.
		return first;
	}

	const { state } = deps;
	state.pendingApproval = {
		approvalId: `authority-${sessionId}-${deps.toolCallId}`,
		stepId: `authority-${deps.toolCallId}`,
		reason: runtimeAuthorityApprovalReason(request),
	};
	state.status = "awaiting_approval";
	deps.updateProgress(
		"awaiting_approval",
		`Approval needed: ${request.accessLevel} access to ${request.providerDisplayName}`,
	);

	const decision = await deps.waitForApproval({
		requireExplicitDecision: true,
	});

	state.pendingApproval = null;
	state.approvalDecision = null;
	state.status = "running";

	if (!decision?.approved) {
		try {
			await deps.denySession({
				authoritySessionId: sessionId,
				reason: decision?.feedback || "User declined authority",
			});
		} catch (error) {
			log.warn("Could not deny runtime authority session", {
				authoritySessionId: sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		const note = decision?.feedback
			? ` Their note: "${decision.feedback}".`
			: "";
		return toolError(
			first,
			`The user declined ${request.accessLevel} access to ${request.providerDisplayName}, so "${request.toolName}" was not run and nothing was changed.${note} Tell the user the action was not taken; do not retry it unless they ask.`,
		);
	}

	try {
		await deps.approveSession({
			authoritySessionId: sessionId,
			instructions: decision.feedback,
		});
	} catch (error) {
		log.warn("Could not approve runtime authority session", {
			authoritySessionId: sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
		return toolError(
			first,
			`The approval for ${request.accessLevel} access to ${request.providerDisplayName} could not be recorded, so "${request.toolName}" was not run. The request may have expired or been revoked; ask the user to try again.`,
		);
	}

	deps.updateProgress("executing_tool", `Calling ${request.toolName}...`);
	const second = await deps.runTool();
	if (second.authorityRequired) {
		return toolError(
			second,
			`${request.accessLevel} access to ${request.providerDisplayName} was approved but is not in force (it may have been revoked), so "${request.toolName}" was not run.`,
		);
	}
	return second;
}
