// @vitest-environment node
/**
 * The Proposal chat's route-owned `forwardedProps` on durable runs
 * (`durable-runs.ts`), with the route's own in-memory runner
 * (`proposal-run-runner.ts`) as the in-process runner:
 *
 *   - a durable run parks the run input, keys included, for the worker,
 *     which hands it to the agent; the workflow's input and memo, which
 *     Temporal keeps in its history, carry none of them;
 *   - when the durable path cannot take the run (Redis unavailable, a
 *     workflow that cannot start), the agent runs in-process on the route's
 *     runner: it still receives the keys, and neither the events streamed to
 *     the browser nor a later replay of the thread carries them.
 *
 * Redis, Temporal and the conversation table are the durable engine's
 * in-memory fakes (`__tests__/agents/runtime/_helpers/fake-ag-ui-runtime`).
 */
import { type BaseEvent, EventType } from "@ag-ui/client";
import { InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import { openAgUiRunStore } from "@repo/temporal/agui-run-stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAgUiWorld as w } from "../../../../__tests__/agents/runtime/_helpers/fake-ag-ui-runtime";

vi.mock(
	"@repo/temporal",
	async () =>
		(
			await import(
				"../../../../__tests__/agents/runtime/_helpers/fake-ag-ui-runtime"
			)
		).fakeAgUiWorld.temporal,
);
vi.mock("@repo/temporal/agui-run-stream", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@repo/temporal/agui-run-stream")>();
	const { fakeAgUiWorld } = await import(
		"../../../../__tests__/agents/runtime/_helpers/fake-ag-ui-runtime"
	);
	return {
		...actual,
		openAgUiRunStore: vi.fn(fakeAgUiWorld.openAgUiRunStore),
	};
});
vi.mock(
	"@saas/agents/runtime/thread",
	async () =>
		(
			await import(
				"../../../../__tests__/agents/runtime/_helpers/fake-ag-ui-runtime"
			)
		).fakeAgUiWorld.thread,
);
vi.mock("@repo/database", () => ({
	db: {},
	hasProjectAccess: vi.fn(),
	isOrganizationMember: vi.fn(),
	isProposalClientDocument: vi.fn(),
	isFeatureEnabled: async () => true,
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/temporal/proposal-artifact-prompts", () => ({
	findBoundProposalPrompt: vi.fn(),
	loadBoundProposalPromptText: vi.fn(),
}));
vi.mock("@repo/temporal/proposal-artifact-settled-decisions", () => ({
	buildSettledDecisionsBlock: vi.fn(),
}));

const { copilotDurableRuntime } = await import("../durable-runs");
const { rewriteAgentRunBody } = await import("../proposal-client-run");
const { ProposalPropsRedactingRunner } = await import("../proposal-run-runner");

type RunRequest = Parameters<
	InstanceType<typeof ProposalPropsRedactingRunner>["run"]
>[0];

const USER = "user-example-1";
const ORG = "org-example-1";
const DURABLE_AGENT = "project_document_generator";
const PROMPT_TEXT =
	"Write for the client reader. Change only what is asked and keep every heading.";
const SETTLED_BLOCK =
	"<<<FABRIC_SETTLED_DECISIONS>>>\n- Hosting: the client hosts it\n<<<END_FABRIC_SETTLED_DECISIONS>>>";
const SETTLED_ANSWER = "the client hosts it";
const ROUTE_KEYS = [
	"proposal_mode",
	"proposal_client_prompt",
	"proposal_settled_block",
	"proposal_echo_carried",
	"proposal_viewer",
	"proposal_attachments",
	"proposal_clarifying_policy",
];
const MEMBER = {
	mode: "artifact" as const,
	clientPrompt: PROMPT_TEXT,
	settledBlock: SETTLED_BLOCK,
	echoCarried: {
		responseTexts: [SETTLED_ANSWER],
		findingTitles: ["Hosting"],
	},
	viewer: "member" as const,
	projectId: "project-1",
	clarifyingPolicy:
		"Clarifying-question policy: BALANCED. Ask the client team before guessing.",
};
const SETTINGS = {
	modelHints: { model: "example-model" },
	aiToken: "route-minted-ai-token",
};

let threadSeq = 0;

function nextThreadId(): string {
	threadSeq += 1;
	return `durable-proposal-thread-${threadSeq}`;
}

/** The run input as the route hands it to the runtime: rewritten. */
function runInput(threadId: string): RunRequest["input"] {
	return rewriteAgentRunBody(
		{
			threadId,
			runId: `${threadId}-run`,
			messages: [
				{
					id: `${threadId}-question`,
					role: "user",
					content: "Tighten it.",
				},
			],
			tools: [],
			context: [],
			state: { documentType: "PROPOSAL" },
			forwardedProps: {},
		},
		MEMBER,
	) as unknown as RunRequest["input"];
}

/** The durable agent, answering in-process and recording what it was run with. */
function fakeAgent() {
	const runs: Array<Record<string, unknown>> = [];
	const agent = {
		agentId: DURABLE_AGENT,
		messages: [] as unknown[],
		abortRun: vi.fn(),
		async runAgent(
			parameters: Record<string, unknown>,
			subscriber: {
				onEvent?: (args: { event: BaseEvent }) => void;
				onRunStartedEvent?: (args: unknown) => void;
			},
		) {
			runs.push(parameters);
			const runId = parameters.runId as string;
			const emit = (event: BaseEvent) => subscriber.onEvent?.({ event });
			emit({ type: EventType.RUN_STARTED, threadId: "t", runId });
			subscriber.onRunStartedEvent?.({});
			emit({
				type: EventType.TEXT_MESSAGE_START,
				messageId: `${runId}-answer`,
				role: "assistant",
			});
			emit({
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: `${runId}-answer`,
				delta: "Done.",
			});
			emit({
				type: EventType.TEXT_MESSAGE_END,
				messageId: `${runId}-answer`,
			});
			emit({ type: EventType.RUN_FINISHED, threadId: "t", runId });
			return { result: undefined, newMessages: [] };
		},
	};
	return { agent: agent as unknown as RunRequest["agent"], runs };
}

