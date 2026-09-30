import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parlumeActionOutcome } from "../parlume-action-policy";
import {
	createParlumeToolRuntime,
	type ParlumeActionContext,
	prepareParlumeDecision,
} from "../parlume-actions";

const state = vi.hoisted(() => {
	const initial: {
		session: Record<string, unknown>;
		action: Record<string, unknown> | undefined;
		access: boolean;
		audit: ReturnType<typeof vi.fn>;
	} = { session: {}, action: undefined, access: true, audit: vi.fn() };
	return initial;
});
vi.mock("../parlume-voice", () => ({
	verifyParlumeVoiceGeneration: vi.fn(async () => true),
}));

function matches(
	row: Record<string, unknown>,
	where: Record<string, unknown>,
): boolean {
	return Object.entries(where).every(([key, expected]) => {
		const actual = row[key];
		if (
			typeof expected !== "object" ||
			expected === null ||
			expected instanceof Date
		) {
			return actual instanceof Date && expected instanceof Date
				? actual.getTime() === expected.getTime()
				: actual === expected;
		}
		if ("in" in expected && Array.isArray(expected.in)) {
			return expected.in.includes(actual);
		}
		if ("not" in expected) {
			return actual !== expected.not;
		}
		if (
			"gt" in expected &&
			expected.gt instanceof Date &&
			actual instanceof Date
		) {
			return actual > expected.gt;
		}
		return false;
	});
}

vi.mock("@repo/database", () => {
	const session = {
		findFirst: vi.fn(
			async ({ where }: { where: Record<string, unknown> }) =>
				matches(state.session, where)
					? structuredClone(state.session)
					: null,
		),
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				if (!matches(state.session, where)) {
					return { count: 0 };
				}
				Object.assign(state.session, data);
				return { count: 1 };
			},
		),
	};
	const action = {
		upsert: vi.fn(
			async ({ create }: { create: Record<string, unknown> }) => {
				state.action ??= structuredClone({
					...create,
					id: "action",
					status: "PROPOSED",
					presentedAt: null,
				});
				return structuredClone(state.action);
			},
		),
		findFirst: vi.fn(
			async ({ where }: { where: Record<string, unknown> }) =>
				state.action && matches(state.action, where)
					? structuredClone(state.action)
					: null,
		),
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				if (!state.action || !matches(state.action, where)) {
					return { count: 0 };
				}
				Object.assign(state.action, structuredClone(data));
				return { count: 1 };
			},
		),
		update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
			if (state.action) {
				Object.assign(state.action, structuredClone(data));
			}
			return structuredClone(state.action);
		}),
	};
	const delegates = { parlumeMeetingSession: session, parlumeAction: action };
	return {
		db: {
			...delegates,
			$transaction: (run: (tx: typeof delegates) => Promise<unknown>) =>
				run(delegates),
		},
		hasProjectAccess: vi.fn(async () => state.access),
		canEditProject: vi.fn(async () => state.access),
		recordAuditTx: state.audit,
	};
});

const context: ParlumeActionContext = {
	turnId: "request",
	sessionId: "session",
	projectId: "project",
	organizationId: "org",
	userId: "user",
	speakerId: "speaker-a",
	speakerName: "Alex",
	agentRevision: "revision",
	voiceGeneration: 3,
	toolsReadOnly: false,
};
const inputSchema = z.object({
	title: z.string(),
	nested: z.object({ value: z.number() }).optional(),
});
const source = { configId: "connection-b", originalName: "create_ticket" };
const execute = vi.fn(async () => ({ success: true, id: "ticket" }));
const definition = { inputSchema, description: "Create a ticket", execute };
const tools = { connection_b_create_ticket: definition };
const sources = { connection_b_create_ticket: source };

async function propose(args: Record<string, unknown> = { title: "Review" }) {
	await createParlumeToolRuntime(context).invoke({
		name: "connection_b_create_ticket",
		...definition,
		source,
		args,
		delegates: false,
		execute: () => execute(),
	});
	if (!state.action) {
		throw new Error("Expected proposal");
	}
	state.action.status = "AWAITING_CONFIRMATION";
	state.action.presentedAt = new Date();
}

async function confirm(overrides: Partial<ParlumeActionContext> = {}) {
	const decision = await prepareParlumeDecision(
		{ ...context, turnId: "confirm", ...overrides },
		"confirm",
	);
	return decision.runtime?.prepared
		? decision.runtime.prepared(tools, sources)
		: decision.response;
}

beforeEach(() => {
	vi.clearAllMocks();
	state.action = undefined;
	state.access = true;
	state.session = {
		id: "session",
		projectId: "project",
		organizationId: "org",
		userId: "user",
		status: "ACTIVE",
		voiceGeneration: 3,
		toolsReadOnly: false,
		activeTurnId: "confirm",
	};
	execute.mockResolvedValue({ success: true, id: "ticket" });
});

