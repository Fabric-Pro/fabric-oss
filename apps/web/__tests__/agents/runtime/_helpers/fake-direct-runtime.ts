/**
 * An in-memory world for the agent runtime's Direct engine tests: the
 * conversation and `ConversationTurn` tables (with the admission, cancel and
 * finalize rules of the real queries), Temporal workflows, and the Direct
 * route's admission and start. Test files mock the real modules with the
 * parts of `fakeWorld` (each `vi.mock` factory imports this module) and
 * read and drive `fakeWorld.state`.
 */
import type { DirectChatWorkflowOutput } from "@repo/temporal";

export interface FakeTurn {
	id: string;
	userId: string;
	organizationId: string;
	conversationId: string | null;
	clientRequestKey: string;
	executionId: string | null;
	executionMode: string;
	status: string;
	startToken: string | null;
	questionText: string | null;
	createdAt: Date;
	updatedAt: Date;
	generation: number | null;
}

export interface FakeWorkflow {
	status: string;
	result?: DirectChatWorkflowOutput;
	progress?: Record<string, unknown>;
	memo: { userId: string; organizationId: string };
	runId: string;
}

export interface SavedTurn {
	id: string;
	userId: string;
	organizationId: string;
	messages: Array<{ id: string; role: string } & Record<string, unknown>>;
	execution: Record<string, unknown>;
}

export interface WorkflowInput {
	executionId: string;
	conversationId: unknown;
	message: unknown;
	approvedToolCall: unknown;
}

interface FakeConversation {
	id: string;
	userId: string;
	organizationId: string;
	agentId: string;
	metadata: Record<string, unknown>;
	messages: Array<{ id: string } & Record<string, unknown>>;
}

const LIVE = ["START_PENDING", "ACTIVE", "CANCEL_REQUESTED"];
const TERMINAL = ["COMPLETED", "FAILED", "LIMITED", "CANCELLED"];

const state = {
	conversations: new Map<string, FakeConversation>(),
	turns: [] as FakeTurn[],
	workflows: new Map<string, FakeWorkflow>(),
	starts: [] as WorkflowInput[],
	admittedBodies: [] as Array<Record<string, unknown>>,
	cancels: [] as string[],
	saves: [] as SavedTurn[],
	finalizes: [] as Array<Record<string, unknown>>,
	/** Saves and finalizes, in the order they happened. */
	writeOrder: [] as Array<"save" | "finalize">,
	/** The state a started workflow begins in. */
	onStart: (_input: WorkflowInput): Omit<FakeWorkflow, "memo" | "runId"> => ({
		status: "RUNNING",
	}),
	/** The `memo` owner the started workflows carry. */
	workflowOwner: { userId: "", organizationId: "" },
	seq: 0,
	/** The Direct route's refusal of the next admitted turn (a usage limit, say). */
	refusal: null as (() => Response) | null,
	/** What starting the next workflow throws. */
	startError: null as Error | null,
};

function reset(owner: { userId: string; organizationId: string }) {
	state.conversations.clear();
	state.turns.length = 0;
	state.workflows.clear();
	state.starts.length = 0;
	state.admittedBodies.length = 0;
	state.cancels.length = 0;
	state.saves.length = 0;
	state.finalizes.length = 0;
	state.writeOrder.length = 0;
	state.seq = 0;
	state.refusal = null;
	state.startError = null;
	state.workflowOwner = { ...owner };
}

const copy = (turn: FakeTurn) => ({ ...turn });
const hidden = (turn: FakeTurn) => ({ ...turn, startToken: null });

