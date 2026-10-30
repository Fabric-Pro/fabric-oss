import { type AGUIEvent, EventType } from "@ag-ui/client";
import type { ConversationTurn } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import {
	ORCHESTRATOR_RUN_EVENT,
	type OrchestratorRunState,
} from "@saas/agents/lib/orchestrator-runtime-protocol";
import {
	ChatRunAccessError,
	getAuthorizedChatRun,
} from "@saas/agents/lib/server/chat-run-control";
import { isWorkflowNotFound } from "@saas/agents/lib/server/conversation-turn-admission";
import { subscribeExecutionEvents } from "@saas/agents/lib/server/execution-event-subscriber";
import { z } from "zod";
import { createOrchestratorExecutionObserver } from "../../../../app/api/agents/fabric-ai/orchestrator-temporal/execution-observer";
import { reconcileTurnWithWorkflow } from "../../../../app/api/agents/fabric-ai/orchestrator-temporal/turn-admission";
import type { ApiBillingNotice } from "./direct-turn-record";
import type { RunStream, RuntimeCaller } from "./engine";
import { OrchestratorTranslator } from "./orchestrator-translator";
import { saveOrchestratorTurn } from "./orchestrator-turn-record";
import { refuse } from "./run-errors";

/** The stream route's poll interval. */
const POLL_INTERVAL_MS = 200;
/** How often a follower looks again for a turn whose start is still under way. */
const PENDING_POLL_MS = 500;
/**
 * A response past its window ends at a quiet point: no text segment open,
 * or none for this long. It never runs more than `MAX_OVERRUN_MS` past.
 */
const QUIET_MS = 750;
const MAX_OVERRUN_MS = 20_000;
/** A response that sent nothing for this long sends a heartbeat (the client's silence limit is 45 s). */
const HEARTBEAT_MS = 15_000;

/** The thumbnails a turn's question was sent with, as its start's memo carries them. */
const memoImageUrlsSchema = z.array(z.string()).optional();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How one response opens its run of a turn. */
export interface OrchestratorRunOpening {
	/** The run's input message: the turn's question, or the follow-up that opened it. */
	inputMessage: { id: string; content: string };
	/** The stream route's `started.resumed`: this response attaches to a running turn. */
	resumed: boolean;
	/** The billing header of the run that admitted the turn. */
	billing: ApiBillingNotice | null;
	/** Events after the opening: a follow-up's acknowledgement, a resolved interrupt. */
	announce: AGUIEvent[];
}

/**
 * One response following an Orchestrator turn (`orchestrator-runtime-protocol.ts`):
 * the stream route's Redis events and Temporal poll (`execution-observer.ts`),
 * translated to AG-UI, until the turn ends, it stops on an approval or a
 * clarification, the window ends at a quiet point, or the client goes away.
 * A turn that ended is saved into its conversation before its terminal
 * event is sent. Subscribe before a new turn's start, so its first text is
 * not lost; events that arrive before the run opens are held until it does.
 */
export class OrchestratorTurnFollow {
	private held: AGUIEvent[] | null = [];
	private unsubscribe: () => void = () => {};
	private readonly translator: OrchestratorTranslator;
	private readonly observer: ReturnType<
		typeof createOrchestratorExecutionObserver
	>;
	private readonly executionId: string;
	private readonly threadId: string;
	/** The response, noting when it last sent anything (for the heartbeat). */
	private readonly stream: RunStream;
	private lastSentAt = 0;

	constructor(
		private readonly args: {
			caller: Pick<RuntimeCaller, "userId" | "organizationId">;
			turn: ConversationTurn;
			runId: string;
			stream: RunStream;
			/** Interrupts this run just answered, never raised again by it. */
			decided?: ReadonlySet<string>;
		},
	) {
		const { turn, runId } = args;
		if (!turn.executionId || !turn.conversationId) {
			throw new Error(
				"A followed turn has an execution and a conversation",
			);
		}
		this.executionId = turn.executionId;
		this.threadId = turn.conversationId;
		const stream: RunStream = {
			...args.stream,
			emit: (event) => {
				this.lastSentAt = Date.now();
				args.stream.emit(event);
			},
		};
		this.stream = stream;
		this.translator = new OrchestratorTranslator({
			turnKey: turn.clientRequestKey,
			windowNonce: runId.slice(0, 8) + Date.now().toString(36),
			threadId: this.threadId,
			runId,
			emit: (event) => {
				if (this.held) {
					this.held.push(event);
				} else {
					stream.emit(event);
				}
			},
			decided: args.decided ?? new Set(),
		});
		this.observer = createOrchestratorExecutionObserver({
			emit: (event) => this.translator.apply(event),
			reattach: async () => (await this.authorizedRun()).handle,
		});
	}

	/** Subscribe to the turn's live events (text, tool calls, limit signals). */
	async subscribe(): Promise<void> {
		this.unsubscribe = await subscribeExecutionEvents({
			executionId: this.executionId,
			onEvent: (event) => {
				if (!this.args.stream.isClosed()) {
					this.observer.onExecutionEvent(event);
				}
			},
			logPrefix: "[Agent Runtime] Orchestrator",
		});
	}

