/**
 * The route-owned Proposal `forwardedProps` reach the agent but never the
 * browser, and a thread runs and replays only for the user who started it.
 * Runs the runtime's real in-memory runner, which stamps the run input onto
 * `RUN_STARTED`, streams it, and replays any thread by id on
 * `agent/connect` from one process-wide store.
 */
import {
	InMemoryAgentRunner,
	supportsLocalThreadEndpoints,
} from "@copilotkit/runtime/v2";
import { of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import type { ThreadAccessCheck } from "../proposal-run-runner";

vi.mock("@repo/database", () => ({
	db: {},
	hasProjectAccess: vi.fn(),
	isOrganizationMember: vi.fn(),
	isProposalClientDocument: vi.fn(),
}));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@repo/temporal/proposal-artifact-prompts", () => ({
	findBoundProposalPrompt: vi.fn(),
	loadBoundProposalPromptText: vi.fn(),
}));
vi.mock("@repo/temporal/proposal-artifact-settled-decisions", () => ({
	buildSettledDecisionsBlock: vi.fn(),
}));

const { rewriteAgentRunBody } = await import("../proposal-client-run");
const { ProposalPropsRedactingRunner } = await import("../proposal-run-runner");
const { ThreadOwners } = await import("../thread-owners");

type RunRequest = Parameters<ProposalPropsRedactingRunner["run"]>[0];
type StreamedEvent = { type: string; [key: string]: unknown };

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
const CLARIFYING_POLICY =
	"Clarifying-question policy: BALANCED. Ask the client team before guessing.";
const OWNER = "user-owner";
const OTHER_USER = "user-other";

const MEMBER = {
	mode: "artifact" as const,
	clientPrompt: PROMPT_TEXT,
	settledBlock: SETTLED_BLOCK,
	echoCarried: {
		responseTexts: [SETTLED_ANSWER, PROMPT_TEXT],
		findingTitles: ["Hosting"],
	},
	viewer: "member" as const,
	projectId: "project-1",
	clarifyingPolicy: CLARIFYING_POLICY,
};
const GUEST = {
	mode: "artifact" as const,
	clientPrompt: PROMPT_TEXT,
	settledBlock: null,
	echoCarried: { responseTexts: [PROMPT_TEXT], findingTitles: [] },
	viewer: "guest" as const,
	projectId: "project-1",
	clarifyingPolicy: CLARIFYING_POLICY,
};
const NONE = {
	mode: "none" as const,
	clientPrompt: null,
	settledBlock: null,
	echoCarried: null,
	viewer: null,
	projectId: null,
	clarifyingPolicy: null,
};

let threadSeq = 0;

/**
 * An agent that answers one message and records the parameters it was run
 * with; the runtime builds the agent's HTTP request from those.
 */
function fakeAgent() {
	const runs: Array<Record<string, unknown>> = [];
	const agent = {
		agentId: "project_document_generator",
		messages: [] as unknown[],
		abortRun: vi.fn(),
		async runAgent(
			parameters: Record<string, unknown>,
			subscriber: {
				onEvent?: (args: { event: StreamedEvent }) => void;
				onRunStartedEvent?: (args: unknown) => void;
			},
		) {
			runs.push(parameters);
			const runId = parameters.runId as string;
			const emit = (event: StreamedEvent) =>
				subscriber.onEvent?.({ event });
			emit({ type: "RUN_STARTED", threadId: "t", runId });
			subscriber.onRunStartedEvent?.({});
			emit({
				type: "TEXT_MESSAGE_START",
				messageId: `m-${runId}`,
				role: "assistant",
			});
			emit({
				type: "TEXT_MESSAGE_CONTENT",
				messageId: `m-${runId}`,
				delta: "Done.",
			});
			emit({ type: "TEXT_MESSAGE_END", messageId: `m-${runId}` });
			emit({ type: "RUN_FINISHED", threadId: "t", runId });
			return { result: undefined, newMessages: [] };
		},
	};
	return { agent, runs };
}

