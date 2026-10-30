/**
 * An in-memory world for the durable AG-UI engine's tests: the run store
 * (Redis streams, input records, thread records), Temporal's workflow
 * client, and the conversation reads the engine makes through
 * `runtime/thread`.
 *
 * The "worker" is the test itself: it appends events to a run's stream with
 * `appendEvent` and settles workflows with `settleWorkflow`. A blocking read
 * waits for the next append or its timeout, as `XREAD BLOCK` does.
 */
import type { BaseEvent } from "@ag-ui/client";
import type {
	AgUiRunInputRecord,
	AgUiRunStore,
	AgUiThreadRecord,
	StoredRunEvent,
} from "@repo/temporal/agui-run-stream";

type WorkflowStatus =
	| "RUNNING"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "TERMINATED";

interface FakeWorkflow {
	status: WorkflowStatus;
	memo: Record<string, unknown>;
	args: unknown[];
}

interface FakeConversation {
	userId: string;
	organizationId: string;
	messages: Array<{ id: string }>;
	/** The conversation this one continues (a spill or a fork). */
	parentConversationId?: string;
}

const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

const state = {
	inputs: new Map<string, AgUiRunInputRecord>(),
	streams: new Map<string, StoredRunEvent[]>(),
	threads: new Map<string, AgUiThreadRecord>(),
	workflows: new Map<string, FakeWorkflow>(),
	conversations: new Map<string, FakeConversation>(),
	starts: [] as Array<{
		workflowType: string;
		options: Record<string, unknown>;
	}>,
	cancels: [] as string[],
	terminates: [] as string[],
	/** Thrown by the next workflow start, as a service that cannot start one. */
	startError: null as Error | null,
	openStores: 0,
	sequence: 0,
	waiters: new Set<() => void>(),
};

function reset(): void {
	state.inputs.clear();
	state.streams.clear();
	state.threads.clear();
	state.workflows.clear();
	state.conversations.clear();
	state.starts.length = 0;
	state.cancels.length = 0;
	state.terminates.length = 0;
	state.startError = null;
	state.openStores = 0;
	state.sequence = 0;
	state.waiters.clear();
}

