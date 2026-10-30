import { EventType } from "@ag-ui/client";
import { getRedisClient } from "@repo/api/lib/redis-client";
import {
	abandonConversationTurnStart,
	type ConversationTurn,
} from "@repo/database";
import type { getTemporalClient } from "@repo/temporal";
import { InvalidBudgetContinuationError } from "../../../../app/api/agents/fabric-ai/orchestrator-temporal/budget-continuation";
import {
	billOrchestratorTurn,
	buildOrchestratorWorkflowInput,
	filterOrchestratorTurnWorkspaces,
	refuseOversizedOrchestratorInput,
	type resolveOrchestratorTurnRequest,
} from "../../../../app/api/agents/fabric-ai/orchestrator-temporal/orchestrator-turn";
import {
	TurnStartAmbiguousError,
	TurnStoppedBeforeStartError,
} from "../../../../app/api/agents/fabric-ai/orchestrator-temporal/turn-admission";
import { buildWorkflowErrorEvent } from "../../../../app/api/agents/fabric-ai/stream/turn-events";
import { type ApiBillingNotice, apiBillingNotice } from "./direct-turn-record";
import type { RunStream, RuntimeCaller } from "./engine";
import { refuse } from "./run-errors";

/**
 * The start of an Orchestrator turn the engines share: filter, bill and
 * build a created turn's workflow input, and say how a start that failed
 * ends the run. Used by the single-turn engine (`orchestrator-engine.ts`)
 * and by each agent of a multi-agent turn (`multi-agent-turn-start.ts`).
 */

/** A turn request the stream route's checks accepted. */
export type OrchestratorTurnRequest = Exclude<
	Awaited<ReturnType<typeof resolveOrchestratorTurnRequest>>,
	Response
>;

type TemporalClient = Awaited<ReturnType<typeof getTemporalClient>>;

export interface PreparedOrchestratorStart {
	workflowInput: Awaited<ReturnType<typeof buildOrchestratorWorkflowInput>>;
	billing: ApiBillingNotice | null;
}

/** A follow-up run signals the turn once (the key lives this long). */
const FOLLOW_UP_DEDUPE_SECONDS = 3600;

/** Filter, bill and build a created turn's start, or the refusal. */
export async function prepareOrchestratorStart(
	caller: Pick<RuntimeCaller, "userId" | "organizationId">,
	turn: ConversationTurn,
	turnRequest: OrchestratorTurnRequest,
	temporalClient: TemporalClient,
): Promise<Response | PreparedOrchestratorStart> {
	const executionId = turn.executionId;
	if (!executionId || !turn.startToken) {
		throw new Error("A created turn carries its execution and start token");
	}
	try {
		const workspaceIds = await filterOrchestratorTurnWorkspaces({
			userId: caller.userId,
			organizationId: caller.organizationId,
			requestedWorkspaceIds: turnRequest.workspaceIds,
		});
		const billed = await billOrchestratorTurn({
			userId: caller.userId,
			organizationId: caller.organizationId,
		});
		if (billed instanceof Response) {
			return billed;
		}
		const workflowInput = await buildOrchestratorWorkflowInput({
			request: turnRequest,
			workspaceIds,
			executionId,
			temporalClient,
		});
		return (
			refuseOversizedOrchestratorInput(workflowInput) ?? {
				workflowInput,
				billing: apiBillingNotice(billed.planPreflight),
			}
		);
	} catch (error) {
		await abandonOrchestratorStart(turn, "refused before start");
		throw error;
	}
}

/** A start that failed: how the run says so (the turn is already settled). */
export function refuseOrchestratorStart(
	error: unknown,
	request: { threadId: string; runId: string },
	stream: RunStream,
): void {
	if (error instanceof TurnStoppedBeforeStartError) {
		stream.emit({
			type: EventType.RUN_STARTED,
			threadId: request.threadId,
			runId: request.runId,
		});
		stream.emit({
			type: EventType.RUN_FINISHED,
			threadId: request.threadId,
			runId: request.runId,
			outcome: { type: "cancelled" },
		});
		return;
	}
	if (error instanceof TurnStartAmbiguousError) {
		refuse(
			stream,
			"TURN_START_UNCONFIRMED",
			"The run's start could not be confirmed; reconnect to check it.",
		);
		return;
	}
	if (error instanceof InvalidBudgetContinuationError) {
		return;
	}
	refuse(stream, "TURN_START_FAILED", buildWorkflowErrorEvent(error).message);
}

export function refuseOrchestratorDisabled(stream: RunStream): void {
	refuse(
		stream,
		"FEATURE_DISABLED",
		"The Orchestrator chat is not enabled on the agent runtime for this organization.",
	);
}

/** End a created turn that will not start (its start token makes this the owner's call). */
export async function abandonOrchestratorStart(
	turn: ConversationTurn,
	reason: string,
	cancelled = false,
): Promise<void> {
	if (!turn.executionId || !turn.startToken) {
		return;
	}
	await abandonConversationTurnStart({
		turnId: turn.id,
		executionId: turn.executionId,
		startToken: turn.startToken,
		cancelled,
		reason,
	}).catch((error: unknown) => {
		console.error("[Agent Runtime] Failed to end an abandoned turn", error);
	});
}

/**
 * Whether this run's follow-up has not been signalled yet: a retried run
 * signals once. Without Redis every run signals, as the follow-up route.
 */
export async function claimFollowUp(
	runId: string,
	organizationId: string,
): Promise<boolean> {
	const redis = getRedisClient();
	if (!redis) {
		return true;
	}
	try {
		const claimed = await redis.set(
			`orch:followup:${organizationId}:${runId}`,
			"1",
			{ nx: true, ex: FOLLOW_UP_DEDUPE_SECONDS },
		);
		return claimed === "OK";
	} catch {
		return true;
	}
}