	/** Open the run and follow the turn; always ends the subscription. */
	async follow(opening: OrchestratorRunOpening): Promise<void> {
		try {
			await this.followRun(opening);
		} finally {
			this.close();
		}
	}

	/** End the subscription (a turn that will not be followed after all). */
	close(): void {
		this.unsubscribe();
		this.unsubscribe = () => {};
	}

	private authorizedRun() {
		return getAuthorizedChatRun({
			executionId: this.executionId,
			userId: this.args.caller.userId,
			engine: "orchestrator",
			action: "reattach",
			expectedOrganizationId: this.args.caller.organizationId,
		});
	}

	/**
	 * The turn's run, once Temporal has it. A start still under way (another
	 * request is starting the turn) is waited for within the window; a turn
	 * whose workflow never appeared is settled by the shared reconcile.
	 */
	private async runOrRefusal(): Promise<Awaited<
		ReturnType<typeof getAuthorizedChatRun>
	> | null> {
		const { turn } = this.args;
		const stream = this.stream;
		for (;;) {
			try {
				return await this.authorizedRun();
			} catch (error) {
				if (error instanceof ChatRunAccessError) {
					refuse(stream, "FORBIDDEN", "This turn is not accessible.");
					return null;
				}
				if (!isWorkflowNotFound(error)) {
					throw error;
				}
			}
			const settled = await reconcileTurnWithWorkflow({
				turn,
				temporalClient: await getTemporalClient(),
			});
			if (settled === "terminalized") {
				refuse(stream, "TURN_NOT_STARTED", "This turn did not start.");
				return null;
			}
			if (stream.isClosed() || Date.now() >= stream.deadline) {
				refuse(
					stream,
					"TURN_PENDING",
					"The turn has not started yet. Reconnect to follow it.",
				);
				return null;
			}
			await sleep(PENDING_POLL_MS);
		}
	}

	private async followRun(opening: OrchestratorRunOpening): Promise<void> {
		const { turn, runId } = this.args;
		const stream = this.stream;
		const run = await this.runOrRefusal();
		if (!run) {
			return;
		}
		const imageUrls = memoImageUrlsSchema.safeParse(
			run.description.memo?.displayImageUrls,
		);
		this.open(opening);

		let handle = run.handle;
		const translator = this.translator;
		while (!stream.isClosed()) {
			const polled = await this.observer.poll(handle);
			handle = polled.handle;
			const terminal = translator.terminal;
			if (terminal) {
				try {
					await saveOrchestratorTurn(
						{
							turn,
							imageUrls: imageUrls.success
								? imageUrls.data
								: undefined,
							billing: opening.billing,
						},
						terminal,
						translator.facts,
					);
				} catch (error) {
					console.error(
						"[Agent Runtime] Failed to save an Orchestrator turn",
						{
							executionId: this.executionId,
							error,
						},
					);
				}
				translator.finish(terminal);
				return;
			}
			if (translator.stopped || polled.complete) {
				return;
			}
			const now = Date.now();
			if (
				now >= stream.deadline &&
				(!translator.textOpen ||
					now - translator.lastTextAt >= QUIET_MS ||
					now >= stream.deadline + MAX_OVERRUN_MS)
			) {
				// The response ends inside the function's window; the turn goes on.
				translator.close();
				stream.emit({
					type: EventType.CUSTOM,
					name: ORCHESTRATOR_RUN_EVENT.reconnect,
					value: { executionId: this.executionId, runId },
				});
				return;
			}
			if (now - this.lastSentAt >= HEARTBEAT_MS) {
				// A quiet turn (a long tool call) still shows a live response.
				stream.emit({
					type: EventType.CUSTOM,
					name: ORCHESTRATOR_RUN_EVENT.heartbeat,
					value: { executionId: this.executionId },
				});
			}
			await sleep(POLL_INTERVAL_MS);
		}
	}

	/** The run's opening events, then whatever arrived before it. */
	private open(opening: OrchestratorRunOpening): void {
		const { turn, runId } = this.args;
		const stream = this.stream;
		const threadId = this.threadId;
		stream.emit({
			type: EventType.RUN_STARTED,
			threadId,
			runId,
			input: {
				threadId,
				runId,
				messages: [
					{
						id: opening.inputMessage.id,
						role: "user",
						content: opening.inputMessage.content,
					},
				],
				tools: [],
				context: [],
			},
		});
		const state: OrchestratorRunState = {
			executionId: this.executionId,
			turnId: turn.id,
			turnGeneration: turn.generation,
			phase: null,
			routing: null,
			plan: null,
			currentStep: null,
			progress: null,
		};
		stream.emit({ type: EventType.STATE_SNAPSHOT, snapshot: state });
		stream.emit({
			type: EventType.CUSTOM,
			name: ORCHESTRATOR_RUN_EVENT.execution,
			value: {
				executionId: this.executionId,
				turnId: turn.id,
				turnGeneration: turn.generation,
				resumed: opening.resumed,
			},
		});
		if (opening.billing) {
			stream.emit({
				type: EventType.CUSTOM,
				name: ORCHESTRATOR_RUN_EVENT.billing,
				value: opening.billing,
			});
		}
		for (const event of opening.announce) {
			stream.emit(event);
		}
		const held = this.held ?? [];
		this.held = null;
		for (const event of held) {
			stream.emit(event);
		}
	}
}
