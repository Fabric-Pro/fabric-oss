import { type AGUIEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { authorizeAtlasChat } from "@repo/api/modules/atlas/chat-access";
import {
	ATLAS_CHAT_PROCEDURE_PATH,
	type AtlasChatTurnInput,
	assertAtlasChatConversation,
	atlasChatTurnNote,
	startAtlasChat,
} from "@repo/api/modules/atlas/chat-turn";
import { recordProcedureActivity } from "@repo/api/orpc/middleware/audit-activity-middleware";
import { recordProcedureFailure } from "@repo/api/orpc/middleware/audit-error-middleware";
import { isFeatureEnabled } from "@repo/database";
import {
	ATLAS_CHAT_AGENT_ID,
	ATLAS_CHAT_EVENT,
	type AtlasChatProps,
	atlasChatPropsSchema,
} from "@saas/projects/lib/atlas-chat-runtime-protocol";
import {
	type InProcessAdmission,
	InProcessEngine,
	type InProcessRun,
	requestReplyConversation,
} from "./in-process-engine";

/**
 * The Atlas tab's codebase chat on the agent runtime
 * (`atlas-chat-runtime-protocol.ts`): the turn `atlas.chat` streams, run in
 * the request. Served only while `COPILOTKIT_ATLAS_CHAT` is on for the
 * caller's organization.
 *
 * - The thread is an AtlasConversation, which the Atlas service persists:
 *   the question before the answer streams, the answer (or the part of it
 *   that was written) once it ends.
 * - Before RUN_STARTED, and before any model call or write, the run passes
 *   every check `atlas.chat` makes (`authorizeAtlasChat`) and the thread must
 *   name a conversation the caller may write to in this project.
 * - Every refusal from those checks, and every failure to start the chat,
 *   writes the failure row the procedure's audit middleware writes; a
 *   started chat writes its activity row.
 * - An answer still streaming near the runtime route's time limit stops
 *   there, so the service saves the part already written as interrupted and
 *   the run still finishes, where the platform would end the request and
 *   lose the partial answer. `atlas.chat` runs in the oRPC route's longer
 *   window.
 */

export { ATLAS_CHAT_AGENT_ID };

/**
 * How long an answer may stream, counted from the request's start: the
 * runtime route's `maxDuration` less the headroom to save the partial answer
 * and end the run (`stream-max-duration-drift.test.ts`).
 */
const ATLAS_ANSWER_WINDOW_MS = 270000;

export class AtlasChatEngine extends InProcessEngine<
	AtlasChatProps,
	AtlasChatTurnInput
> {
	readonly agentId = ATLAS_CHAT_AGENT_ID;
	protected readonly propsSchema = atlasChatPropsSchema;
	/** The engine is built per request, so this counts from its start. */
	private readonly answerDeadline = Date.now() + ATLAS_ANSWER_WINDOW_MS;

	protected async admit({
		threadId,
		input,
		props,
	}: {
		threadId: string;
		input: RunAgentInput;
		props: AtlasChatProps;
	}): Promise<InProcessAdmission<AtlasChatTurnInput>> {
		const { userId, organizationId, audit } = this.caller;
		if (
			!(await isFeatureEnabled("COPILOTKIT_ATLAS_CHAT", organizationId))
		) {
			return {
				ok: false,
				code: "FEATURE_DISABLED",
				message:
					"The Atlas chat is not enabled on the agent runtime for this organization.",
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
		const turn: AtlasChatTurnInput = {
			projectId: props.projectId,
			repositoryIntegrationId: props.repositoryIntegrationId ?? null,
			mode: props.mode,
			focusNodeKey: props.focusNodeKey,
			conversationId: threadId,
			messages: [
				...conversation.history,
				{ role: "user", content: conversation.question },
			],
		};
		try {
			await authorizeAtlasChat(
				{ userId, organizationId },
				props.projectId,
			);
			// After the project checks, so a caller with no tie to the project
			// hears "Project not found" before any conversation is read; before
			// the thread is taken, so a thread that names someone else's
			// conversation can never hold the owner's.
			await assertAtlasChatConversation(
				{ userId, organizationId },
				{ conversationId: threadId, projectId: props.projectId },
			);
		} catch (error) {
			void recordProcedureFailure(
				error,
				audit,
				{ ...turn, organizationId },
				ATLAS_CHAT_PROCEDURE_PATH,
			);
			// The run ends with the refusal's own code, message and data.
			throw error;
		}
		return { ok: true, turn };
	}

	protected async *turn(
		chat: AtlasChatTurnInput,
		{ runId, signal }: InProcessRun,
	): AsyncIterable<AGUIEvent> {
		const { userId, organizationId, audit } = this.caller;
		const deadline = new AbortController();
		const timer = setTimeout(
			() => deadline.abort(),
			Math.max(0, this.answerDeadline - Date.now()),
		);
		const abortSignal = AbortSignal.any([signal, deadline.signal]);
		try {
			// The `atlas.chat` input, for both audit rows.
			const call = { ...chat, organizationId };
			const { textStream, persistOutcome } = await startAtlasChat(
				{ userId, organizationId },
				{ ...chat, abortSignal },
			).catch((error: unknown) => {
				void recordProcedureFailure(
					error,
					audit,
					call,
					ATLAS_CHAT_PROCEDURE_PATH,
				);
				throw error;
			});
			recordProcedureActivity(audit, {
				path: ATLAS_CHAT_PROCEDURE_PATH,
				input: call,
			});
			const messageId = `${runId}:answer`;
			let opened = false;
			try {
				for await (const delta of textStream) {
					// Stopped, or the client went away: stop reading. Leaving the
					// stream early is what makes the service save the part already
					// written, marked interrupted.
					if (abortSignal.aborted) {
						break;
					}
					// AG-UI refuses an empty delta.
					if (!delta) {
						continue;
					}
					// Opened on the first token, so a reply that fails before one
					// leaves no empty assistant message.
					if (!opened) {
						opened = true;
						yield {
							type: EventType.TEXT_MESSAGE_START,
							messageId,
							role: "assistant",
						};
					}
					yield {
						type: EventType.TEXT_MESSAGE_CONTENT,
						messageId,
						delta,
					};
					// Out of time: stop reading the same way, after the client has
					// everything the service will save.
					if (Date.now() >= this.answerDeadline) {
						deadline.abort();
						break;
					}
				}
			} catch (error) {
				if (!abortSignal.aborted) {
					throw error;
				}
			}
			if (opened) {
				yield { type: EventType.TEXT_MESSAGE_END, messageId };
			}
			const note = atlasChatTurnNote(await persistOutcome);
			if (note) {
				yield {
					type: EventType.CUSTOM,
					name: ATLAS_CHAT_EVENT[note],
					value: {},
				};
			}
		} finally {
			clearTimeout(timer);
		}
	}
}
