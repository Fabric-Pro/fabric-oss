// @vitest-environment node
/**
 * The runtime's `weave-refine` engine: Create Plan's "Refine request with
 * AI", streamed.
 *
 *   - refused (`FEATURE_DISABLED`) while `COPILOTKIT_WEAVE_REFINE_CHAT` is
 *     off for the caller's organization, (`INVALID_REQUEST`) without a
 *     project or a request, (`NO_MESSAGE`) without a new refinement input;
 *     none checks access, builds a prompt or resolves a model;
 *   - the procedure's checks (`authorizeRefineRun`) refuse with the
 *     procedure's code and message, before any prompt or model, and write
 *     the procedure's error row;
 *   - a reply streams its feedback, then the improved request and whether it
 *     is ready (CUSTOM `fabric.weave-refine.result`), and passes AG-UI's
 *     `verifyEvents`; the streamed feedback is exactly what the procedure
 *     returns, however the model shapes its reply;
 *   - the model runs in the organization the checks resolved, and its
 *     success writes the procedure's activity row; a failure writes the
 *     error row instead and ends as the member's refusal or a generic one;
 *   - after a stop nothing more is sent and no result is applied, but the
 *     model call runs to its end and is recorded.
 */
import {
	type AGUIEvent,
	type BaseEvent,
	EventType,
	type RunAgentInput,
	verifyEvents,
} from "@ag-ui/client";
import { ORPCError } from "@orpc/client";
import {
	CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
	ChatGptPlanAuthError,
} from "@repo/ai/lib/chatgpt-plan/oauth";
import {
	type AuthorizedProject,
	recordAuthorizedProject,
	runWithProjectBindingHolder,
} from "@repo/api/lib/authorized-project-binding";
import { parseRefineResponse } from "@repo/api/modules/weave/lib/refine-response";
import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import type { RunStream } from "@saas/agents/runtime/engine";
import { from, lastValueFrom, toArray } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	/**
	 * What the mocked `streamText` answers: its text chunks, an error it
	 * reports through `onError` once they are sent (as the AI SDK reports a
	 * failed request), and a pause after the first chunk.
	 */
	reply: {
		chunks: [] as string[],
		error: undefined as unknown,
		pauseAfterFirst: undefined as (() => Promise<void>) | undefined,
		readToEnd: false,
	},
	isFeatureEnabled: vi.fn(),
	authorizeRefineRun: vi.fn(),
	buildRefinePrompt: vi.fn(),
	resolveRefineModel: vi.fn(),
	streamText: vi.fn(),
	recordProcedureActivity: vi.fn(),
	captureProcedureError: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	hasOrganizationTie: vi.fn(),
	rpcRateLimitRefusal: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: (...args: unknown[]) => m.isFeatureEnabled(...args),
	ERROR_CATEGORY: "error",
	hasOrganizationTie: (...args: unknown[]) => m.hasOrganizationTie(...args),
	redactSensitiveKeys: (value: unknown) => value,
}));
// The procedure's real error capture runs; only its writes are mocked.
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: async () => null } },
}));
vi.mock("@repo/api/lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) =>
		m.recordAuditFromRequest(...args),
}));
vi.mock("@repo/api/lib/request-span", () => ({
	flushSpansOnFailure: async () => undefined,
}));
vi.mock("@repo/api/modules/weave/lib/refine-request-turn", () => ({
	REFINE_PROCEDURE_PATH: ["weave", "plans", "refine"],
	authorizeRefineRun: (...args: unknown[]) => m.authorizeRefineRun(...args),
	buildRefinePrompt: (...args: unknown[]) => m.buildRefinePrompt(...args),
	resolveRefineModel: (...args: unknown[]) => m.resolveRefineModel(...args),
}));
vi.mock("@repo/ai", () => ({
	streamText: (...args: unknown[]) => m.streamText(...args),
}));
vi.mock("@repo/api/orpc/middleware/audit-activity-middleware", () => ({
	recordProcedureActivity: (...args: unknown[]) =>
		m.recordProcedureActivity(...args),
}));
vi.mock(
	"@repo/api/orpc/middleware/audit-error-middleware",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@repo/api/orpc/middleware/audit-error-middleware")
			>();
		return {
			...actual,
			recordProcedureFailure: (
				...args: Parameters<typeof actual.recordProcedureFailure>
			) => {
				m.captureProcedureError(...args);
				return actual.recordProcedureFailure(...args);
			},
		};
	},
);
vi.mock("@repo/api/orpc/middleware/rpc-rate-limit-middleware", () => ({
	rpcRateLimitRefusal: (...args: unknown[]) => m.rpcRateLimitRefusal(...args),
}));

