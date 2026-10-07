/**
 * Only an Advisor chat may draw on the organization's company context
 * (Fizzy #2719).
 *
 * The Orchestrator chat component is mounted by the Advisor page, the Fabric
 * Agent drawer, the MCP chat dialog and a registered agent's try workspace,
 * and all of them send the same `surface`. The Advisor page and the drawer
 * also send `advisorOrigin`, and the route opts the workflow in
 * (`companyContextAdvisor`) only then; the workflow still checks membership
 * and the feature gate itself. These tests pin the route's half, and that
 * only the two Advisor mounts pass the field to the chat.
 *
 * Harness mirrors orchestrator-project-tenant.test.ts.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const getAIModelWithMetadataMock = vi.fn();
const getTemporalClientMock = vi.fn();
const startWorkflowMock = vi.fn();
const memberFindFirstMock = vi.fn();
const projectFindUniqueMock = vi.fn();

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
	getTemporalClient: () => getTemporalClientMock(),
}));

vi.mock("@repo/database", async () => ({
	// Turn admission (see ./_helpers/conversation-turn-db-mocks.ts).
	...(
		await import("./_helpers/conversation-turn-db-mocks")
	).conversationTurnDbMocks(),
	CARRIED_OVER_MARKER_PREFIX: "[carried-over]",
	db: {
		agentConversation: { findFirst: vi.fn(async () => null) },
		member: {
			findFirst: (...args: unknown[]) => memberFindFirstMock(...args),
		},
		project: {
			findUnique: (...args: unknown[]) => projectFindUniqueMock(...args),
		},
		aiChat: { findFirst: vi.fn(async () => null) },
	},
	getConversationWorkspaces: vi.fn(async () => []),
	getConversationProject: vi.fn(async () => null),
	hasProjectAccess: vi.fn(async () => true),
	filterAccessibleWorkspaceIds: vi.fn(async () => ({
		allowed: [],
		dropped: [],
	})),
}));

const SESSION_USER_ID = "user-1";
const ORGANIZATION_ID = "example-org";

function postBody(b: Record<string, unknown>) {
	return { json: async () => b } as never;
}

async function post(body: Record<string, unknown>) {
	const { POST } = await import(
		"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
	);
	const response = await POST(postBody(body));
	await response.text();
	return response;
}

function startedInput(): Record<string, unknown> | undefined {
	return startWorkflowMock.mock.calls[0]?.[1]?.args?.[0] as
		| Record<string, unknown>
		| undefined;
}

/** What the shared chat sends from every mount: the same surface. */
const CHAT_BODY = {
	message: "Which case studies do we have in logistics?",
	organizationId: ORGANIZATION_ID,
	surface: "loom-orchestrator",
};

