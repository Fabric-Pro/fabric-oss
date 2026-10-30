import { type AGUIEvent, EventType, type ResumeEntry } from "@ag-ui/client";
import type { ConversationTurn } from "@repo/database";
import type {
	PendingApprovalInfo,
	PendingClarificationInfo,
} from "@repo/temporal";
import { ORCHESTRATOR_RUN_EVENT } from "@saas/agents/lib/orchestrator-runtime-protocol";
import {
	decideChatRunApproval,
	type getAuthorizedChatRun,
	recordChatRunControlAudit,
} from "@saas/agents/lib/server/chat-run-control";
import { z } from "zod";
import type { RunStream, RuntimeCaller } from "./engine";
import { saveAnsweredClarification } from "./orchestrator-turn-record";
import { refuse } from "./run-errors";

/** The clarify route's bound on an answer (and on an approval's feedback). */
const MAX_CLARIFICATION_CHARS = 10_000;

/** An approval answer: `{ approved, feedback? }`; anything but `approved: true` rejects. */
const approvalAnswerSchema = z.object({
	approved: z.boolean().optional(),
	feedback: z.string().max(MAX_CLARIFICATION_CHARS).optional(),
});
/** A clarification answer: `{ answer }` or `{ dismissed: true }`. */
const clarificationAnswerSchema = z.object({
	answer: z.string().optional(),
	dismissed: z.boolean().optional(),
});

/** What answering a run's interrupt came to. */
export type InterruptAnswerOutcome =
	/** The run was refused; nothing more is sent. */
	| { kind: "refused" }
	/** The answer reached the turn: the event that says so. */
	| { kind: "resolved"; event: AGUIEvent }
	/** The interrupt is no longer pending; nothing was decided. */
	| { kind: "stale" };

/**
 * Answer the live turn's pending approval or clarifying question (the
 * interrupt id names which) with the approve and clarify routes' checks.
 * `allowed` applies the matching route's rate limit (and refuses the run
 * when it is spent).
 */
export async function answerOrchestratorInterrupt(args: {
	caller: RuntimeCaller;
	turn: ConversationTurn;
	run: Awaited<ReturnType<typeof getAuthorizedChatRun>>;
	answer: ResumeEntry;
	stream: RunStream;
	allowed: (route: "approve" | "clarify") => Promise<boolean>;
}): Promise<InterruptAnswerOutcome> {
	const { caller, turn, run, answer, stream } = args;
	const running = run.description.status.name === "RUNNING";
	const [approval, clarification] = running
		? await Promise.all([
				run.handle
					.query<PendingApprovalInfo | null>("pendingApproval")
					.catch(() => null),
				run.handle
					.query<PendingClarificationInfo | null>(
						"pendingClarification",
					)
					.catch(() => null),
			])
		: [null, null];

	if (approval?.approvalId === answer.interruptId) {
		if (!(await args.allowed("approve"))) {
			return { kind: "refused" };
		}
		const payload = approvalAnswerSchema.safeParse(answer.payload ?? {});
		const approved =
			answer.status === "resolved" &&
			payload.success &&
			payload.data.approved === true;
		const outcome = await decideChatRunApproval({
			run,
			userId: caller.userId,
			approvalId: approval.approvalId,
			approved,
			feedback: payload.success ? payload.data.feedback : undefined,
		});
		if (outcome.kind === "older_protocol") {
			refuse(
				stream,
				"APPROVAL_PROTOCOL_OUTDATED",
				"This run uses an older approval protocol. Start a new run to review actions safely.",
			);
			return { kind: "refused" };
		}
		if (outcome.kind === "rejected" && outcome.reason === "forbidden") {
			refuse(stream, "FORBIDDEN", "This thread is not accessible.");
			return { kind: "refused" };
		}
		if (outcome.kind !== "decided") {
			return { kind: "stale" };
		}
		recordChatRunControlAudit(caller.audit, {
			action: "approve",
			organizationId: run.organizationId,
			executionId: run.description.workflowId,
			runId: run.description.runId,
			approvalId: approval.approvalId,
			approved,
		});
		return {
			kind: "resolved",
			event: carried({
				type: "approval_resolved",
				approvalId: approval.approvalId,
				stepId: approval.stepId,
				message: "Approval resolved",
			}),
		};
	}

	if (clarification?.clarificationId === answer.interruptId) {
		if (!(await args.allowed("clarify"))) {
			return { kind: "refused" };
		}
		const payload = clarificationAnswerSchema.safeParse(
			answer.payload ?? {},
		);
		const dismissed =
			answer.status === "cancelled" ||
			(payload.success && payload.data.dismissed === true);
		const text = payload.success ? (payload.data.answer ?? "") : "";
		if (!dismissed && !text.trim()) {
			refuse(
				stream,
				"INVALID_ANSWER",
				"answer (non-empty string) or dismissed:true is required",
			);
			return { kind: "refused" };
		}
		if (text.length > MAX_CLARIFICATION_CHARS) {
			refuse(
				stream,
				"INVALID_ANSWER",
				"Answer must be a string under 10KB",
			);
			return { kind: "refused" };
		}
		await run.handle.signal("clarification", {
			answer: dismissed ? "" : text,
			dismissed,
		});
		console.log("[Agent Runtime] Orchestrator clarification signalled", {
			executionId: turn.executionId,
			dismissed,
			userId: caller.userId,
		});
		if (!dismissed) {
			await saveAnsweredClarification(
				turn,
				clarification.clarificationId,
				{
					question: clarification.question,
					answer: text.trim(),
				},
			).catch((error: unknown) => {
				console.error(
					"[Agent Runtime] Failed to save an Orchestrator clarification",
					{ executionId: turn.executionId, error },
				);
			});
		}
		return {
			kind: "resolved",
			event: carried({
				type: "clarifying_resolved",
				clarificationId: clarification.clarificationId,
			}),
		};
	}

	return { kind: "stale" };
}

/** A stream-route event with no AG-UI counterpart, as the run carries it. */
function carried(
	event:
		| {
				type: "approval_resolved";
				approvalId: string;
				stepId: string;
				message: string;
		  }
		| { type: "clarifying_resolved"; clarificationId: string },
): AGUIEvent {
	return {
		type: EventType.CUSTOM,
		name: ORCHESTRATOR_RUN_EVENT.event,
		value: event,
	};
}
