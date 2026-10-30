import {
	AbstractAgent,
	type AGUIEvent,
	type AgentCapabilities,
	type BaseEvent,
	EventType,
	type RunAgentInput,
} from "@ag-ui/client";
import {
	AgentRunner,
	type AgentRunnerConnectRequest,
	type AgentRunnerIsRunningRequest,
	type AgentRunnerRunRequest,
	type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { Observable } from "rxjs";
import type { RunStream, RuntimeEngine } from "./engine";

/**
 * The longest one SSE response tails a run before it tells the client to
 * reconnect: below the endpoint's function window, so a response always ends
 * on its own terms. The run itself is unaffected.
 */
const MAX_STREAM_WINDOW_MS = 60000;
const MIN_STREAM_WINDOW_MS = 1000;

/**
 * The stream window for one request: `AGENT_RUNTIME_STREAM_WINDOW_MS` when
 * set, and a request may only shorten it (`x-agent-runtime-stream-window-ms`,
 * so a test can force a reconnect); never above `ceiling`
 * (`MAX_STREAM_WINDOW_MS` unless an engine has its own).
 */
export function resolveStreamWindowMs(
	requested: string | null,
	ceiling: number = MAX_STREAM_WINDOW_MS,
): number {
	const configured =
		Number(requested) || Number(process.env.AGENT_RUNTIME_STREAM_WINDOW_MS);
	return Number.isFinite(configured) && configured > 0
		? Math.min(Math.max(configured, MIN_STREAM_WINDOW_MS), ceiling)
		: ceiling;
}

/**
 * The agent the runtime registers for each engine. CopilotKit clones it per
 * request and hands it to the runner, which runs every turn on Temporal, so
 * its own `run` is never reached.
 */
export class FabricRuntimeAgent extends AbstractAgent {
	run(_input: RunAgentInput): Observable<BaseEvent> {
		return new Observable<BaseEvent>((subscriber) => {
			subscriber.error(
				new Error(
					`${this.agentId ?? "This agent"} runs through FabricTemporalRunner`,
				),
			);
		});
	}

	async getCapabilities(): Promise<AgentCapabilities> {
		return {
			transport: { streaming: true, resumable: true },
			state: { snapshots: true, deltas: true },
			reasoning: { supported: true, streaming: true },
			humanInTheLoop: {
				supported: true,
				approvals: true,
				interrupts: true,
			},
		};
	}
}

/**
 * An Observable for one SSE response. `produce` runs once per subscription;
 * the stream's `isClosed` turns true when the client goes away, which never
 * cancels the run behind it.
 */
function runStream(
	streamWindowMs: number,
	produce: (stream: RunStream) => Promise<void>,
): Observable<BaseEvent> {
	return new Observable<BaseEvent>((subscriber) => {
		let closed = false;
		produce({
			emit: (event) => {
				if (!closed) {
					subscriber.next(event);
				}
			},
			isClosed: () => closed,
			deadline: Date.now() + streamWindowMs,
		}).then(
			() => subscriber.complete(),
			(error: unknown) => subscriber.error(error),
		);
		return () => {
			closed = true;
		};
	});
}

/**
 * CopilotKit's runner for Fabric's chat engines: every run is a Temporal
 * workflow the engine starts and observes, so the workflow, not the HTTP
 * response, owns the turn. A response tails it for at most the stream window
 * and the client reconnects with `connect`; a closed response never cancels
 * it; only `stop` does.
 *
 * Built per request for the authenticated caller (the endpoint binds it into
 * each engine). Engines are picked by the runtime agent id for a run or a
 * connect; a stop or an `isRunning`, which CopilotKit asks by thread only,
 * goes to each engine in turn, and each answers only for its own turns.
 *
 * With a `fallback` runner (CopilotKit's in-memory one on `/api/copilotkit`),
 * an agent no engine serves runs and connects there as before, and a stop or
 * an `isRunning` no engine answers goes there last. Without one, such an
 * agent is refused with `UNKNOWN_AGENT`.
 */
export class FabricTemporalRunner extends AgentRunner {
	constructor(
		private readonly engines: Readonly<Record<string, RuntimeEngine>>,
		private readonly streamWindowMs: number,
		private readonly fallback?: AgentRunner,
	) {
		super();
	}

	run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
		const engine = this.engineFor(request.agent.agentId);
		if (!engine && this.fallback) {
			return this.fallback.run(request);
		}
		return runStream(this.windowFor(engine), async (stream) => {
			if (engine) {
				await engine.run(
					{
						threadId: request.threadId,
						input: request.input,
						agent: request.agent,
					},
					stream,
				);
			} else {
				stream.emit(unknownAgent(request.agent.agentId));
			}
		});
	}

	connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
		const engine = this.engineFor(request.agentId);
		if (!engine && this.fallback) {
			return this.fallback.connect(request);
		}
		return runStream(this.windowFor(engine), async (stream) => {
			if (engine) {
				await engine.connect(request.threadId, stream);
			} else {
				stream.emit(unknownAgent(request.agentId));
			}
		});
	}

	async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
		for (const engine of Object.values(this.engines)) {
			if (await engine.isRunning(request.threadId)) {
				return true;
			}
		}
		return this.fallback ? this.fallback.isRunning(request) : false;
	}

	async stop(request: AgentRunnerStopRequest): Promise<boolean> {
		for (const engine of Object.values(this.engines)) {
			if (await engine.stop(request.threadId, request.runId)) {
				return true;
			}
		}
		return (await this.fallback?.stop(request)) ?? false;
	}

	private windowFor(engine: RuntimeEngine | null): number {
		return engine?.streamWindowMs ?? this.streamWindowMs;
	}

	private engineFor(agentId: string | undefined): RuntimeEngine | null {
		return agentId && Object.hasOwn(this.engines, agentId)
			? this.engines[agentId]
			: null;
	}
}

function unknownAgent(agentId: string | undefined): AGUIEvent {
	return {
		type: EventType.RUN_ERROR,
		message: `Unknown agent: ${agentId ?? "(none)"}`,
		code: "UNKNOWN_AGENT",
	};
}
