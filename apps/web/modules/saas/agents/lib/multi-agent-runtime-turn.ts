import type { RunAgentInput } from "@ag-ui/client";
import {
	connectInput,
	errorMessageOf,
	isAbortError,
	runtimeHeaders,
	streamRuntime,
} from "./direct-runtime-transport";
import {
	type MultiAgentSignal,
	readMultiAgentRuntimeEvent,
} from "./multi-agent-runtime-events";
import {
	AI_USAGE_LIMIT_CODE,
	applyMultiAgentSignal,
	isMultiAgentTurnOver,
	type MultiAgentTurnView,
	stopMultiAgentTurn,
} from "./multi-agent-turn";
import { ORCHESTRATOR_RUNTIME_PATHS } from "./orchestrator-runtime-turn";

/**
 * One multi-agent turn of the Orchestrator chat over the agent runtime: the
 * run that starts it (or answers an agent's approval), then connects to the
 * thread until every agent has ended or every agent left waits on an
 * answer. Each response's signals update the turn's view.
 */

/** Responses one turn may open before it gives up (the single turn's bound). */
const MAX_RESPONSES = 40;
/** Refusals that mean "not yet": the turn is starting or ending. */
const WAIT_REFUSALS = new Set([
	"TURN_PENDING",
	"TURN_START_UNCONFIRMED",
	"TURN_STATE_UNAVAILABLE",
]);
const WAIT_MS = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long an agent's text is held to apply as one change (Nexus's batching). */
const TEXT_BATCH_MS = 50;

export interface MultiAgentRuntimeHost {
	organizationId: string | undefined;
	onView: (view: MultiAgentTurnView) => void;
	/** An agent's tracking-only event (`mcp_default_tool_*`), for analytics. */
	onAnalyticsEvent?: (name: string, payload: Record<string, unknown>) => void;
	/** The AI usage limit stopped the turn or an agent: the refusal's body. */
	onUsageLimit?: (body: unknown) => void;
}

