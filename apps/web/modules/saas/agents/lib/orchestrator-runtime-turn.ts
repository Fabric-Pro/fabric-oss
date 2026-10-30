import type { RunAgentInput } from "@ag-ui/client";
import type { ChatGptPlanApiBilling } from "./chatgpt-plan-api-billing";
import {
	connectInput,
	errorMessageOf,
	isAbortError,
	isRuntimeHttpError,
	runtimePaths,
	streamRuntime,
} from "./direct-runtime-transport";
import {
	type OrchestratorRuntimeSignal,
	readOrchestratorRuntimeEvent,
	savedOrchestratorAnswerEvent,
} from "./orchestrator-runtime-events";
import { ORCHESTRATOR_AGENT_ID } from "./orchestrator-runtime-protocol";
import type { OrchestratorStreamEvent } from "./orchestrator-stream-protocol";
import { waitBeforeResume } from "./orchestrator-stream-types";

export const ORCHESTRATOR_RUNTIME_PATHS = runtimePaths(ORCHESTRATOR_AGENT_ID);

/**
 * The runtime sends at least a heartbeat every 15 s while it follows a turn,
 * so a response silent for three of them is a connection that died without
 * closing; it is handled as any other drop, by connecting again.
 */
const STREAM_SILENCE_LIMIT_MS = 45_000;
/** Drops in a row (no window ended on purpose in between) before the chat gives up. */
const MAX_UNCLEAN_RECONNECTS = 3;
const UNCLEAN_RECONNECT_DELAY_MS = 2_000;
/**
 * Responses one turn may open in all. A window is about four minutes, so
 * this covers the two-hour execution timeout with room for drops.
 */
const MAX_TOTAL_RESPONSES = 40;
/** A refusal that says "not yet" is retried this often, this far apart. */
const MAX_WAIT_RETRIES = 15;
const WAIT_RETRY_DELAY_MS = 2_000;
const WAIT_REFUSALS = new Set([
	"TURN_PENDING",
	"TURN_START_UNCONFIRMED",
	"TURN_STATE_UNAVAILABLE",
	"TURN_STOPPING",
]);
/** How long a stopped turn's response is read on, so the runtime can save it. */
const STOP_DRAIN_MS = 30_000;

const LOST_TURN_MESSAGE =
	"The run's streaming window could not be resumed. The workflow may still be running.";

export type RuntimeRefusal = Extract<
	OrchestratorRuntimeSignal,
	{ kind: "refused" }
>;

/** What a response decided for the answer or follow-up that opened it. */
export type RuntimeDecision =
	| { kind: "accepted" }
	| { kind: "stale" }
	| { kind: "refused"; refusal: RuntimeRefusal }
	| { kind: "failed" };

/** What one turn shows and how its chat settles it. */
export interface RuntimeTurnHost {
	organizationId(): string | undefined;
	/** False once the turn was stopped or let go of: it shows nothing more. */
	isShown(): boolean;
	isStopped(): boolean;
	/** The turn's execution, once its run said. */
	executionId(): string | null;
	applyEvent(event: OrchestratorStreamEvent): void;
	setBilling(apiBilling: ChatGptPlanApiBilling): void;
	setProgress(message: string): void;
	/** A new thread's first run started: its conversation exists. */
	conversationStarted(threadId: string): void;
	fail(reason: string): void;
	/** A send's refusal the chat settles itself; false leaves it a failure. */
	settleRefusal(refusal: RuntimeRefusal): boolean;
}

/**
 * One request on the turn's thread:
 * - `send`: a new message; its response is the turn's from the start, and
 *   one whose outcome is unknown is sent again under the same run id (the
 *   runtime attaches the retry to the turn it may already have started);
 * - `connect`: the thread's running turn;
 * - `answer`: an approval or clarification; its response is the turn's once
 *   its run opens (a refusal leaves the turn waiting);
 * - `follow-up`: its response is the turn's once the runtime acknowledges it.
 */
interface RuntimeRequest {
	kind: "send" | "connect" | "answer" | "follow-up";
	url: string;
	input: RunAgentInput;
	onDecision?: (decision: RuntimeDecision) => void;
}