function runInput(
	threadId: string,
	config: Parameters<typeof rewriteAgentRunBody>[1],
): RunRequest["input"] {
	const body = rewriteAgentRunBody(
		{
			threadId,
			runId: `run-${threadId}`,
			messages: [
				{ id: `u-${threadId}`, role: "user", content: "Tighten it." },
			],
			tools: [],
			context: [],
			state: { documentType: "PROPOSAL" },
			forwardedProps: { a2uiCatalogAvailable: false },
		},
		config,
	);
	return body as unknown as RunRequest["input"];
}

function collect(
	observable: ReturnType<ProposalPropsRedactingRunner["run"]>,
): Promise<StreamedEvent[]> {
	return new Promise((resolve, reject) => {
		const events: StreamedEvent[] = [];
		observable.subscribe({
			next: (event) => events.push(event as unknown as StreamedEvent),
			error: reject,
			complete: () => resolve(events),
		});
	});
}

/**
 * The saved conversations threads name, by owner: what the route's
 * `readThreadAccess` reads. A thread naming none is absent, as a new
 * conversation's minted id or another chat's thread is.
 */
const conversationOwners = new Map<string, string>();

function threadAccessFor(userId: string): ThreadAccessCheck {
	return async (threadId) => {
		const owner = conversationOwners.get(threadId);
		if (owner === undefined) {
			return { kind: "absent" };
		}
		return owner === userId ? { kind: "owned" } : { kind: "forbidden" };
	};
}

/**
 * The runner one request builds for `userId`; every in-memory runner shares
 * the runtime's process-wide store, as requests do.
 */
function runnerFor(
	userId: string,
	owners?: InstanceType<typeof ThreadOwners>,
): ProposalPropsRedactingRunner {
	return new ProposalPropsRedactingRunner(
		new InMemoryAgentRunner(),
		userId,
		threadAccessFor(userId),
		owners,
	);
}

function nextThreadId(): string {
	return `proposal-runner-${++threadSeq}`;
}

async function runAndReplay(config: Parameters<typeof rewriteAgentRunBody>[1]) {
	const runner = runnerFor(OWNER);
	const threadId = nextThreadId();
	const { agent, runs } = fakeAgent();
	const input = runInput(threadId, config);
	const streamed = await collect(
		runner.run({
			threadId,
			agent: agent as unknown as RunRequest["agent"],
			input,
		}),
	);
	const replayed = await collect(runner.connect({ threadId }));
	return { streamed, replayed, runs, input };
}

function runStartedForwardedProps(events: StreamedEvent[]) {
	const started = events.find((event) => event.type === "RUN_STARTED");
	expect(started).toBeDefined();
	return (started?.input as { forwardedProps?: Record<string, unknown> })
		?.forwardedProps;
}

function expectNoProposalProps(events: StreamedEvent[]) {
	const serialized = JSON.stringify(events);
	for (const key of ROUTE_KEYS) {
		expect(serialized).not.toContain(key);
	}
	expect(serialized).not.toContain(PROMPT_TEXT);
	expect(serialized).not.toContain(CLARIFYING_POLICY);
	expect(serialized).not.toContain("FABRIC_SETTLED_DECISIONS");
	expect(serialized).not.toContain(SETTLED_ANSWER);
}

