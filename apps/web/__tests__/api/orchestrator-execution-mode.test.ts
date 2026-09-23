/**
 * Both Orchestrator start routes validate `executionMode` (Fizzy #2040).
 *
 * The bodies are parsed by hand, and `executionMode` used to be cast straight
 * into the workflow input, so any string a client sent reached the workflow,
 * which quietly fell back to `balanced`. Simple mode now asks for the
 * `iterative` preset by name, so an unknown value must be refused rather than
 * silently run on a different preset.
 *
 * Harness mirrors orchestrator-start-requires-org.test.ts and
 * orchestrator-workspace-access.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const getAIModelWithMetadataMock = vi.fn();
const hasOrganizationTieMock = vi.fn();
const startWorkflowMock = vi.fn();
const memberFindFirstMock = vi.fn();

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => getSessionMock(),
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...args: unknown[]) =>
		getAIModelWithMetadataMock(...args),
}));

vi.mock("@repo/agent-core/backend", () => ({
	getDefaultEnabledMcpConfigIds: vi.fn(async () => []),
}));

vi.mock("@repo/observability", () => ({
	metricsTracker: { trackAiLimitSignal: vi.fn() },
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));

vi.mock("@repo/temporal", () => ({
	ORCHESTRATOR_TASK_QUEUE: "fabric-orchestrator",
	getTemporalClient: vi.fn(async () => ({
		workflow: {
			start: startWorkflowMock,
			getHandle: vi.fn(),
		},
	})),
}));

vi.mock("@repo/database", () => ({
	CARRIED_OVER_MARKER_PREFIX: "[carried-over]",
	db: {
		agentConversation: { findFirst: vi.fn(async () => null) },
		member: {
			findFirst: (...args: unknown[]) => memberFindFirstMock(...args),
		},
		aiChat: { findFirst: vi.fn(async () => null) },
	},
	hasOrganizationTie: (...args: unknown[]) => hasOrganizationTieMock(...args),
	getConversationWorkspaces: vi.fn(async () => []),
	getConversationProject: vi.fn(async () => null),
	hasProjectAccess: vi.fn(async () => true),
	filterAccessibleWorkspaceIds: vi.fn(async () => ({
		allowed: [],
		dropped: [],
	})),
}));

const USER_ID = "user-execution-mode-1";
const ORGANIZATION_ID = "example-org";

function postBody(b: Record<string, unknown>) {
	return { json: async () => b } as never;
}

function startedExecutionMode(): unknown {
	const input = startWorkflowMock.mock.calls[0]?.[1]?.args?.[0] as
		| { executionMode?: unknown }
		| undefined;
	return input?.executionMode;
}

const originalCacheHost = process.env.CACHE_HOST;
const originalRedisUrl = process.env.REDIS_URL;

beforeEach(() => {
	vi.clearAllMocks();
	// Keep `getRedisUrl()` at null so neither route reaches for ioredis.
	delete process.env.CACHE_HOST;
	delete process.env.REDIS_URL;

	getSessionMock.mockResolvedValue({
		user: { id: USER_ID },
		session: { activeOrganizationId: ORGANIZATION_ID },
	});
	getAIModelWithMetadataMock.mockResolvedValue({ trackUsage: vi.fn() });
	hasOrganizationTieMock.mockResolvedValue(true);
	memberFindFirstMock.mockResolvedValue({ id: "member-1" });
	startWorkflowMock.mockResolvedValue({
		workflowId: "wf-execution-mode",
		describe: async () => ({
			status: { name: "COMPLETED" },
			memo: { userId: USER_ID },
		}),
		query: async () => {
			throw new Error("workflow closed");
		},
		result: async () => ({ status: "completed", response: "ok" }),
	});
});

afterEach(() => {
	if (originalCacheHost === undefined) {
		delete process.env.CACHE_HOST;
	} else {
		process.env.CACHE_HOST = originalCacheHost;
	}
	if (originalRedisUrl === undefined) {
		delete process.env.REDIS_URL;
	} else {
		process.env.REDIS_URL = originalRedisUrl;
	}
});

describe("POST orchestrator-temporal — executionMode", () => {
	async function post(body: Record<string, unknown>) {
		const { POST } = await import(
			"../../app/api/agents/fabric-ai/orchestrator-temporal/route"
		);
		const response = await POST(postBody(body));
		return { status: response.status, body: await response.json() };
	}

	it("refuses an unknown execution mode before starting anything", async () => {
		const { status, body } = await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			executionMode: "turbo",
		});

		expect(status).toBe(400);
		expect(body.error).toBe("Invalid request body");
		expect(body.message).toContain("iterative");
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("refuses a non-string execution mode", async () => {
		const { status } = await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			executionMode: { mode: "fast" },
		});

		expect(status).toBe(400);
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("threads the iterative preset through to the workflow", async () => {
		const { status } = await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			executionMode: "iterative",
		});

		expect(status).toBe(200);
		expect(startedExecutionMode()).toBe("iterative");
	});

	it("keeps running a legacy reasoning-mode name on balanced, as the workflow always did", async () => {
		const { status } = await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			executionMode: "deep",
		});

		expect(status).toBe(200);
		expect(startedExecutionMode()).toBe("balanced");
	});

	it("refuses an explicit null mode", async () => {
		const { status } = await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			executionMode: null,
		});

		expect(status).toBe(400);
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("defaults an omitted mode to balanced", async () => {
		const { status } = await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
		});

		expect(status).toBe(200);
		expect(startedExecutionMode()).toBe("balanced");
	});
});

describe("POST orchestrator-temporal/stream — executionMode", () => {
	async function post(body: Record<string, unknown>) {
		const { POST } = await import(
			"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
		);
		const response = await POST(postBody(body));
		const text = await response.text();
		return { status: response.status, text };
	}

	it("refuses an unknown execution mode before starting anything", async () => {
		const { status, text } = await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			executionMode: "turbo",
		});

		expect(status).toBe(400);
		expect(JSON.parse(text).error).toBe("Invalid request body");
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("threads the iterative preset through to the workflow", async () => {
		const { status } = await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			executionMode: "iterative",
		});

		expect(status).toBe(200);
		expect(startedExecutionMode()).toBe("iterative");
	});

	it("still accepts the multi-agent stream's `deep` and runs it on balanced", async () => {
		const { status } = await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			executionMode: "deep",
		});

		expect(status).toBe(200);
		expect(startedExecutionMode()).toBe("balanced");
	});
});