type ResponseOutcome =
	/** Another response became the turn's. */
	| { kind: "superseded" }
	/** The chat let go of the turn (or a stopped turn's drain ran out). */
	| { kind: "released" }
	| { kind: "ended" }
	| { kind: "interrupted" }
	| { kind: "reconnect" }
	| { kind: "refused"; refusal: RuntimeRefusal }
	| { kind: "lost"; started: boolean; error: unknown };

interface OpenResponse {
	request: RuntimeRequest;
	controller: AbortController;
	adopted: boolean;
	superseded: boolean;
	started: boolean;
	decided: boolean;
	sawEnd: boolean;
	sawInterrupt: boolean;
	sawReconnect: boolean;
	refusal: RuntimeRefusal | null;
	/** Signals that arrived before the response became the turn's. */
	held: OrchestratorRuntimeSignal[];
	outcome: Promise<ResponseOutcome>;
}

function linkAbort(from: AbortSignal, to: AbortController): () => void {
	if (from.aborted) {
		to.abort();
		return () => {};
	}
	const onAbort = () => to.abort();
	from.addEventListener("abort", onAbort, { once: true });
	return () => from.removeEventListener("abort", onAbort);
}

/**
 * One Orchestrator turn followed over the agent runtime: its responses, the
 * reconnects between them, and whichever response (an answer's, a
 * follow-up's) becomes the turn's. One response is the turn's at a time, so
 * no event is applied twice.
 */
export class OrchestratorRuntimeTurn {
	/** The turn's key (a send's run id); an attached turn's comes with its connect. */
	turnKey: string | null;
	/** The run id a stop names; none stops the thread's live turn. */
	stopRunId: string | null;
	ended = false;
	/** The follow loop while it runs (not while the turn waits on an answer). */
	loop: Promise<void> | null = null;
	/** Aborts every response of the turn. */
	private readonly transport = new AbortController();
	private active: OpenResponse | null = null;

	constructor(
		readonly threadId: string,
		turnKey: string | null,
		private newThread: boolean,
		private readonly host: RuntimeTurnHost,
	) {
		this.turnKey = turnKey;
		this.stopRunId = turnKey;
	}

	/** Send the turn's message. */
	send(input: RunAgentInput): void {
		this.open({
			kind: "send",
			url: ORCHESTRATOR_RUNTIME_PATHS.run,
			input,
		});
	}

	/** Follow the thread's running turn. */
	connect(): void {
		this.open(this.connectRequest());
	}

	/** A run whose response decides an answer or a follow-up. */
	request(
		kind: "answer" | "follow-up",
		input: RunAgentInput,
	): Promise<RuntimeDecision> {
		return new Promise((resolve) => {
			this.open({
				kind,
				url: ORCHESTRATOR_RUNTIME_PATHS.run,
				input,
				onDecision: resolve,
			});
		});
	}

	/**
	 * The chat let go of the turn, or stopped it. A stopped turn's response
	 * is read on until the turn ends (the runtime saves it then); anything
	 * else ends now.
	 */
	release(): void {
		if (this.host.isStopped() && !this.ended) {
			setTimeout(() => this.transport.abort(), STOP_DRAIN_MS);
		} else {
			this.transport.abort();
		}
	}

	get released(): boolean {
		return this.transport.signal.aborted;
	}

	private connectRequest(): RuntimeRequest {
		return {
			kind: "connect",
			url: ORCHESTRATOR_RUNTIME_PATHS.connect,
			input: connectInput(this.threadId),
		};
	}

	private decide(response: OpenResponse, decision: RuntimeDecision): void {
		if (response.decided) {
			return;
		}
		response.decided = true;
		response.request.onDecision?.(decision);
	}

	/** One signal of the turn's own response. */
	private apply(
		response: OpenResponse,
		signal: OrchestratorRuntimeSignal,
	): void {
		const shown = this.host.isShown();
		switch (signal.kind) {
			case "event":
				if (
					signal.event.type === "approval_resolved" ||
					signal.event.type === "clarifying_resolved"
				) {
					this.decide(response, { kind: "accepted" });
				}
				if (shown) {
					this.host.applyEvent(signal.event);
				}
				return;
			case "run-started":
				if (response.request.kind === "connect" && !this.turnKey) {
					this.turnKey = signal.runId;
				}
				if (this.newThread && !this.released) {
					this.newThread = false;
					this.host.conversationStarted(this.threadId);
				}
				return;
			case "billing":
				if (shown) {
					this.host.setBilling(signal.apiBilling);
				}
				return;
			case "reconnect":
				response.sawReconnect = true;
				return;
			case "interrupted":
				response.sawInterrupt = true;
				return;
			case "ended":
				response.sawEnd = true;
				this.ended = true;
				return;
			case "follow-up":
				// A send the runtime took as a follow-up into the thread's
				// live turn (another tab's): Stop then stops that turn.
				if (response.request.kind === "send") {
					this.stopRunId = null;
				}
				this.decide(response, { kind: "accepted" });
				return;
			case "stale":
				this.decide(response, { kind: "stale" });
				return;
			case "snapshot":
			case "heartbeat":
			case "refused":
				return;
			default: {
				const unhandled: never = signal;
				console.warn(
					"[OrchestratorRuntime] Unhandled signal",
					unhandled,
				);
			}
		}
	}