describe("ProposalPropsRedactingRunner", () => {
	it("keeps a member's prompt, settled block and echo texts out of the stream and the replay", async () => {
		const { streamed, replayed } = await runAndReplay(MEMBER);

		expect(streamed.map((event) => event.type)).toContain(
			"TEXT_MESSAGE_CONTENT",
		);
		expect(replayed.some((event) => event.type === "RUN_STARTED")).toBe(
			true,
		);
		expectNoProposalProps(streamed);
		expectNoProposalProps(replayed);
		// The runner still stamps the input, minus the route's keys.
		expect(runStartedForwardedProps(streamed)).toEqual({
			a2uiCatalogAvailable: false,
		});
		expect(runStartedForwardedProps(replayed)).toEqual({
			a2uiCatalogAvailable: false,
		});
	});

	it("keeps a guest's bound prompt out of the stream and the replay", async () => {
		const { streamed, replayed } = await runAndReplay(GUEST);

		expectNoProposalProps(streamed);
		expectNoProposalProps(replayed);
	});

	it.each([
		["a member", MEMBER],
		["a guest", GUEST],
	])(
		"still runs the agent for %s with every route-owned key",
		async (_who, config) => {
			const { runs, input } = await runAndReplay(config);

			expect(runs).toHaveLength(1);
			expect(runs[0]?.forwardedProps).toEqual(input.forwardedProps);
			expect(runs[0]?.forwardedProps).toMatchObject({
				proposal_mode: "artifact",
				proposal_client_prompt: PROMPT_TEXT,
				proposal_settled_block: config.settledBlock,
				proposal_echo_carried: config.echoCarried,
				proposal_viewer: config.viewer,
				proposal_clarifying_policy: CLARIFYING_POLICY,
				a2uiCatalogAvailable: false,
			});
		},
	);

	it("leaves a mode-none run as it was: the agent gets mode none, the browser the client's own props", async () => {
		const { streamed, replayed, runs } = await runAndReplay(NONE);

		expect(runs[0]?.forwardedProps).toEqual({
			a2uiCatalogAvailable: false,
			proposal_mode: "none",
			proposal_client_prompt: null,
			proposal_settled_block: null,
			proposal_echo_carried: null,
			proposal_viewer: null,
			proposal_attachments: null,
			proposal_clarifying_policy: null,
		});
		expect(runStartedForwardedProps(streamed)).toEqual({
			a2uiCatalogAvailable: false,
		});
		expectNoProposalProps(replayed);
	});

	it("hands a run with no route-owned keys to the inner runner untouched", async () => {
		const finished = { type: "RUN_FINISHED", threadId: "t", runId: "r" };
		const inner = {
			run: vi.fn(() => of(finished)),
			connect: vi.fn(),
			isRunning: vi.fn(),
			stop: vi.fn(),
		};
		const runner = new ProposalPropsRedactingRunner(
			inner as unknown as ConstructorParameters<
				typeof ProposalPropsRedactingRunner
			>[0],
			OWNER,
			threadAccessFor(OWNER),
		);
		const { agent } = fakeAgent();
		const originalRunAgent = agent.runAgent;
		const threadId = nextThreadId();
		const request = {
			threadId,
			agent: agent as unknown as RunRequest["agent"],
			input: {
				threadId,
				runId: "run-untouched",
				messages: [],
				tools: [],
				context: [],
				state: {},
				forwardedProps: { a2uiCatalogAvailable: true },
			} as unknown as RunRequest["input"],
		};

		await expect(collect(runner.run(request))).resolves.toEqual([finished]);
		expect(inner.run).toHaveBeenCalledWith(request);
		expect(agent.runAgent).toBe(originalRunAgent);
	});
});

const THREAD_ACCESS_DENIED = {
	type: "RUN_ERROR",
	message: "Thread access denied",
	code: "THREAD_ACCESS_DENIED",
};

/** A run of the owner's on a fresh thread, finished and stored. */
async function ownerRun() {
	const threadId = nextThreadId();
	const { agent, runs } = fakeAgent();
	await collect(
		runnerFor(OWNER).run({
			threadId,
			agent: agent as unknown as RunRequest["agent"],
			input: runInput(threadId, MEMBER),
		}),
	);
	return { threadId, runs };
}

/**
 * An agent whose run stays open until `finish` is called; `started` settles
 * once the runner has started it.
 */
function openAgent() {
	let finish = () => {};
	let markStarted = () => {};
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const agent = {
		agentId: "project_document_generator",
		messages: [] as unknown[],
		abortRun: vi.fn(() => finish()),
		runAgent: (
			parameters: Record<string, unknown>,
			subscriber: { onEvent?: (args: { event: StreamedEvent }) => void },
		) =>
			new Promise<{ result: undefined; newMessages: [] }>((resolve) => {
				const runId = parameters.runId as string;
				subscriber.onEvent?.({
					event: { type: "RUN_STARTED", threadId: "t", runId },
				});
				markStarted();
				finish = () => {
					subscriber.onEvent?.({
						event: { type: "RUN_FINISHED", threadId: "t", runId },
					});
					resolve({ result: undefined, newMessages: [] });
				};
			}),
	};
	return { agent, started, finish: () => finish() };
}