describe("POST orchestrator-temporal/stream — the Advisor's company-context opt-in", () => {
	const originalCacheHost = process.env.CACHE_HOST;
	const originalRedisUrl = process.env.REDIS_URL;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		// Keep `getRedisUrl()` at null so the route never reaches for ioredis.
		delete process.env.CACHE_HOST;
		delete process.env.REDIS_URL;

		// A real session always carries its `session` record.
		getSessionMock.mockResolvedValue({
			user: { id: SESSION_USER_ID },
			session: {},
		});
		getAIModelWithMetadataMock.mockResolvedValue({ trackUsage: vi.fn() });
		memberFindFirstMock.mockResolvedValue({ id: "member-1" });
		projectFindUniqueMock.mockResolvedValue({
			organizationId: ORGANIZATION_ID,
		});
		startWorkflowMock.mockResolvedValue({
			workflowId: "wf-company-context",
			describe: async () => ({
				status: { name: "COMPLETED" },
				memo: { userId: SESSION_USER_ID },
			}),
			query: async () => {
				throw new Error("workflow closed");
			},
			result: async () => ({ status: "completed", response: "ok" }),
		});
		getTemporalClientMock.mockResolvedValue({
			workflow: { getHandle: vi.fn(), start: startWorkflowMock },
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

	it("opts in a chat started from the Advisor", async () => {
		const response = await post({ ...CHAT_BODY, advisorOrigin: true });

		expect(response.status).toBe(200);
		expect(startedInput()?.companyContextAdvisor).toBe(true);
	});

	// Fizzy #2939: the Fabric Agent drawer (⌘J) runs this route in Simple
	// mode, and the person typing the turn may have it served by their own
	// ChatGPT plan.
	it("marks a turn typed in the drawer plan-eligible, at the check and in the run", async () => {
		const response = await post({ ...CHAT_BODY, advisorOrigin: true });

		expect(response.status).toBe(200);
		expect(getAIModelWithMetadataMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				userId: SESSION_USER_ID,
				planEligible: true,
			}),
		);
		expect(startedInput()?.planEligible).toBe(true);
	});

	it("runs the turn as the member's own request, as the plan gate sees it", async () => {
		const { isAiImpersonatedRequest, isAiInteractiveRequestFor } =
			await import("@repo/ai/lib/chatgpt-plan/interactive-context");
		const seen: Array<{ own: boolean; impersonated: boolean }> = [];
		getAIModelWithMetadataMock.mockImplementation(async () => {
			seen.push({
				own: isAiInteractiveRequestFor(SESSION_USER_ID),
				impersonated: isAiImpersonatedRequest(),
			});
			return { trackUsage: vi.fn() };
		});

		await post({ ...CHAT_BODY, advisorOrigin: true });

		expect(seen[0]).toEqual({ own: true, impersonated: false });
	});

	it("marks a turn an admin types while acting as the member as impersonated", async () => {
		const { isAiImpersonatedRequest, isAiInteractiveRequestFor } =
			await import("@repo/ai/lib/chatgpt-plan/interactive-context");
		getSessionMock.mockResolvedValue({
			user: { id: SESSION_USER_ID },
			session: { impersonatedBy: "admin-1" },
		});
		const seen: Array<{ own: boolean; impersonated: boolean }> = [];
		getAIModelWithMetadataMock.mockImplementation(async () => {
			seen.push({
				own: isAiInteractiveRequestFor(SESSION_USER_ID),
				impersonated: isAiImpersonatedRequest(),
			});
			return { trackUsage: vi.fn() };
		});

		await post({ ...CHAT_BODY, advisorOrigin: true });

		// The gate then refuses the plan, and the Temporal start below clears
		// the run's plan eligibility (both tested where they live).
		expect(seen[0]).toEqual({ own: false, impersonated: true });
	});

	it("refuses with 409 instead of billing the organization when the plan needs reconnecting", async () => {
		const { ChatGptPlanAuthError } = await import(
			"@repo/ai/lib/chatgpt-plan/oauth"
		);
		getAIModelWithMetadataMock.mockRejectedValue(
			new ChatGptPlanAuthError("Reconnect", "needs_reconnect", true),
		);

		const { POST } = await import(
			"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
		);
		const response = await POST(
			postBody({ ...CHAT_BODY, advisorOrigin: true }),
		);

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			code: "CHATGPT_PLAN_UNAVAILABLE",
		});
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("opts in an Advisor chat with a project of its organization", async () => {
		await post({
			...CHAT_BODY,
			advisorOrigin: true,
			projectId: "project-of-example-org",
		});

		expect(startedInput()?.companyContextAdvisor).toBe(true);
		expect(startedInput()?.projectId).toBe("project-of-example-org");
	});

	// The MCP chat dialog and a registered agent's try workspace mount the
	// same chat with the same surface, and send no origin.
	it("leaves the MCP chat dialog and the try workspace out", async () => {
		await post(CHAT_BODY);

		expect(startedInput()).toBeDefined();
		expect(startedInput()).not.toHaveProperty("companyContextAdvisor");
	});

	it("counts only a literal true", async () => {
		for (const advisorOrigin of ["true", 1, "advisor", false, null]) {
			startWorkflowMock.mockClear();
			await post({ ...CHAT_BODY, advisorOrigin });
			expect(startedInput(), String(advisorOrigin)).not.toHaveProperty(
				"companyContextAdvisor",
			);
		}
	});

	it("keeps the memo's shape", async () => {
		await post({ ...CHAT_BODY, advisorOrigin: true });

		expect(startWorkflowMock.mock.calls[0]?.[1]?.memo).toEqual({
			userId: SESSION_USER_ID,
			organizationId: ORGANIZATION_ID,
			turnId: "turn-example-1",
		});
	});
});

describe("who sends the Advisor origin", () => {
	const source = (relative: string) =>
		readFileSync(
			resolve(__dirname, "../../modules/saas", relative),
			"utf8",
		);

	/** The JSX element that mounts the Orchestrator chat in `file`. */
	function orchestratorMount(file: string): string {
		const code = source(file);
		const start = code.indexOf("<FabricTemporalOrchestratorChat");
		expect(start, file).toBeGreaterThan(-1);
		return code.slice(start, code.indexOf("/>", start));
	}

	it("the Advisor page and the Fabric Agent drawer send it", () => {
		for (const file of [
			"agents/components/fabric-ai/FabricAIClient.tsx",
			"agents/components/FabricAgentLauncher.tsx",
		]) {
			expect(orchestratorMount(file), file).toMatch(/\badvisorOrigin\b/);
		}
	});

	it("the MCP chat dialog and a registered agent's try workspace do not", () => {
		for (const file of [
			"mcp/components/McpChatDialog.tsx",
			"agents/components/RegisteredAgentTryWorkspace.tsx",
		]) {
			expect(orchestratorMount(file), file).not.toContain(
				"advisorOrigin",
			);
			expect(source(file), file).not.toContain("advisorOrigin");
		}
	});

	// That the hook sends it on the first request only, never on a
	// reconnect, is rendered in useOrchestratorStream.test.ts.
	it("is never sent from Nexus", () => {
		expect(source("agents/hooks/useMultiAgentStream.ts")).not.toContain(
			"advisorOrigin",
		);
	});

	// The search is always on for a member and never a per-chat choice.
	it("is absent from the Advisor's tool pickers", () => {
		for (const file of [
			"agents/components/OrchestratorConfigPanel.tsx",
			"agents/lib/builtin-tool-map.ts",
			"agents/components/FabricChat/shared/ActiveContextIndicator.tsx",
		]) {
			expect(source(file), file).not.toContain("search_company_context");
		}
	});
});