export class MultiAgentRuntimeTurn {
	private controller = new AbortController();
	private following: Promise<void> | null = null;
	/** Text held per agent, applied together after `TEXT_BATCH_MS`. */
	private heldText = new Map<string, string>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		readonly threadId: string,
		private view: MultiAgentTurnView,
		private readonly host: MultiAgentRuntimeHost,
	) {}

	get current(): MultiAgentTurnView {
		return this.view;
	}

	/** Start the turn: the picked agents' ids go in `forwardedProps.multiAgent`. */
	send(args: {
		messages: RunAgentInput["messages"];
		agentIds: string[];
		forwardedProps: Record<string, unknown>;
	}): Promise<void> {
		return this.run({
			threadId: this.threadId,
			runId: this.view.turnKey,
			messages: args.messages,
			tools: [],
			context: [],
			state: {},
			forwardedProps: {
				...args.forwardedProps,
				multiAgent: {
					agents: args.agentIds.map((agentId) => ({ agentId })),
				},
			},
		});
	}

	/** Answer one agent's approval (its scoped interrupt id), then follow the turn again. */
	answer(
		interruptId: string,
		decision: { approved: boolean; feedback?: string },
	): Promise<void> {
		return this.run({
			threadId: this.threadId,
			runId: crypto.randomUUID(),
			messages: [],
			tools: [],
			context: [],
			state: {},
			resume: [
				{
					interruptId,
					status: decision.approved ? "resolved" : "cancelled",
					payload: decision,
				},
			],
		});
	}

	/** Follow a turn already running (after a reload). */
	attach(): Promise<void> {
		return this.run(null);
	}

	/**
	 * Stop every agent of the turn. The agents still answering show as
	 * stopped at once (as Nexus's do); what they send after changes nothing.
	 */
	async stop(): Promise<boolean> {
		this.flushText();
		this.view = stopMultiAgentTurn(this.view, new Date().toISOString());
		this.host.onView(this.view);
		const response = await fetch(
			ORCHESTRATOR_RUNTIME_PATHS.stop(this.threadId),
			{
				method: "POST",
				headers: runtimeHeaders(this.host.organizationId),
				body: JSON.stringify({ runId: this.view.turnKey }),
			},
		).catch(() => null);
		return response?.ok === true;
	}

	/** Stop following (the chat went away); the agents go on. */
	dispose(): void {
		this.controller.abort();
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.heldText.clear();
	}

	private run(first: RunAgentInput | null): Promise<void> {
		const previous = this.following;
		this.controller.abort();
		this.controller = new AbortController();
		const signal = this.controller.signal;
		const following = (async () => {
			await previous?.catch(() => undefined);
			await this.follow(first, signal);
		})();
		this.following = following;
		return following;
	}

	private apply(signal: MultiAgentSignal): void {
		if (
			signal.kind === "agent-event" &&
			signal.event.type === "text_delta"
		) {
			this.holdText(signal.memberKey, signal.event.content);
			return;
		}
		this.flushText();
		this.notify(signal);
		this.view = applyMultiAgentSignal(this.view, signal);
		this.host.onView(this.view);
	}

	/** Side effects a signal carries: analytics, and the usage-limit toast. */
	private notify(signal: MultiAgentSignal): void {
		if (
			signal.kind === "agent-event" &&
			(signal.event.type === "mcp_default_tool_invoked" ||
				signal.event.type === "mcp_default_tool_failed")
		) {
			this.host.onAnalyticsEvent?.(
				signal.event.type,
				signal.event.payload,
			);
		}
		if (
			signal.kind === "agent-ended" &&
			signal.code === AI_USAGE_LIMIT_CODE
		) {
			this.host.onUsageLimit?.(signal.data);
		}
		if (signal.kind === "refused" && signal.code === AI_USAGE_LIMIT_CODE) {
			this.host.onUsageLimit?.(signal.body);
		}
	}

	private holdText(memberKey: string, content: string): void {
		this.heldText.set(
			memberKey,
			(this.heldText.get(memberKey) ?? "") + content,
		);
		this.flushTimer ??= setTimeout(() => {
			this.flushTimer = null;
			this.flushText();
		}, TEXT_BATCH_MS);
	}

	/** Apply the text held for every agent, as one change. */
	private flushText(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.heldText.size === 0) {
			return;
		}
		let view = this.view;
		for (const [memberKey, content] of this.heldText) {
			view = applyMultiAgentSignal(view, {
				kind: "agent-event",
				memberKey,
				event: { type: "text_delta", content },
			});
		}
		this.heldText.clear();
		this.view = view;
		this.host.onView(this.view);
	}

	private async follow(
		first: RunAgentInput | null,
		signal: AbortSignal,
	): Promise<void> {
		let input = first ?? connectInput(this.threadId);
		let url = first
			? ORCHESTRATOR_RUNTIME_PATHS.run
			: ORCHESTRATOR_RUNTIME_PATHS.connect;
		for (let responses = 0; responses < MAX_RESPONSES; responses++) {
			let refusal: string | undefined;
			let settled = false;
			let started = false;
			try {
				await streamRuntime({
					url,
					input,
					organizationId: this.host.organizationId,
					signal,
					onEvent: (event) => {
						for (const next of readMultiAgentRuntimeEvent(event)) {
							if (next.kind === "refused") {
								refusal = next.code;
								if (WAIT_REFUSALS.has(next.code ?? "")) {
									continue;
								}
							}
							if (next.kind === "interrupted") {
								settled = true;
							}
							if (next.kind === "run-started") {
								started = true;
							}
							this.apply(next);
						}
					},
				});
			} catch (error) {
				if (isAbortError(error) || signal.aborted) {
					return;
				}
				this.apply({
					kind: "refused",
					code: undefined,
					message: errorMessageOf(error),
				});
				return;
			}
			if (
				settled ||
				isMultiAgentTurnOver(this.view) ||
				(refusal && !WAIT_REFUSALS.has(refusal))
			) {
				return;
			}
			if (
				!started &&
				!refusal &&
				url === ORCHESTRATOR_RUNTIME_PATHS.connect
			) {
				// Nothing runs on the thread any more: the turn is saved.
				this.apply({ kind: "ended", record: null });
				return;
			}
			if (refusal) {
				await sleep(WAIT_MS);
			}
			if (signal.aborted) {
				return;
			}
			input = connectInput(this.threadId);
			url = ORCHESTRATOR_RUNTIME_PATHS.connect;
		}
		this.apply({
			kind: "refused",
			code: undefined,
			message:
				"The agents' answers could not be followed. They may still be running; reload to see them.",
		});
	}
}