describe("ProposalPropsRedactingRunner — thread ownership", () => {
	it("replays a thread to the user who started it", async () => {
		const { threadId } = await ownerRun();

		const replayed = await collect(runnerFor(OWNER).connect({ threadId }));

		expect(replayed.map((event) => event.type)).toEqual(
			expect.arrayContaining(["RUN_STARTED", "TEXT_MESSAGE_CONTENT"]),
		);
	});

	it("refuses another user's replay with one access-denied error and none of the thread", async () => {
		const { threadId } = await ownerRun();

		const replayed = await collect(
			runnerFor(OTHER_USER).connect({ threadId }),
		);

		expect(replayed).toEqual([THREAD_ACCESS_DENIED]);
	});

	it("refuses another user's run without running their agent or touching the owner's thread", async () => {
		const { threadId, runs: ownerRuns } = await ownerRun();
		const { agent, runs } = fakeAgent();
		const originalRunAgent = agent.runAgent;

		const streamed = await collect(
			runnerFor(OTHER_USER).run({
				threadId,
				agent: agent as unknown as RunRequest["agent"],
				input: runInput(threadId, GUEST),
			}),
		);

		expect(streamed).toEqual([THREAD_ACCESS_DENIED]);
		expect(runs).toHaveLength(0);
		expect(agent.runAgent).toBe(originalRunAgent);
		expect(ownerRuns).toHaveLength(1);
		await expect(runnerFor(OWNER).isRunning({ threadId })).resolves.toBe(
			false,
		);
		// The owner's replay still holds only the owner's run.
		const replayed = await collect(runnerFor(OWNER).connect({ threadId }));
		expect(
			replayed.filter((event) => event.type === "RUN_STARTED"),
		).toHaveLength(1);
	});

	it("lets the owner run again on their thread", async () => {
		const { threadId } = await ownerRun();
		const { agent, runs } = fakeAgent();

		const streamed = await collect(
			runnerFor(OWNER).run({
				threadId,
				agent: agent as unknown as RunRequest["agent"],
				input: {
					...runInput(threadId, MEMBER),
					runId: `run-${threadId}-2`,
					messages: [],
				},
			}),
		);

		expect(runs).toHaveLength(1);
		expect(streamed.map((event) => event.type)).toContain("RUN_FINISHED");
		const replayed = await collect(runnerFor(OWNER).connect({ threadId }));
		expect(
			replayed.filter((event) => event.type === "RUN_STARTED"),
		).toHaveLength(2);
	});

	it("treats a thread nobody has run as before: an empty replay, then whoever runs first owns it", async () => {
		const threadId = nextThreadId();

		await expect(
			collect(runnerFor(OTHER_USER).connect({ threadId })),
		).resolves.toEqual([]);
		await expect(
			collect(runnerFor(OWNER).connect({ threadId })),
		).resolves.toEqual([]);

		const { agent } = fakeAgent();
		await collect(
			runnerFor(OTHER_USER).run({
				threadId,
				agent: agent as unknown as RunRequest["agent"],
				input: runInput(threadId, NONE),
			}),
		);
		await expect(
			collect(runnerFor(OWNER).connect({ threadId })),
		).resolves.toEqual([THREAD_ACCESS_DENIED]);
	});

	it("never turns on the runtime's thread list, events and clear endpoints, which read the store unchecked", () => {
		expect(supportsLocalThreadEndpoints(runnerFor(OWNER))).toBe(false);
	});

	it("answers another user's stop as no active run and leaves the owner's run going", async () => {
		const threadId = nextThreadId();
		const { agent, started, finish } = openAgent();
		const events = collect(
			runnerFor(OWNER).run({
				threadId,
				agent: agent as unknown as RunRequest["agent"],
				input: runInput(threadId, NONE),
			}),
		);
		await started;

		await expect(runnerFor(OTHER_USER).stop({ threadId })).resolves.toBe(
			false,
		);
		expect(agent.abortRun).not.toHaveBeenCalled();
		await expect(runnerFor(OWNER).isRunning({ threadId })).resolves.toBe(
			true,
		);

		await expect(runnerFor(OWNER).stop({ threadId })).resolves.toBe(true);
		expect(agent.abortRun).toHaveBeenCalledTimes(1);
		finish();
		await events;
	});
});