	/** Make the response the turn's: the previous one ends, held signals apply. */
	private adopt(response: OpenResponse): void {
		response.adopted = true;
		const previous = this.active;
		this.active = response;
		if (previous && previous !== response) {
			previous.superseded = true;
			previous.controller.abort();
		}
		const held = response.held;
		response.held = [];
		for (const signal of held) {
			this.apply(response, signal);
		}
		if (!this.loop) {
			this.loop = this.follow(response)
				.catch((error: unknown) => {
					console.error(
						"[OrchestratorRuntime] Following a turn failed",
						error,
					);
					this.host.fail(LOST_TURN_MESSAGE);
				})
				.finally(() => {
					this.loop = null;
				});
		}
	}

	private receive(
		response: OpenResponse,
		signal: OrchestratorRuntimeSignal,
	): void {
		if (signal.kind === "refused") {
			response.refusal = signal;
			this.decide(response, { kind: "refused", refusal: signal });
			return;
		}
		if (signal.kind === "snapshot") {
			if (response.request.kind === "connect") {
				this.settleFromSnapshot(signal.messages);
			}
			return;
		}
		if (signal.kind === "run-started") {
			response.started = true;
		}
		if (response.adopted) {
			this.apply(response, signal);
			return;
		}
		response.held.push(signal);
		if (
			(response.request.kind === "answer" &&
				signal.kind === "run-started") ||
			(response.request.kind === "follow-up" &&
				signal.kind === "follow-up")
		) {
			this.adopt(response);
		}
	}

	/** A connect found the turn already saved: show it as saved; the turn is over. */
	private settleFromSnapshot(
		messages: Extract<
			OrchestratorRuntimeSignal,
			{ kind: "snapshot" }
		>["messages"],
	): void {
		const event = savedOrchestratorAnswerEvent(messages, {
			turnKey: this.turnKey,
			executionId: this.host.executionId(),
		});
		if (!event) {
			return;
		}
		this.ended = true;
		if (this.host.isShown()) {
			this.host.applyEvent(event);
		}
	}

	/** Send one request on the thread and read its response. */
	private open(request: RuntimeRequest): OpenResponse {
		const response: OpenResponse = {
			request,
			controller: new AbortController(),
			adopted: false,
			superseded: false,
			started: false,
			decided: false,
			sawEnd: false,
			sawInterrupt: false,
			sawReconnect: false,
			refusal: null,
			held: [],
			outcome: Promise.resolve({ kind: "released" }),
		};
		response.outcome = this.read(response);
		if (request.kind === "send" || request.kind === "connect") {
			this.adopt(response);
		}
		return response;
	}

	private async read(response: OpenResponse): Promise<ResponseOutcome> {
		const { controller, request } = response;
		const unlink = linkAbort(this.transport.signal, controller);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const armSilence = () => {
			clearTimeout(timer);
			timer = setTimeout(
				() => controller.abort(),
				STREAM_SILENCE_LIMIT_MS,
			);
		};
		armSilence();
		let error: unknown = null;
		try {
			await streamRuntime({
				url: request.url,
				input: request.input,
				organizationId: this.host.organizationId(),
				signal: controller.signal,
				onEvent: (event) => {
					armSilence();
					for (const signal of readOrchestratorRuntimeEvent(event)) {
						this.receive(response, signal);
					}
				},
			});
		} catch (caught) {
			error = caught;
		} finally {
			clearTimeout(timer);
			unlink();
		}
		this.decide(response, { kind: "failed" });
		if (response.superseded) {
			return { kind: "superseded" };
		}
		if (this.released) {
			return { kind: "released" };
		}
		if (response.refusal) {
			return { kind: "refused", refusal: response.refusal };
		}
		if (response.sawEnd || this.ended) {
			return { kind: "ended" };
		}
		if (response.sawInterrupt) {
			return { kind: "interrupted" };
		}
		if (response.sawReconnect) {
			return { kind: "reconnect" };
		}
		if (error && !isAbortError(error)) {
			console.warn("[OrchestratorRuntime] A response dropped", error);
		}
		return { kind: "lost", started: response.started, error };
	}