function namedError(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

/** The worker appending one event to a run's stream. */
function appendEvent(runId: string, event: BaseEvent): void {
	state.sequence += 1;
	const events = state.streams.get(runId) ?? [];
	events.push({ id: `${state.sequence}-0`, event });
	state.streams.set(runId, events);
	for (const wake of state.waiters) {
		wake();
	}
}

function settleWorkflow(workflowId: string, status: WorkflowStatus): void {
	const workflow = state.workflows.get(workflowId);
	if (!workflow) {
		throw new Error(`no workflow ${workflowId}`);
	}
	workflow.status = status;
	for (const wake of state.waiters) {
		wake();
	}
}

function sequenceOf(id: string): number {
	return Number(id.split("-")[0]);
}

function eventsAfter(runId: string, afterId: string): StoredRunEvent[] {
	const after = sequenceOf(afterId);
	return (state.streams.get(runId) ?? []).filter(
		({ id }) => sequenceOf(id) > after,
	);
}

const store: AgUiRunStore = {
	writeInput: async (runId, record) => {
		const key = `agui:run:${runId}:input`;
		if (!state.inputs.has(key)) {
			state.inputs.set(key, record);
		}
		return key;
	},
	takeInput: async (inputRef) => {
		const record = state.inputs.get(inputRef) ?? null;
		state.inputs.delete(inputRef);
		return record;
	},
	appendEvent: async (runId, event) => appendEvent(runId, event),
	readEvents: async (runId, afterId, blockMs) => {
		const ready = eventsAfter(runId, afterId);
		if (ready.length > 0 || blockMs === undefined) {
			return ready;
		}
		await new Promise<void>((resolve) => {
			const wake = () => {
				state.waiters.delete(wake);
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(wake, blockMs);
			state.waiters.add(wake);
		});
		return eventsAfter(runId, afterId);
	},
	readLastEvent: async (runId) => state.streams.get(runId)?.at(-1) ?? null,
	writeThread: async (threadId, record) => {
		state.threads.set(threadId, record);
	},
	readThread: async (threadId) => state.threads.get(threadId) ?? null,
	close: async () => {
		state.openStores -= 1;
	},
};

/** The store, with some of its operations replaced (a failing Redis call). */
function storeWith(overrides: Partial<AgUiRunStore>): AgUiRunStore {
	state.openStores += 1;
	return { ...store, ...overrides };
}

/** `@repo/temporal/agui-run-stream`'s opener. */
async function openAgUiRunStore(): Promise<AgUiRunStore> {
	state.openStores += 1;
	return store;
}

/** `@repo/temporal`, as far as the engine uses it. */
const temporal = {
	getTemporalClient: async () => ({
		workflow: {
			start: async (
				workflowType: string,
				options: Record<string, unknown>,
			) => {
				const workflowId = String(options.workflowId);
				if (state.startError) {
					throw state.startError;
				}
				if (state.workflows.has(workflowId)) {
					throw namedError(
						"WorkflowExecutionAlreadyStartedError",
						"Workflow execution already started",
					);
				}
				state.starts.push({ workflowType, options });
				state.workflows.set(workflowId, {
					status: "RUNNING",
					memo:
						typeof options.memo === "object" &&
						options.memo !== null
							? { ...options.memo }
							: {},
					args: Array.isArray(options.args) ? options.args : [],
				});
				return { workflowId };
			},
			getHandle: (workflowId: string) => ({
				describe: async () => {
					const workflow = state.workflows.get(workflowId);
					if (!workflow) {
						throw namedError(
							"WorkflowNotFoundError",
							"workflow not found",
						);
					}
					return {
						status: { name: workflow.status },
						memo: workflow.memo,
					};
				},
				cancel: async () => {
					state.cancels.push(workflowId);
					settleWorkflow(workflowId, "CANCELLED");
				},
				terminate: async () => {
					state.terminates.push(workflowId);
					settleWorkflow(workflowId, "TERMINATED");
				},
			}),
		},
	}),
};

/** `runtime/thread`'s reads, over the fake conversation table. */
const thread = {
	readThreadAccess: async (
		threadId: string,
		caller: { userId: string; organizationId: string },
	) => {
		if (!THREAD_ID_PATTERN.test(threadId)) {
			return { kind: "forbidden" as const };
		}
		const conversation = state.conversations.get(threadId);
		if (!conversation) {
			return { kind: "absent" as const };
		}
		return conversation.userId === caller.userId &&
			conversation.organizationId === caller.organizationId
			? { kind: "owned" as const }
			: { kind: "forbidden" as const };
	},
	/** The thread's conversation and its continuations, the caller's only. */
	readThreadPersistedMessageIds: async (
		threadId: string,
		caller: { userId: string; organizationId: string },
	) => {
		const owned = (conversation: FakeConversation | undefined) =>
			conversation !== undefined &&
			conversation.userId === caller.userId &&
			conversation.organizationId === caller.organizationId;
		const ids = new Set<string>();
		if (!owned(state.conversations.get(threadId))) {
			return ids;
		}
		const lineage = [threadId];
		for (const conversationId of lineage) {
			const conversation = state.conversations.get(conversationId);
			for (const message of conversation?.messages ?? []) {
				ids.add(message.id);
			}
			for (const [childId, child] of state.conversations) {
				if (
					child.parentConversationId === conversationId &&
					owned(child)
				) {
					lineage.push(childId);
				}
			}
		}
		return ids;
	},
};

export const fakeAgUiWorld = {
	state,
	reset,
	appendEvent,
	settleWorkflow,
	openAgUiRunStore,
	storeWith,
	temporal,
	thread,
};