/** An open run of the owner's on a fresh thread, bound in `owners`. */
async function openOwnerRun(owners: InstanceType<typeof ThreadOwners>) {
	const threadId = nextThreadId();
	const { agent, started, finish } = openAgent();
	const events = collect(
		runnerFor(OWNER, owners).run({
			threadId,
			agent: agent as unknown as RunRequest["agent"],
			input: runInput(threadId, NONE),
		}),
	);
	await started;
	return {
		threadId,
		agent,
		finish: () => {
			finish();
			return events;
		},
	};
}

/** Binds `count` other threads, pushing the oldest entries out. */
function crowdOut(owners: InstanceType<typeof ThreadOwners>, count: number) {
	for (let i = 0; i < count; i++) {
		owners.claim(nextThreadId(), "user-crowd");
	}
}

describe("ProposalPropsRedactingRunner — a running thread the registry's bound dropped", () => {
	it("is replayed and stopped by nobody until the run ends and binds it to its owner again", async () => {
		const owners = new ThreadOwners(2);
		const run = await openOwnerRun(owners);
		const { threadId } = run;
		crowdOut(owners, 2);
		expect(owners.isOwned(threadId)).toBe(false);

		await expect(
			collect(runnerFor(OTHER_USER, owners).connect({ threadId })),
		).resolves.toEqual([THREAD_ACCESS_DENIED]);
		await expect(
			runnerFor(OTHER_USER, owners).stop({ threadId }),
		).resolves.toBe(false);
		expect(run.agent.abortRun).not.toHaveBeenCalled();
		// Its owner can no longer be told apart either, and reloads.
		await expect(
			collect(runnerFor(OWNER, owners).connect({ threadId })),
		).resolves.toEqual([THREAD_ACCESS_DENIED]);

		await run.finish();

		expect(owners.isOwned(threadId)).toBe(true);
		await expect(
			collect(runnerFor(OTHER_USER, owners).connect({ threadId })),
		).resolves.toEqual([THREAD_ACCESS_DENIED]);
		const replayed = await collect(
			runnerFor(OWNER, owners).connect({ threadId }),
		);
		expect(replayed.map((event) => event.type)).toEqual(
			expect.arrayContaining(["RUN_STARTED", "RUN_FINISHED"]),
		);
	});

	it("refuses another user's run on it and binds nothing to them", async () => {
		const owners = new ThreadOwners(2);
		const run = await openOwnerRun(owners);
		const { threadId } = run;
		crowdOut(owners, 2);
		const { agent, runs } = fakeAgent();

		await expect(
			collect(
				runnerFor(OTHER_USER, owners).run({
					threadId,
					agent: agent as unknown as RunRequest["agent"],
					input: runInput(threadId, GUEST),
				}),
			),
		).rejects.toThrow("Thread already running");
		expect(runs).toHaveLength(0);
		expect(owners.isOwned(threadId)).toBe(false);

		await run.finish();
		await expect(
			collect(runnerFor(OTHER_USER, owners).connect({ threadId })),
		).resolves.toEqual([THREAD_ACCESS_DENIED]);
	});
});

describe("ProposalPropsRedactingRunner — running check", () => {
	it("answers false for another user's running thread and the truth for the owner", async () => {
		const owners = new ThreadOwners();
		const run = await openOwnerRun(owners);
		const { threadId } = run;

		await expect(
			runnerFor(OTHER_USER, owners).isRunning({ threadId }),
		).resolves.toBe(false);
		await expect(
			runnerFor(OWNER, owners).isRunning({ threadId }),
		).resolves.toBe(true);

		await run.finish();
		await expect(
			runnerFor(OWNER, owners).isRunning({ threadId }),
		).resolves.toBe(false);
	});
});