function byId(turnId: string) {
	const turn = state.turns.find((candidate) => candidate.id === turnId);
	if (!turn) {
		throw new Error(`no turn ${turnId}`);
	}
	return turn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Temporal's NotFound, as the client's error classifier reads it. */
function notFound() {
	const error = new Error("workflow not found");
	error.name = "WorkflowNotFoundError";
	return error;
}

function handleFor(executionId: string) {
	return {
		workflowId: executionId,
		describe: async () => {
			const workflow = state.workflows.get(executionId);
			if (!workflow) {
				throw notFound();
			}
			return {
				status: { name: workflow.status },
				raw: { pendingActivities: [] },
				runId: workflow.runId,
				memo: workflow.memo,
			};
		},
		result: async () => {
			const workflow = state.workflows.get(executionId);
			if (!workflow) {
				throw notFound();
			}
			if (workflow.status !== "COMPLETED") {
				throw new Error(`workflow ${workflow.status.toLowerCase()}`);
			}
			return workflow.result;
		},
		query: async () => {
			const workflow = state.workflows.get(executionId);
			if (!workflow?.progress) {
				throw new Error("query not registered");
			}
			return workflow.progress;
		},
		cancel: async () => {
			const workflow = state.workflows.get(executionId);
			if (workflow) {
				workflow.status = "CANCELLED";
			}
			state.cancels.push(executionId);
		},
	};
}

function applyCancel(turn: FakeTurn) {
	if (turn.status === "START_PENDING" || turn.status === "ACTIVE") {
		turn.status = "CANCEL_REQUESTED";
		return { outcome: "recorded", turn: hidden(turn) };
	}
	return turn.status === "CANCEL_REQUESTED"
		? { outcome: "already_requested", turn: hidden(turn) }
		: { outcome: "already_terminal", turn: hidden(turn) };
}

/** `@repo/database`, as far as the runtime uses it. */
const database = {
	db: {
		agentConversation: {
			findUnique: async ({ where }: { where: { id: string } }) =>
				state.conversations.get(where.id) ?? null,
		},
	},
	createAgentConversation: async (
		args: Omit<FakeConversation, "messages">,
	) => {
		if (state.conversations.has(args.id)) {
			throw new Error("exists");
		}
		const conversation = { ...args, messages: [] };
		state.conversations.set(args.id, conversation);
		return conversation;
	},
	getAgentConversationById: async (args: {
		id: string;
		userId: string;
		organizationId: string;
	}) => {
		const conversation = state.conversations.get(args.id);
		return conversation?.userId === args.userId &&
			conversation.organizationId === args.organizationId
			? conversation
			: null;
	},
	/**
	 * The real save's placement: each message is stamped with the execution;
	 * the turn's messages fill, in order, the positions of the messages it
	 * already owns (stamped with this execution), the rest go right after
	 * the last of them, or at the end when it owns none. Messages it does
	 * not own never move, so a repeated save changes nothing.
	 */
	saveConversationTurn: async (args: SavedTurn) => {
		state.saves.push(args);
		state.writeOrder.push("save");
		const conversation = state.conversations.get(args.id);
		if (!conversation) {
			throw new Error("no conversation");
		}
		const executionId = args.execution.id;
		const stamped = args.messages.map((message) => ({
			...message,
			metadata: {
				...(isRecord(message.metadata) ? message.metadata : {}),
				executionId,
			},
		}));
		const owns = (message: Record<string, unknown>) =>
			isRecord(message.metadata) &&
			message.metadata.executionId === executionId;
		const slots = conversation.messages.flatMap((message, index) =>
			owns(message) ? [index] : [],
		);
		const before = conversation.messages.length;
		const next: Array<(typeof conversation.messages)[number] | null> = [
			...conversation.messages,
		];
		slots.forEach((slot, index) => {
			next[slot] = stamped[index] ?? null;
		});
		const lastSlot = slots.at(-1);
		const insertAt = lastSlot === undefined ? next.length : lastSlot + 1;
		next.splice(insertAt, 0, ...stamped.slice(slots.length));
		conversation.messages = next.filter((message) => message !== null);
		return {
			addedMessages: Math.max(0, conversation.messages.length - before),
			removedMessages: 0,
		};
	},
	admitConversationTurn: async (args: {
		userId: string;
		organizationId: string;
		conversationId: string;
		clientRequestKey: string;
		executionId: string;
		executionMode: string;
		question: string;
	}) => {
		const existing = state.turns.find(
			(turn) =>
				turn.userId === args.userId &&
				turn.organizationId === args.organizationId &&
				turn.clientRequestKey === args.clientRequestKey,
		);
		if (existing) {
			return existing.conversationId === args.conversationId
				? { outcome: "existing", turn: hidden(existing) }
				: { outcome: "key_reused" };
		}
		const conversation = state.conversations.get(args.conversationId);
		if (
			conversation?.userId !== args.userId ||
			conversation.organizationId !== args.organizationId
		) {
			return { outcome: "conversation_forbidden" };
		}
		const live = state.turns.find(
			(turn) =>
				turn.conversationId === args.conversationId &&
				LIVE.includes(turn.status),
		);
		if (live) {
			return { outcome: "conflict", turn: hidden(live) };
		}
		state.seq += 1;
		const now = new Date();
		const turn: FakeTurn = {
			id: `turn-${state.seq}`,
			userId: args.userId,
			organizationId: args.organizationId,
			conversationId: args.conversationId,
			clientRequestKey: args.clientRequestKey,
			executionId: args.executionId,
			executionMode: args.executionMode,
			status: "START_PENDING",
			startToken: `start-token-${state.seq}`,
			questionText: args.question,
			createdAt: now,
			updatedAt: now,
			generation: state.seq,
		};
		state.turns.push(turn);
		return { outcome: "created", turn: copy(turn) };
	},
	getConversationTurnForExecution: async (args: { executionId: string }) => {
		const turn = state.turns.find(
			(candidate) => candidate.executionId === args.executionId,
		);
		return turn ? hidden(turn) : null;
	},
	markConversationTurnActive: async (args: { turnId: string }) => {
		const turn = byId(args.turnId);
		if (turn.status !== "START_PENDING") {
			return false;
		}
		turn.status = "ACTIVE";
		return true;
	},
	markConversationTurnStartFailed: async () => true,
	abandonConversationTurnStart: async (args: {
		turnId: string;
		cancelled: boolean;
	}) => {
		const turn = byId(args.turnId);
		if (turn.status !== "START_PENDING") {
			return false;
		}
		turn.status = args.cancelled ? "CANCELLED" : "FAILED";
		return true;
	},
	finalizeConversationTurn: async (args: {
		turnId: string;
		outcome: string;
	}) => {
		state.finalizes.push(args);
		state.writeOrder.push("finalize");
		const turn = byId(args.turnId);
		if (TERMINAL.includes(turn.status)) {
			return { outcome: "already_terminal" };
		}
		turn.status =
			turn.status === "CANCEL_REQUESTED" ? "CANCELLED" : args.outcome;
		return { outcome: "finalized" };
	},
	finalizeOrphanedConversationTurn: async (args: { turnId: string }) => {
		byId(args.turnId).status = "FAILED";
		return { outcome: "finalized" };
	},
	getConversationTurnByClientKey: async (args: {
		clientRequestKey: string;
		userId: string;
		organizationId: string;
	}) => {
		const turn = state.turns.find(
			(candidate) =>
				candidate.clientRequestKey === args.clientRequestKey &&
				candidate.userId === args.userId &&
				candidate.organizationId === args.organizationId,
		);
		return turn ? hidden(turn) : null;
	},
	getLatestConversationTurn: async (args: {
		conversationId: string;
		userId: string;
		organizationId: string;
	}) => {
		const turn = state.turns
			.filter(
				(candidate) =>
					candidate.conversationId === args.conversationId &&
					candidate.userId === args.userId &&
					candidate.organizationId === args.organizationId &&
					candidate.executionId !== null,
			)
			.at(-1);
		return turn ? hidden(turn) : null;
	},
	requestConversationTurnCancel: async (args: {
		userId: string;
		organizationId: string;
		executionId?: string;
		clientRequestKey?: string;
		conversationId?: string;
	}) => {
		if (args.executionId) {
			const turn = state.turns.find(
				(candidate) =>
					candidate.executionId === args.executionId &&
					candidate.userId === args.userId &&
					candidate.organizationId === args.organizationId,
			);
			return turn ? applyCancel(turn) : { outcome: "not_found" };
		}
		const keyed = state.turns.find(
			(candidate) =>
				candidate.clientRequestKey === args.clientRequestKey &&
				candidate.userId === args.userId &&
				candidate.organizationId === args.organizationId,
		);
		if (keyed) {
			return keyed.conversationId === args.conversationId
				? applyCancel(keyed)
				: { outcome: "scope_mismatch" };
		}
		state.seq += 1;
		const now = new Date();
		const tombstone: FakeTurn = {
			id: `turn-${state.seq}`,
			userId: args.userId,
			organizationId: args.organizationId,
			conversationId: args.conversationId ?? null,
			clientRequestKey: args.clientRequestKey ?? "",
			executionId: null,
			executionMode: "direct",
			status: "CANCELLED",
			startToken: null,
			questionText: null,
			createdAt: now,
			updatedAt: now,
			generation: null,
		};
		state.turns.push(tombstone);
		return { outcome: "tombstoned", turn: tombstone };
	},
};

/** `@repo/temporal`, as far as the runtime uses it. */
const temporal = {
	getTemporalClient: async () => ({
		workflow: {
			getHandle: (executionId: string) => handleFor(executionId),
			start: async () => {
				throw new Error("starts go through startDirectChatWorkflow");
			},
		},
	}),
	decodeHeartbeatDetails: (raw: unknown) => raw,
};

/** The Direct route's admission and start (`stream/direct-turn`). */
const directTurn = {
	admitDirectChatTurn: async (readBody: () => Promise<unknown>) => {
		const body = await readBody();
		if (!isRecord(body)) {
			throw new Error("the turn body is an object");
		}
		if (state.refusal) {
			return state.refusal();
		}
		state.admittedBodies.push(body);
		return { turn: { body }, planPreflight: null };
	},
	buildDirectChatWorkflowInput: async (
		turn: { body: Record<string, unknown> },
		executionId: string,
	): Promise<WorkflowInput> => ({
		executionId,
		conversationId: turn.body.conversationId,
		message: turn.body.message,
		approvedToolCall: turn.body.approvedToolCall,
	}),
	startDirectChatWorkflow: async (input: WorkflowInput) => {
		if (state.startError) {
			throw state.startError;
		}
		state.starts.push(input);
		state.workflows.set(input.executionId, {
			...state.onStart(input),
			memo: { ...state.workflowOwner },
			runId: `temporal-run-${state.starts.length}`,
		});
		return handleFor(input.executionId);
	},
};

/**
 * `getAuthorizedChatRun` against the fake workflows: it describes the run
 * first (so a run not started yet is Temporal's NotFound), then checks the
 * memo's owner and organization.
 */
function authorizedChatRun(accessError: new () => Error) {
	return async (input: {
		executionId: string;
		userId: string;
		expectedOrganizationId?: string;
	}) => {
		const workflow = state.workflows.get(input.executionId);
		if (!workflow) {
			throw notFound();
		}
		if (
			workflow.memo.userId !== input.userId ||
			workflow.memo.organizationId !== input.expectedOrganizationId
		) {
			throw new accessError();
		}
		return {
			handle: handleFor(input.executionId),
			description: {
				status: { name: workflow.status },
				runId: workflow.runId,
			},
			organizationId: workflow.memo.organizationId,
		};
	};
}

export const fakeWorld = {
	state,
	reset,
	database,
	temporal,
	directTurn,
	authorizedChatRun,
};