describe("Parlume exact approval", () => {
	it("holds writes and only the requesting speaker can confirm or cancel", async () => {
		await propose();
		expect(execute).not.toHaveBeenCalled();
		await confirm({ speakerId: "speaker-b" });
		await prepareParlumeDecision(
			{ ...context, speakerId: "speaker-b" },
			"cancel",
		);
		expect(state.action?.status).toBe("AWAITING_CONFIRMATION");
		expect(execute).not.toHaveBeenCalled();
		await confirm();
		expect(execute).toHaveBeenCalledTimes(1);
		expect(state.action?.status).toBe("COMPLETED");
	});
	it("dispatches persisted arguments even if the original nested input changes", async () => {
		const args = { title: "Original", nested: { value: 1 } };
		await propose(args);
		args.title = "Changed";
		args.nested.value = 2;
		await confirm();
		expect(execute).toHaveBeenCalledWith(
			{ title: "Original", nested: { value: 1 } },
			expect.any(Object),
		);
	});
	it("atomically dispatches once under concurrent and repeated confirmation", async () => {
		await propose();
		const decisions = await Promise.all(
			[0, 1].map(() =>
				prepareParlumeDecision(
					{ ...context, turnId: "confirm" },
					"confirm",
				),
			),
		);
		await Promise.all(
			decisions.map((decision) =>
				decision.runtime?.prepared?.(tools, sources),
			),
		);
		await confirm();
		expect(execute).toHaveBeenCalledTimes(1);
		expect(state.audit).toHaveBeenCalledTimes(1);
	});
	it.each([
		"revision",
		"permission",
		"expiry",
		"presentation",
		"generation",
		"read-only",
		"speaker",
	])("rejects an invalid %s confirmation", async (change) => {
		await propose();
		const overrides: Partial<ParlumeActionContext> = {};
		if (change === "revision") {
			overrides.agentRevision = "new";
		}
		if (change === "permission") {
			state.access = false;
		}
		if (change === "expiry" && state.action) {
			state.action.expiresAt = new Date(0);
		}
		if (change === "presentation" && state.action) {
			state.action.presentedAt = null;
		}
		if (change === "generation") {
			state.session.voiceGeneration = 4;
		}
		if (change === "read-only") {
			overrides.toolsReadOnly = true;
		}
		if (change === "speaker") {
			overrides.speakerId = null;
		}
		await confirm(overrides);
		expect(execute).not.toHaveBeenCalled();
	});
	it("does not substitute another provider exposing the same tool", async () => {
		await propose();
		const decision = await prepareParlumeDecision(
			{ ...context, turnId: "confirm" },
			"confirm",
		);
		await decision.runtime?.prepared?.(tools, {
			connection_b_create_ticket: { ...source, configId: "connection-a" },
		});
		expect(execute).not.toHaveBeenCalled();
		expect(state.action?.status).toBe("INVALIDATED");
	});
	it("invalidates a changed input schema", async () => {
		await propose();
		const decision = await prepareParlumeDecision(
			{ ...context, turnId: "confirm" },
			"confirm",
		);
		await decision.runtime?.prepared?.(
			{
				connection_b_create_ticket: {
					...definition,
					inputSchema: z.object({ different: z.string() }),
				},
			},
			sources,
		);
		expect(execute).not.toHaveBeenCalled();
		expect(state.action?.status).toBe("INVALIDATED");
	});
	it("never retries an uncertain external dispatch", async () => {
		await propose();
		execute.mockRejectedValueOnce(new Error("Transport disconnected"));
		await confirm();
		await confirm();
		expect(execute).toHaveBeenCalledTimes(1);
		expect(state.action?.status).toBe("OUTCOME_UNKNOWN");
	});
	it("blocks writes in read-only mode and outside the meeting project", async () => {
		state.session.toolsReadOnly = true;
		const invoke = {
			name: "create_ticket",
			...definition,
			source: { configId: "builtin", originalName: "create_ticket" },
			args: { projectId: "other" },
			delegates: false,
			execute: () => execute(),
		};
		await createParlumeToolRuntime({
			...context,
			toolsReadOnly: true,
		}).invoke(invoke);
		state.session.toolsReadOnly = false;
		await createParlumeToolRuntime(context).invoke(invoke);
		expect(state.action).toBeUndefined();
		expect(execute).not.toHaveBeenCalled();
	});
	it("classifies a namespaced MCP read by its original tool name", async () => {
		state.session.toolsReadOnly = true;
		await createParlumeToolRuntime({
			...context,
			toolsReadOnly: true,
		}).invoke({
			name: "connection_b_get_ticket",
			...definition,
			source: { configId: "connection-b", originalName: "get_ticket" },
			args: { id: "ticket" },
			delegates: false,
			execute: () => execute(),
		});
		expect(state.action).toBeUndefined();
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it("cancels a prior proposal when a requester changes the request", async () => {
		await propose();
		await prepareParlumeDecision(context, "confirm but change the title");
		await confirm();
		expect(state.action?.status).toBe("CANCELLED");
		expect(execute).not.toHaveBeenCalled();
	});
});

describe("Parlume outcome evidence", () => {
	it.each([
		[{ success: true }, "COMPLETED"],
		[
			{ success: false, error: "Not allowed", authorityRequired: true },
			"FAILED",
		],
		[{ requiresConfirmation: true, workflowId: "workflow" }, "FAILED"],
		[
			{ isError: true, content: [{ type: "text", text: "Denied" }] },
			"FAILED",
		],
		[{ error: "MCP tool did not respond" }, "OUTCOME_UNKNOWN"],
		[
			{ success: true, status: "unconfirmed", executionId: "execution" },
			"OUTCOME_UNKNOWN",
		],
		[{ success: true, status: "queued" }, "OUTCOME_UNKNOWN"],
		[{ content: [{ type: "text", text: "Submitted" }] }, "OUTCOME_UNKNOWN"],
	])("classifies %j as %s", (result, expected) => {
		expect(parlumeActionOutcome(result)).toBe(expected);
	});
});