const { WeaveRefineEngine } = await import(
	"@saas/agents/runtime/weave-refine-engine"
);
const { REFINE_SYSTEM_PROMPT } = await import(
	"@repo/api/modules/weave/lib/refine-response"
);

const USER = "user-example-1";
const ORG = "org-example-1";
const AUTHORIZED_ORG = "org-example-project";
const AUDIT = { headers: new Headers(), user: { id: USER } };
const CALLER = { userId: USER, organizationId: ORG, audit: AUDIT };
const THREAD = "thread-example-0001";
const RUN = "run-example-0001";
const PROJECT = "project-example-1";
const CURRENT = "Add login";
const MODEL = { modelId: "example-simple-model" };
const PROMPT = "the example prompt";
const REFINE_PATH = ["weave", "plans", "refine"];
const AUTHORIZED: AuthorizedProject = {
	projectId: PROJECT,
	organizationId: AUTHORIZED_ORG,
};

const CONVERSATION: RunAgentInput["messages"] = [
	{ id: "m-1", role: "user", content: "Use sessions" },
	{ id: "m-2", role: "assistant", content: "Cookie or token?" },
	{ id: "m-3", role: "user", content: "Tokens, please" },
];
const HISTORY = [
	{ role: "user", content: "Use sessions" },
	{ role: "assistant", content: "Cookie or token?" },
];

const REPLY_CHUNKS = [
	"FEEDBACK: Which ",
	"provider?\nUPDATED_",
	"MESSAGE: Add login with an example provider\nREADY: true",
];

function input(
	messages = CONVERSATION,
	forwardedProps: Record<string, unknown> = {
		projectId: PROJECT,
		currentMessage: CURRENT,
	},
): RunAgentInput {
	return {
		threadId: THREAD,
		runId: RUN,
		messages,
		tools: [],
		context: [],
		state: {},
		forwardedProps,
	};
}

function collector(): RunStream & { events: AGUIEvent[] } {
	const events: AGUIEvent[] = [];
	return {
		events,
		emit: (event) => events.push(event),
		isClosed: () => false,
		deadline: Date.now() + 60_000,
	};
}

/** A pause the mocked model holds the reply at, until `release`. */
function pause(): {
	hold: () => Promise<void>;
	reached: Promise<void>;
	release: () => void;
} {
	let reach = () => {};
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		hold: () => {
			reach();
			return gate;
		},
		reached,
		release: () => release(),
	};
}

async function run(request: RunAgentInput = input()): Promise<AGUIEvent[]> {
	const stream = collector();
	await new WeaveRefineEngine(CALLER).run(
		{ threadId: THREAD, input: request },
		stream,
	);
	return stream.events;
}

function deltasOf(events: AGUIEvent[]): string[] {
	return events.flatMap((event) =>
		event.type === EventType.TEXT_MESSAGE_CONTENT ? [event.delta] : [],
	);
}

function resultOf(events: AGUIEvent[]): unknown {
	return events.find((event) => event.type === EventType.CUSTOM);
}

/**
 * `authorizeRefineRun` refusing as the real one does: inside its binding
 * holder, with `authorized` bound once the permission check returned it.
 */
function refuseAuthorization(
	error: unknown,
	authorized: AuthorizedProject | null,
) {
	m.authorizeRefineRun.mockImplementation(
		({ onRefusal }: { onRefusal: (error: unknown) => void }) =>
			runWithProjectBindingHolder(async () => {
				if (authorized) {
					recordAuthorizedProject(authorized);
				}
				onRefusal(error);
				throw error;
			}),
	);
}

/** The error row the procedure's capture wrote, once it has. */
async function errorRow(): Promise<unknown> {
	await vi.waitFor(() =>
		expect(m.recordAuditFromRequest).toHaveBeenCalledTimes(1),
	);
	return m.recordAuditFromRequest.mock.calls[0]?.[1];
}