describe("ProposalPropsRedactingRunner — a thread that names a saved conversation", () => {
	it("refuses another user's run on someone's conversation nobody has run here, binds nothing, and serves its owner", async () => {
		// Another member can read a shared conversation's id, which is the
		// assistant's thread id.
		const owners = new ThreadOwners();
		const threadId = nextThreadId();
		conversationOwners.set(threadId, OWNER);
		const { agent, runs } = fakeAgent();

		const streamed = await collect(
			runnerFor(OTHER_USER, owners).run({
				threadId,
				agent: agent as unknown as RunRequest["agent"],
				input: runInput(threadId, GUEST),
			}),
		);

		expect(streamed).toEqual([THREAD_ACCESS_DENIED]);
		expect(runs).toHaveLength(0);
		expect(owners.isOwned(threadId)).toBe(false);

		const { agent: ownerAgent, runs: ownerRuns } = fakeAgent();
		await collect(
			runnerFor(OWNER, owners).run({
				threadId,
				agent: ownerAgent as unknown as RunRequest["agent"],
				input: runInput(threadId, MEMBER),
			}),
		);
		expect(ownerRuns).toHaveLength(1);
		const replayed = await collect(
			runnerFor(OWNER, owners).connect({ threadId }),
		);
		expect(replayed.map((event) => event.type)).toContain("RUN_FINISHED");
	});

	it("refuses another user's replay, running check and stop even where the registry has no owner for it", async () => {
		const threadId = nextThreadId();
		conversationOwners.set(threadId, OWNER);
		const { agent, started, finish } = openAgent();
		const events = collect(
			runnerFor(OWNER, new ThreadOwners()).run({
				threadId,
				agent: agent as unknown as RunRequest["agent"],
				input: runInput(threadId, NONE),
			}),
		);
		await started;
		// A registry that never saw the owner's run, as after its bound
		// dropped the thread.
		const unaware = new ThreadOwners();

		await expect(
			collect(runnerFor(OTHER_USER, unaware).connect({ threadId })),
		).resolves.toEqual([THREAD_ACCESS_DENIED]);
		await expect(
			runnerFor(OTHER_USER, unaware).isRunning({ threadId }),
		).resolves.toBe(false);
		await expect(
			runnerFor(OTHER_USER, unaware).stop({ threadId }),
		).resolves.toBe(false);
		expect(agent.abortRun).not.toHaveBeenCalled();
		expect(unaware.isOwned(threadId)).toBe(false);

		finish();
		await events;
		await expect(
			collect(runnerFor(OTHER_USER, unaware).connect({ threadId })),
		).resolves.toEqual([THREAD_ACCESS_DENIED]);
	});
});

describe("ThreadOwners", () => {
	it("keeps a thread with its first user and refuses everyone else", () => {
		const owners = new ThreadOwners();

		expect(owners.claim("thread-1", OWNER)).toBe(true);
		expect(owners.claim("thread-1", OWNER)).toBe(true);
		expect(owners.admits("thread-1", OWNER)).toBe(true);
		expect(owners.claim("thread-1", OTHER_USER)).toBe(false);
		expect(owners.admits("thread-1", OTHER_USER)).toBe(false);
		// Refused claims bind nothing.
		expect(owners.admits("thread-1", OWNER)).toBe(true);
	});

	it("admits anyone to a thread it has never seen, without binding it", () => {
		const owners = new ThreadOwners();

		expect(owners.admits("thread-1", OTHER_USER)).toBe(true);
		expect(owners.claim("thread-1", OWNER)).toBe(true);
		expect(owners.admits("thread-1", OTHER_USER)).toBe(false);
	});

	it("releases a thread only for its owner", () => {
		const owners = new ThreadOwners();
		owners.claim("thread-1", OWNER);

		owners.release("thread-1", OTHER_USER);
		expect(owners.isOwned("thread-1")).toBe(true);
		owners.release("thread-1", OWNER);
		expect(owners.isOwned("thread-1")).toBe(false);
	});

	it("is bounded: past the cap the least recently used thread is forgotten", () => {
		const owners = new ThreadOwners(3);
		owners.claim("thread-1", OWNER);
		owners.claim("thread-2", OWNER);
		owners.claim("thread-3", OWNER);
		// Used again, so thread-2 is now the oldest.
		owners.admits("thread-1", OWNER);

		owners.claim("thread-4", OWNER);

		expect(owners.admits("thread-2", OTHER_USER)).toBe(true);
		for (const threadId of ["thread-1", "thread-3", "thread-4"]) {
			expect(owners.admits(threadId, OTHER_USER)).toBe(false);
		}
	});
});
