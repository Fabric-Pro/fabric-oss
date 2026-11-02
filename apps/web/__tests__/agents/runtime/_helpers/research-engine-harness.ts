/**
 * The deep-researcher engine's test harness: ids, the engine and runner for
 * a caller, a run, a resume and a connect through FabricTemporalRunner, and
 * readers and seeds of the in-memory world (`fake-direct-runtime`). A test
 * file mocks the real modules with `fakeWorld` before importing this module.
 */
import {
	type AGUIEvent,
	type BaseEvent,
	EventType,
	type RunAgentInput,
	verifyEvents,
} from "@ag-ui/client";
import { EventSchemas } from "@ag-ui/core/schemas";
import type { DirectChatWorkflowOutput } from "@repo/temporal";
import { FABRIC_AGENT_ID } from "@repo/utils/page-limits";
import { RESEARCH_RUN_EVENT } from "@saas/agents/lib/research-runtime-protocol";
import {
	FabricRuntimeAgent,
	FabricTemporalRunner,
} from "@saas/agents/runtime/fabric-temporal-runner";
import {
	RESEARCH_AGENT_ID,
	ResearchEngine,
} from "@saas/agents/runtime/research-engine";
import { from, lastValueFrom, type Observable, toArray } from "rxjs";
import { expect } from "vitest";
import { type FakeTurn, fakeWorld as w } from "./fake-direct-runtime";
import { researchProgress } from "./research-fixtures";

export const USER = "user-example-1";
export const ORG = "org-example-1";
export const THREAD = "thread-example-0001";
export const OTHER_THREAD = "thread-example-0002";
export const RUN_1 = "run-example-0001";
export const RUN_2 = "run-example-0002";
export const FLAG = "COPILOTKIT_RESEARCH_RUNS";
export const EXECUTION_ID = /^wf-user-example-1-deep-researcher-[0-9a-f-]{36}$/;
export const QUESTION = "How did the market change?";

export const me = { userId: USER, organizationId: ORG };

export const DIRECT_ANSWER: DirectChatWorkflowOutput = {
	success: true,
	responseText: "Here is the answer.",
	usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
};

export function engineFor(caller = me) {
	return new ResearchEngine({ ...caller, audit: { headers: new Headers() } });
}

export function runnerFor(caller = me, streamWindowMs = 60_000) {
	return new FabricTemporalRunner(
		{ [RESEARCH_AGENT_ID]: engineFor(caller) },
		streamWindowMs,
	);
}

function agent() {
	const instance = new FabricRuntimeAgent();
	instance.agentId = RESEARCH_AGENT_ID;
	return instance;
}

function input(
	runId: string,
	message: string | null,
	extra: Partial<RunAgentInput> = {},
): RunAgentInput {
	return {
		threadId: THREAD,
		runId,
		messages: message
			? [{ id: `${runId}:user`, role: "user", content: message }]
			: [],
		tools: [],
		context: [],
		state: {},
		forwardedProps: {},
		...extra,
	};
}

function isAguiEvent(event: BaseEvent): event is AGUIEvent {
	return EventSchemas.safeParse(event).success;
}

/** A response's events, each one a valid AG-UI event. */
async function events(source: Observable<BaseEvent>): Promise<AGUIEvent[]> {
	const collected = await lastValueFrom(source.pipe(toArray()));
	const valid = collected.filter(isAguiEvent);
	expect(valid).toHaveLength(collected.length);
	return valid;
}

/** A whole response, through AG-UI's own lifecycle verification. */
export function verified(list: AGUIEvent[]): Promise<BaseEvent[]> {
	return lastValueFrom(from(list).pipe(verifyEvents(false), toArray()));
}

export function run(
	runId: string,
	message: string | null,
	options: {
		caller?: { userId: string; organizationId: string };
		window?: number;
		extra?: Partial<RunAgentInput>;
	} = {},
) {
	return events(
		runnerFor(options.caller ?? me, options.window).run({
			threadId: THREAD,
			agent: agent(),
			input: input(runId, message, options.extra),
		}),
	);
}

export function resume(
	runId: string,
	interruptId: string,
	payload: unknown,
	window = 0,
) {
	return run(runId, null, {
		window,
		extra: { resume: [{ interruptId, status: "resolved", payload }] },
	});
}

export function connect(window = 0) {
	return events(
		runnerFor(me, window).connect({
			threadId: THREAD,
			agentId: RESEARCH_AGENT_ID,
		}),
	);
}

export const types = (list: AGUIEvent[]) => list.map((event) => event.type);

export function errorOf(list: AGUIEvent[]) {
	const error = list.find((event) => event.type === EventType.RUN_ERROR);
	return error?.type === EventType.RUN_ERROR ? error : undefined;
}

export const errorCode = (list: AGUIEvent[]) => errorOf(list)?.code;

export function finishedOf(list: AGUIEvent[]) {
	const finished = list.find(
		(event) => event.type === EventType.RUN_FINISHED,
	);
	return finished?.type === EventType.RUN_FINISHED ? finished : undefined;
}

export function isEvent(name: string) {
	return (event: AGUIEvent | undefined) =>
		event?.type === EventType.CUSTOM && event.name === name;
}

export const isReconnect = isEvent(RESEARCH_RUN_EVENT.reconnect);

export function turnByKey(key: string) {
	return w.state.turns.find((turn) => turn.clientRequestKey === key);
}

export function executionOf(key: string) {
	const executionId = turnByKey(key)?.executionId;
	if (!executionId) {
		throw new Error(`no execution for ${key}`);
	}
	return executionId;
}

export function workflowOf(key: string) {
	const workflow = w.state.workflows.get(executionOf(key));
	if (!workflow) {
		throw new Error(`no workflow for ${key}`);
	}
	return workflow;
}

export function savedMessages(threadId = THREAD) {
	return w.state.conversations.get(threadId)?.messages ?? [];
}

export function seedConversation(
	owner: { userId: string; organizationId: string },
	threadId = THREAD,
) {
	w.state.conversations.set(threadId, {
		id: threadId,
		...owner,
		agentId: FABRIC_AGENT_ID,
		metadata: { mode: "research" },
		messages: [],
	});
}

/** A live turn of any engine, with its workflow running. */
export function seedLiveTurn(
	key: string,
	executionMode: string,
	conversationId = THREAD,
): FakeTurn {
	const now = new Date();
	const turn: FakeTurn = {
		id: `turn-${key}`,
		userId: USER,
		organizationId: ORG,
		conversationId,
		clientRequestKey: key,
		executionId: `execution-${key}`,
		executionMode,
		status: "ACTIVE",
		startToken: null,
		questionText: "Earlier question",
		createdAt: now,
		updatedAt: now,
		generation: 1,
	};
	w.state.turns.push(turn);
	w.state.workflows.set(turn.executionId ?? "", {
		status: "RUNNING",
		memo: { ...me },
		runId: `temporal-run-${key}`,
	});
	return turn;
}

/** A live research run on THREAD (RUN_1), its response ended at the window. */
export async function liveRun(progress = researchProgress()) {
	w.state.onStart = () => ({
		status: "RUNNING",
		progress,
		queries: { subAgentResults: [] },
	});
	await run(RUN_1, QUESTION, { window: 0 });
}