/** Nothing past admission ran: no prompt, model, reply or success row. */
function expectNoTurn() {
	expect(m.buildRefinePrompt).not.toHaveBeenCalled();
	expect(m.resolveRefineModel).not.toHaveBeenCalled();
	expect(m.streamText).not.toHaveBeenCalled();
	expect(m.recordProcedureActivity).not.toHaveBeenCalled();
}

beforeEach(() => {
	vi.clearAllMocks();
	// The capture marks the request it wrote a row for; each test is a new one.
	Reflect.deleteProperty(AUDIT, "_auditFailureEmitted");
	m.reply = {
		chunks: REPLY_CHUNKS,
		error: undefined,
		pauseAfterFirst: undefined,
		readToEnd: false,
	};
	m.isFeatureEnabled.mockResolvedValue(true);
	m.rpcRateLimitRefusal.mockResolvedValue(null);
	m.authorizeRefineRun.mockResolvedValue({
		authorized: AUTHORIZED,
		organizationId: AUTHORIZED_ORG,
	});
	m.buildRefinePrompt.mockResolvedValue(PROMPT);
	m.resolveRefineModel.mockResolvedValue({
		model: MODEL,
		getAnswerModel: () => undefined,
	});
	// The caller's organization would be kept if no project were bound.
	m.hasOrganizationTie.mockResolvedValue(true);
	m.streamText.mockImplementation(
		({ onError }: { onError: (event: { error: unknown }) => void }) => ({
			textStream: (async function* () {
				for (const [index, chunk] of m.reply.chunks.entries()) {
					yield chunk;
					if (index === 0) {
						await m.reply.pauseAfterFirst?.();
					}
				}
				if (m.reply.error !== undefined) {
					onError({ error: m.reply.error });
				}
				m.reply.readToEnd = true;
			})(),
		}),
	);
});