	/**
	 * What a refusal of the turn's own request comes to: the request to send
	 * next (after a wait), or null when the turn is settled.
	 */
	private async afterRefusal(
		request: RuntimeRequest,
		refusal: RuntimeRefusal,
		waits: number,
	): Promise<RuntimeRequest | null> {
		const code = refusal.code;
		if (code && WAIT_REFUSALS.has(code) && waits < MAX_WAIT_RETRIES) {
			if (code !== "TURN_STOPPING") {
				this.host.setProgress("Waiting for the run to start…");
			}
			const aborted = await waitBeforeResume(
				WAIT_RETRY_DELAY_MS,
				this.transport.signal,
			);
			if (aborted) {
				return null;
			}
			return request.kind === "send" ? request : this.connectRequest();
		}
		if (
			this.host.isShown() &&
			!(request.kind === "send" && this.host.settleRefusal(refusal))
		) {
			this.host.fail(refusal.message || "Failed to start orchestrator");
		}
		return null;
	}

	/**
	 * Follow the turn from `first` until it ends, stops on an interrupt, or
	 * the chat lets go of it: connect again whenever a response ends while
	 * the turn goes on, and take whichever response becomes the turn's.
	 */
	private async follow(first: OpenResponse): Promise<void> {
		let current = first;
		let unclean = 0;
		let waits = 0;
		let responses = 1;
		for (;;) {
			const outcome = await current.outcome;
			if (outcome.kind === "superseded" || this.active !== current) {
				if (!this.active || this.active === current) {
					return;
				}
				current = this.active;
				continue;
			}
			// A stopped turn's response was only read to its end.
			if (this.host.isStopped()) {
				return;
			}
			let next: RuntimeRequest | null;
			switch (outcome.kind) {
				case "released":
				case "ended":
				case "interrupted":
					return;
				case "refused":
					next = await this.afterRefusal(
						current.request,
						outcome.refusal,
						waits,
					);
					waits += 1;
					break;
				case "reconnect":
					unclean = 0;
					next = this.connectRequest();
					break;
				case "lost":
					next = await this.afterLoss(
						current.request,
						outcome,
						unclean,
					);
					unclean += 1;
					break;
				default: {
					const unhandled: never = outcome;
					throw new Error(`Unhandled outcome: ${String(unhandled)}`);
				}
			}
			if (!next) {
				return;
			}
			if (this.active !== current && this.active) {
				// An answer or a follow-up became the turn's meanwhile.
				current = this.active;
				continue;
			}
			responses += 1;
			if (responses > MAX_TOTAL_RESPONSES) {
				this.host.fail(LOST_TURN_MESSAGE);
				return;
			}
			current = this.open(next);
		}
	}

	/** A response that ended without saying why: the request to send next, if any. */
	private async afterLoss(
		request: RuntimeRequest,
		outcome: Extract<ResponseOutcome, { kind: "lost" }>,
		unclean: number,
	): Promise<RuntimeRequest | null> {
		if (
			request.kind === "send" &&
			!outcome.started &&
			isRuntimeHttpError(outcome.error)
		) {
			// The endpoint refused the request itself.
			this.host.fail(errorMessageOf(outcome.error));
			return null;
		}
		if (unclean >= MAX_UNCLEAN_RECONNECTS) {
			this.host.fail(LOST_TURN_MESSAGE);
			return null;
		}
		this.host.setProgress("Reconnecting to the running workflow…");
		if (
			await waitBeforeResume(
				UNCLEAN_RECONNECT_DELAY_MS,
				this.transport.signal,
			)
		) {
			return null;
		}
		// A send that never opened its run is sent again: its run id makes
		// the runtime attach to a turn it may have started.
		return request.kind === "send" && !outcome.started
			? request
			: this.connectRequest();
	}
}