/** The route's runner for this request, and the durable runtime over it. */
async function routeRuntime() {
	const caller = { userId: USER, organizationId: ORG };
	const inProcess = new ProposalPropsRedactingRunner(
		new InMemoryAgentRunner(),
		USER,
		(threadId) => w.thread.readThreadAccess(threadId, caller),
	);
	const durable = await copilotDurableRuntime(caller, SETTINGS, inProcess);
	if (!durable) {
		throw new Error("durable runs are off for the organization");
	}
	return durable.runner;
}

function collect(
	events: ReturnType<
		InstanceType<typeof ProposalPropsRedactingRunner>["run"]
	>,
): Promise<BaseEvent[]> {
	return new Promise((resolve, reject) => {
		const seen: BaseEvent[] = [];
		events.subscribe({
			next: (event) => seen.push(event),
			error: reject,
			complete: () => resolve(seen),
		});
	});
}

function expectNoRouteKeys(events: BaseEvent[]) {
	expect(events.length).toBeGreaterThan(0);
	const text = JSON.stringify(events);
	expect(text).not.toContain(PROMPT_TEXT);
	expect(text).not.toContain(SETTLED_ANSWER);
	for (const key of ROUTE_KEYS) {
		expect(text).not.toContain(key);
	}
}

function expectRouteKeysDelivered(forwardedProps: unknown) {
	expect(forwardedProps).toEqual(
		expect.objectContaining({
			proposal_mode: "artifact",
			proposal_client_prompt: PROMPT_TEXT,
			proposal_settled_block: SETTLED_BLOCK,
			proposal_echo_carried: MEMBER.echoCarried,
			proposal_viewer: "member",
			proposal_clarifying_policy: MEMBER.clarifyingPolicy,
		}),
	);
}

beforeEach(() => {
	w.reset();
	vi.mocked(openAgUiRunStore).mockClear();
});

describe("durable runs and the Proposal chat's route-owned keys", () => {
	it("parks them for the worker's agent and keeps them out of the workflow's history", async () => {
		const runner = await routeRuntime();
		const threadId = nextThreadId();
		const input = runInput(threadId);
		// The worker's stream for the run, as `RunEventWriter` writes it.
		w.appendEvent(input.runId, {
			type: EventType.RUN_STARTED,
			threadId,
			runId: input.runId,
		});
		w.appendEvent(input.runId, {
			type: EventType.RUN_FINISHED,
			threadId,
			runId: input.runId,
		});
		const { agent, runs } = fakeAgent();

		await collect(runner.run({ threadId, agent, input }));

		// What the activity reads by reference and hands the agent.
		const [parked] = [...w.state.inputs.values()];
		expectRouteKeysDelivered(parked?.input.forwardedProps);
		// Temporal's history: the workflow's input and memo.
		expect(w.state.starts).toHaveLength(1);
		const history = JSON.stringify(w.state.starts);
		expect(history).not.toContain(PROMPT_TEXT);
		expect(history).not.toContain(SETTINGS.aiToken);
		for (const key of ROUTE_KEYS) {
			expect(history).not.toContain(key);
		}
		// The durable path never ran the agent here.
		expect(runs).toEqual([]);
	});

	it("still hands them to the agent, and never to the browser, when Redis is unavailable", async () => {
		const runner = await routeRuntime();
		const threadId = nextThreadId();
		const { agent, runs } = fakeAgent();
		vi.mocked(openAgUiRunStore).mockRejectedValueOnce(
			new Error("Redis unavailable"),
		);

		const streamed = await collect(
			runner.run({ threadId, agent, input: runInput(threadId) }),
		);

		expect(runs).toHaveLength(1);
		expectRouteKeysDelivered(runs[0]?.forwardedProps);
		expectNoRouteKeys(streamed);
		expect(streamed.map((event) => event.type)).toContain(
			EventType.RUN_FINISHED,
		);

		vi.mocked(openAgUiRunStore).mockRejectedValueOnce(
			new Error("Redis unavailable"),
		);
		const replayed = await collect(
			runner.connect({ threadId, agentId: DURABLE_AGENT }),
		);
		expectNoRouteKeys(replayed);
	});

	it("still hands them to the agent, and never to the browser, when the workflow cannot start", async () => {
		const runner = await routeRuntime();
		const threadId = nextThreadId();
		const { agent, runs } = fakeAgent();
		w.state.startError = new Error("Temporal unavailable");

		const streamed = await collect(
			runner.run({ threadId, agent, input: runInput(threadId) }),
		);

		expect(runs).toHaveLength(1);
		expectRouteKeysDelivered(runs[0]?.forwardedProps);
		expectNoRouteKeys(streamed);

		// No durable run was recorded, so the replay is the in-process one.
		const replayed = await collect(
			runner.connect({ threadId, agentId: DURABLE_AGENT }),
		);
		expectNoRouteKeys(replayed);
	});
});