describe("the weave-refine engine", () => {
	it("includes only the post-generation served model in the completed result", async () => {
		let served = { id: "example-plan", viaPlan: true };
		m.resolveRefineModel.mockResolvedValueOnce({
			model: MODEL,
			getAnswerModel: () => served,
		});
		m.reply.pauseAfterFirst = async () => {
			served = { id: "example-api-served", viaPlan: false };
		};
		const events = await run();
		expect(resultOf(events)).toMatchObject({
			value: { model: { id: "example-api-served", viaPlan: false } },
		});
	});
	it("refuses while its flag is off for the caller's organization, before any check or model call", async () => {
		m.isFeatureEnabled.mockResolvedValue(false);

		const events = await run();

		expect(events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "FEATURE_DISABLED",
			}),
		]);
		expect(m.isFeatureEnabled).toHaveBeenCalledWith(
			"COPILOTKIT_WEAVE_REFINE_CHAT",
			ORG,
		);
		expect(m.authorizeRefineRun).not.toHaveBeenCalled();
		expect(m.captureProcedureError).not.toHaveBeenCalled();
		expectNoTurn();
	});

	it.each([
		["no project", { currentMessage: CURRENT }],
		["an empty request", { projectId: PROJECT, currentMessage: "" }],
	])("refuses %s as an invalid request", async (_label, props) => {
		const events = await run(input(CONVERSATION, props));

		expect(events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "INVALID_REQUEST",
			}),
		]);
		expect(m.authorizeRefineRun).not.toHaveBeenCalled();
		expect(m.captureProcedureError).not.toHaveBeenCalled();
		expectNoTurn();
	});

	it.each([
		[
			"an assistant message last",
			[...CONVERSATION, { id: "m-4", role: "assistant", content: "Ok" }],
		],
		[
			"a blank input",
			[...CONVERSATION, { id: "m-4", role: "user", content: "   " }],
		],
	] as const)("refuses %s with NO_MESSAGE", async (_label, messages) => {
		const events = await run(input([...messages]));

		expect(events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "NO_MESSAGE",
			}),
		]);
		expect(m.authorizeRefineRun).not.toHaveBeenCalled();
		expect(m.captureProcedureError).not.toHaveBeenCalled();
		expectNoTurn();
	});

	it.each([
		{
			// Refused before a project was authorized: the caller's
			// organization, kept through its tie, and no project.
			error: new ORPCError("NOT_FOUND", { message: "Project not found" }),
			authorized: null,
			row: { organizationId: ORG, projectId: null },
		},
		{
			error: new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			}),
			authorized: AUTHORIZED,
			row: { organizationId: AUTHORIZED_ORG, projectId: PROJECT },
		},
		{
			// The caller named its own organization for another one's
			// project: the row goes to the project's organization.
			error: new ORPCError("BAD_REQUEST", {
				message: "organizationId does not match the project",
			}),
			authorized: AUTHORIZED,
			row: { organizationId: AUTHORIZED_ORG, projectId: PROJECT },
		},
	])(
		"refuses with the procedure's $error.code before any model call, and writes its error row",
		async ({ error, authorized, row }) => {
			refuseAuthorization(error, authorized);

			const events = await run();

			expect(events).toEqual([
				expect.objectContaining({
					type: EventType.RUN_ERROR,
					code: error.code,
					message: error.message,
					metadata: {
						fabric: expect.objectContaining({
							status: error.status,
						}),
					},
				}),
			]);
			expectNoTurn();
			expect(m.captureProcedureError).toHaveBeenCalledTimes(1);
			expect(m.captureProcedureError).toHaveBeenCalledWith(
				error,
				AUDIT,
				{
					projectId: PROJECT,
					organizationId: ORG,
					currentMessage: CURRENT,
					refinementInput: "Tokens, please",
					history: HISTORY,
				},
				REFINE_PATH,
			);
			expect(await errorRow()).toMatchObject({
				outcome: "failure",
				resource: { id: "weave.plans.refine" },
				...row,
			});
		},
	);

	it("ends a failed check generically, writes its error row and calls no model", async () => {
		const failure = new Error("db down");
		refuseAuthorization(failure, null);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		const events = await run();

		expect(events).toEqual([
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "RUN_FAILED",
			}),
		]);
		expectNoTurn();
		expect(m.captureProcedureError).toHaveBeenCalledWith(
			failure,
			AUDIT,
			expect.objectContaining({ projectId: PROJECT }),
			REFINE_PATH,
		);
		log.mockRestore();
	});

	it("streams the feedback, then the result, in the organization the checks resolved", async () => {
		const events = await run();

		expect(m.authorizeRefineRun).toHaveBeenCalledWith({
			userId: USER,
			organizationId: ORG,
			projectId: PROJECT,
			onRefusal: expect.any(Function),
		});
		await expect(
			lastValueFrom(
				from(events as BaseEvent[]).pipe(
					verifyEvents(false),
					toArray(),
				),
			),
		).resolves.toHaveLength(events.length);
		expect(events.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.TEXT_MESSAGE_START,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_CONTENT,
			EventType.TEXT_MESSAGE_END,
			EventType.CUSTOM,
			EventType.RUN_FINISHED,
		]);
		expect(events[1]).toMatchObject({
			messageId: `${RUN}:feedback`,
			role: "assistant",
		});
		expect(deltasOf(events).join("")).toBe("Which provider?");
		expect(resultOf(events)).toEqual({
			type: EventType.CUSTOM,
			name: "fabric.weave-refine.result",
			value: {
				updatedMessage: "Add login with an example provider",
				isReady: true,
			},
		});
		expect(m.buildRefinePrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT,
				currentMessage: CURRENT,
				refinementInput: "Tokens, please",
				history: HISTORY,
			}),
		);
		expect(m.resolveRefineModel).toHaveBeenCalledWith({
			userId: USER,
			organizationId: AUTHORIZED_ORG,
		});
		expect(m.streamText).toHaveBeenCalledWith(
			expect.objectContaining({
				model: MODEL,
				instructions: REFINE_SYSTEM_PROMPT,
				prompt: PROMPT,
			}),
		);
		expect(m.recordProcedureActivity).toHaveBeenCalledTimes(1);
		expect(m.recordProcedureActivity).toHaveBeenCalledWith(AUDIT, {
			path: REFINE_PATH,
			input: {
				organizationId: AUTHORIZED_ORG,
				projectId: PROJECT,
			},
		});
		expect(m.captureProcedureError).not.toHaveBeenCalled();
	});

	it.each([
		"FEEDBACK: What auth provider?\nUPDATED_MESSAGE: Add JWT auth\nREADY: false",
		"Sure.\nFEEDBACK:  Looks good.  \n\nUPDATED_MESSAGE: Build X\nREADY: TRUE",
		"No markers at all, just prose.",
		"FEEDBACK:\nUPDATED_MESSAGE: only update\nREADY: true",
		"FEEDBACK: truncated mid marker\nUPDATED",
		"FEEDBACK: two\nUPDATED_MESSAGE: a\nUPDATED_MESSAGE: b\nREADY: false",
		"FEEDBACK: windows line\r\nUPDATED_MESSAGE: x\r\nREADY: true",
		"",
	])(
		"streams exactly the procedure's feedback and result for %j",
		async (text) => {
			// Three characters at a time, so every marker is split somewhere.
			m.reply.chunks = text.match(/[\s\S]{1,3}/g) ?? [];
			const parsed = parseRefineResponse(text, CURRENT);

			const events = await run();

			expect(deltasOf(events).join("")).toBe(parsed.feedback);
			expect(deltasOf(events)).not.toContain("");
			expect(resultOf(events)).toMatchObject({
				value: {
					updatedMessage: parsed.updatedMessage,
					isReady: parsed.isReady,
				},
			});
		},
	);

	it("ends a failed model request with RUN_FAILED, no result and no success row, and writes the error row against the authorized project", async () => {
		const failure = new Error("provider overloaded");
		m.reply.error = failure;
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		const events = await run();

		expect(events.slice(-2)).toEqual([
			{ type: EventType.TEXT_MESSAGE_END, messageId: `${RUN}:feedback` },
			expect.objectContaining({
				type: EventType.RUN_ERROR,
				code: "RUN_FAILED",
			}),
		]);
		expect(resultOf(events)).toBeUndefined();
		expect(m.recordProcedureActivity).not.toHaveBeenCalled();
		expect(m.captureProcedureError).toHaveBeenCalledWith(
			failure,
			AUDIT,
			expect.objectContaining({ projectId: PROJECT }),
			REFINE_PATH,
		);
		expect(await errorRow()).toMatchObject({
			outcome: "failure",
			organizationId: AUTHORIZED_ORG,
			projectId: PROJECT,
		});
		log.mockRestore();
	});

	it("ends a ChatGPT plan that needs reconnecting with the plan's refusal", async () => {
		const refusal = new ChatGptPlanAuthError(
			"refresh token reused",
			"refresh_token_reused",
			true,
		);
		m.resolveRefineModel.mockRejectedValue(refusal);

		const events = await run();

		expect(events.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.RUN_ERROR,
		]);
		expect(events[1]).toMatchObject({
			code: "CHATGPT_PLAN_UNAVAILABLE",
			message: CHATGPT_PLAN_RECONNECT_REQUIRED_MESSAGE,
			metadata: { fabric: { status: 409 } },
		});
		expect(m.streamText).not.toHaveBeenCalled();
		expect(m.captureProcedureError).toHaveBeenCalledWith(
			refusal,
			AUDIT,
			expect.objectContaining({ projectId: PROJECT }),
			REFINE_PATH,
		);
	});

	it("ends a spent usage limit with its own refusal and limits", async () => {
		const limit = new AiUsageLimitExceededError({
			message: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
			limitId: "limit-1",
			dimension: "TOKENS",
			window: "MONTHLY",
			used: BigInt(100),
			max: BigInt(100),
			manageLimitsUrl: "https://example.com/limits",
		});
		m.resolveRefineModel.mockRejectedValue(limit);

		const events = await run();

		expect(events.at(-1)).toMatchObject({
			type: EventType.RUN_ERROR,
			code: "AI_USAGE_LIMIT_EXCEEDED",
			message: limit.message,
			metadata: { fabric: { data: { limitId: "limit-1" } } },
		});
		expect(m.streamText).not.toHaveBeenCalled();
	});

	it("after a stop sends nothing more and no result, but reads the model to its end and records it", async () => {
		const afterFirst = pause();
		m.reply.pauseAfterFirst = afterFirst.hold;
		const engine = new WeaveRefineEngine(CALLER);
		const stream = collector();

		const running = engine.run(
			{ threadId: THREAD, input: input() },
			stream,
		);
		await afterFirst.reached;
		const sentBeforeStop = stream.events.length;
		expect(await engine.stop(THREAD)).toBe(true);
		afterFirst.release();
		await running;

		expect(deltasOf(stream.events)).toEqual(["Which"]);
		expect(
			stream.events.slice(sentBeforeStop).map((event) => event.type),
		).toEqual([EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED]);
		expect(m.reply.readToEnd).toBe(true);
		expect(m.recordProcedureActivity).toHaveBeenCalledTimes(1);
		expect(await engine.isRunning(THREAD)).toBe(false);
	});
});
