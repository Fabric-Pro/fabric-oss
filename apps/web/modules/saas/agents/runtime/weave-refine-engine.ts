import { type AGUIEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { streamText } from "@repo/ai";
import {
	type AuthorizedProject,
	runWithAuthorizedProject,
} from "@repo/api/lib/authorized-project-binding";
import {
	authorizeRefineRun,
	buildRefinePrompt,
	REFINE_PROCEDURE_PATH,
	type RefineHistoryEntry,
	resolveRefineModel,
} from "@repo/api/modules/weave/lib/refine-request-turn";
import {
	parseRefineResponse,
	REFINE_SYSTEM_PROMPT,
	refineFeedbackPreview,
} from "@repo/api/modules/weave/lib/refine-response";
import { recordProcedureActivity } from "@repo/api/orpc/middleware/audit-activity-middleware";
import { recordProcedureFailure } from "@repo/api/orpc/middleware/audit-error-middleware";
import { isFeatureEnabled } from "@repo/database";
import {
	WEAVE_REFINE_AGENT_ID,
	WEAVE_REFINE_EVENT,
	type WeaveRefineProps,
	weaveRefinePropsSchema,
} from "@saas/weave/lib/weave-refine-runtime-protocol";
import {
	type InProcessAdmission,
	InProcessEngine,
	type InProcessRun,
	requestReplyConversation,
} from "./in-process-engine";

/**
 * Create Plan's "Refine request with AI" on the agent runtime
 * (`weave-refine-runtime-protocol.ts`): the turn `weave.plans.refine` answers
 * in one reply, with the feedback streamed. Served only while
 * `COPILOTKIT_WEAVE_REFINE_CHAT` is on for the caller's organization, and
 * only after the procedure's own checks (`authorizeRefineRun`), before any
 * model call. The prompt, model, parsing and usage recording are the
 * procedure's; so are its audit rows, written here because no oRPC chain
 * runs: the success row once the model replied, and the error row for a
 * refused or failed turn. Nothing is saved.
 */

export { WEAVE_REFINE_AGENT_ID };

interface WeaveRefineRequest {
	projectId: string;
	currentMessage: string;
	refinementInput: string;
	history: RefineHistoryEntry[];
}

interface WeaveRefineTurn extends WeaveRefineRequest {
	/** The project the procedure's checks authorized; its error rows carry it. */
	authorized: AuthorizedProject;
	/** The organization the turn runs and bills in, as the procedure resolves it. */
	organizationId: string | undefined;
}

export class WeaveRefineEngine extends InProcessEngine<
	WeaveRefineProps,
	WeaveRefineTurn
> {
	readonly agentId = WEAVE_REFINE_AGENT_ID;
	protected readonly propsSchema = weaveRefinePropsSchema;

	protected async admit({
		input,
		props,
	}: {
		input: RunAgentInput;
		props: WeaveRefineProps;
	}): Promise<InProcessAdmission<WeaveRefineTurn>> {
		const { userId, organizationId } = this.caller;
		if (
			!(await isFeatureEnabled(
				"COPILOTKIT_WEAVE_REFINE_CHAT",
				organizationId,
			))
		) {
			return {
				ok: false,
				code: "FEATURE_DISABLED",
				message:
					"Weave plan refinement is not enabled on the agent runtime for this organization.",
			};
		}
		const conversation = requestReplyConversation(input.messages);
		if (!conversation) {
			return {
				ok: false,
				code: "NO_MESSAGE",
				message: "A run needs a new user message.",
			};
		}
		const request: WeaveRefineRequest = {
			projectId: props.projectId,
			currentMessage: props.currentMessage,
			refinementInput: conversation.question,
			history: conversation.history,
		};
		// A refusal is thrown on with the procedure's code and message, which
		// reach the run's error.
		const { authorized, organizationId: runOrganizationId } =
			await authorizeRefineRun({
				userId,
				organizationId,
				projectId: props.projectId,
				onRefusal: (error) => this.auditFailure(error, request),
			});
		return {
			ok: true,
			turn: { ...request, authorized, organizationId: runOrganizationId },
		};
	}

	protected async *turn(
		turn: WeaveRefineTurn,
		run: InProcessRun,
	): AsyncIterable<AGUIEvent> {
		try {
			yield* this.reply(turn, run);
		} catch (error) {
			// The project stays bound for the procedure's whole call.
			runWithAuthorizedProject(turn.authorized, () =>
				this.auditFailure(error, turn),
			);
			throw error;
		}
	}

	private async *reply(
		turn: WeaveRefineTurn,
		{ runId, signal }: InProcessRun,
	): AsyncIterable<AGUIEvent> {
		const prompt = await buildRefinePrompt(turn);
		const model = await resolveRefineModel({
			userId: this.caller.userId,
			organizationId: turn.organizationId,
		});
		const messageId = `${runId}:feedback`;
		yield {
			type: EventType.TEXT_MESSAGE_START,
			messageId,
			role: "assistant",
		};
		// A failed request ends the stream with an error part, not a throw.
		let streamError: unknown;
		const result = streamText({
			model,
			instructions: REFINE_SYSTEM_PROMPT,
			prompt,
			onError: ({ error }) => {
				streamError ??= error;
			},
		});
		let text = "";
		let shown = "";
		try {
			for await (const delta of result.textStream) {
				// After a stop or a closed response the browser is sent
				// nothing more, but the request already made runs to its end
				// and is recorded.
				text += delta;
				const preview = refineFeedbackPreview(text);
				if (!signal.aborted && preview.length > shown.length) {
					yield {
						type: EventType.TEXT_MESSAGE_CONTENT,
						messageId,
						delta: preview.slice(shown.length),
					};
					shown = preview;
				}
			}
		} catch (error) {
			streamError ??= error;
		}
		if (streamError) {
			yield { type: EventType.TEXT_MESSAGE_END, messageId };
			throw streamError;
		}
		const parsed = parseRefineResponse(text, turn.currentMessage);
		// The preview is always a prefix of the parsed feedback; a reply that
		// never named its feedback is sent whole here.
		const rest = parsed.feedback.slice(shown.length);
		if (rest && !signal.aborted) {
			yield {
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId,
				delta: rest,
			};
		}
		yield { type: EventType.TEXT_MESSAGE_END, messageId };
		recordProcedureActivity(this.caller.audit, {
			path: REFINE_PROCEDURE_PATH,
			input: {
				organizationId: turn.organizationId ?? null,
				projectId: turn.projectId,
			},
		});
		if (!signal.aborted) {
			yield {
				type: EventType.CUSTOM,
				name: WEAVE_REFINE_EVENT.result,
				value: {
					updatedMessage: parsed.updatedMessage,
					isReady: parsed.isReady,
				},
			};
		}
	}

	/**
	 * The procedure's error row, with the body it would have received;
	 * `recordProcedureFailure` redacts the person's text by path. Called
	 * where the procedure's binding would be, so the row names the same
	 * project and organization.
	 */
	private auditFailure(error: unknown, request: WeaveRefineRequest): void {
		void recordProcedureFailure(
			error,
			this.caller.audit,
			{
				projectId: request.projectId,
				organizationId: this.caller.organizationId,
				currentMessage: request.currentMessage,
				refinementInput: request.refinementInput,
				history: request.history,
			},
			REFINE_PROCEDURE_PATH,
		);
	}
}
