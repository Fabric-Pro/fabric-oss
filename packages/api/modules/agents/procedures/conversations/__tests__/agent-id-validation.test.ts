// packages/api/modules/agents/procedures/conversations/__tests__/agent-id-validation.test.ts
/**
 * Procedure-level tests for the createConversation agentId validation gate.
 *
 * Fizzy #1412 round-2 follow-up — UPDATED 2026-05-28 hotfix:
 * gate 1 (existence) remains a hard ORPCError(BAD_REQUEST); gate 2
 * (status === "ACTIVE") was loosened to console.warn after the
 * staging-incident showed it could turn transient health-monitor
 * noise (stale localhost deploymentUrls from a misconfigured seed,
 * brief ACA cold starts, network blips) into a hard customer block.
 *
 * The handler now guards against:
 *
 *   1. Typo drift between frontend constants and Temporal-side constants
 *      (backlog-constants.ts BACKLOG_AGENT_ID = "backlog_updater"; if a
 *      caller sends "backlog-updater" by mistake, gate 1 rejects it
 *      before the row reaches the database).
 *
 *   2. Conversations being created against completely fictitious agentIds
 *      that don't exist in the catalog at all — these would have no
 *      displayName, no icon, no telemetry attribution downstream. Gate 1
 *      rejects them with a clear allow-list message.
 *
 *   3. Non-ACTIVE catalog rows surface as a structured `console.warn`
 *      (not a hard 400) so health-monitor blips don't block customer
 *      chats; a follow-up PR can re-tighten this once the catalog-
 *      status reliability has been audited end-to-end.
 *
 * Uses the same captured-handler pattern as persist-reasoning-gate.test.ts:
 * mock the oRPC chainable builder to capture the raw handler function, then
 * call it directly with a mocked context + input. This exercises the REAL
 * validation logic in create-conversation.ts (not a copy in the test). If
 * a future refactor removes the validation, these tests fail.
 */
import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createAgentConversation: vi.fn(),
	getRegisteredAgentByAgentId: vi.fn(),
	resolveOrganizationId: vi.fn(),
	captured: {
		createConversation: null as
			| ((args: { context: any; input: any }) => Promise<any>)
			| null,
	},
}));

vi.mock("@repo/database", () => ({
	createAgentConversation: mocks.createAgentConversation,
	getRegisteredAgentByAgentId: mocks.getRegisteredAgentByAgentId,
	// Constants required by @repo/ai (transitively loaded — see
	// persist-reasoning-gate.test.ts for the full explanation).
	GATEWAY_PROVIDERS: [],
	DIRECT_PROVIDERS: [],
	AI_PROVIDER_METADATA: {},
	getProviderDisplayName: vi.fn(),
	getProviderMetadata: vi.fn(),
	isDirectProvider: vi.fn(),
	isGatewayProvider: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: vi.fn(),
}));

vi.mock("../../../../../orpc/procedures", () => {
	// Chainable builder that captures the createConversation handler.
	// update-conversation.ts is NOT imported in this file (we test only the
	// create path), so the first chain we see IS createConversation.
	const makeChain = (): any => ({
		use: () => makeChain(),
		route: () => makeChain(),
		input: () => makeChain(),
		output: () => makeChain(),
		handler: (fn: any) => {
			mocks.captured.createConversation = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: makeChain(),
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireInputOrgPermission: () => (c: unknown) => c,
		resolveOrganizationId: mocks.resolveOrganizationId,
	};
});

// Side-effect import — registers the createConversation handler.
import "../create-conversation";

const USER_ID = "user-1";
const CONV_ID = "conv-1";

function makeContext() {
	mocks.resolveOrganizationId.mockReturnValue(null);
	return {
		user: { id: USER_ID },
		session: { activeOrganizationId: null },
	};
}

beforeEach(() => {
	mocks.createAgentConversation.mockReset();
	mocks.getRegisteredAgentByAgentId.mockReset();
	mocks.resolveOrganizationId.mockReset();
	// Default-active stub so a future test that forgets `mockResolvedValueOnce`
	// doesn't silently land in the unknown-agent path (which would then mask
	// the real intent of that test). Each test below uses `mockResolvedValueOnce`
	// to override per-case.
	mocks.getRegisteredAgentByAgentId.mockResolvedValue({
		agentId: "default-active",
		status: "ACTIVE",
		name: "Default Active",
		displayName: "Default Active",
	});
});

afterEach(() => {
	// No env state to clean up — kept for symmetry with the other test file
	// in case future cases use process.env.
});

describe("createConversation handler — agentId validation gate", () => {
	it("delegates to createAgentConversation when agentId is the canonical 'fabric-workspace-assistant'", async () => {
		// Tier 1 chat regression guard: FabricDirectChat, useOrchestratorConversation,
		// FabricAIClient, and the E2E regression spec all pass
		// `agentId = "fabric-workspace-assistant"` to conversations.create. The
		// legacy "fabric-ai" alias was retired by the cleanup PR following
		// #1236 — the seed alias entry is gone, the existing AgentConversation
		// rows were renamed via Prisma migration, and the frontend call sites
		// were migrated to the canonical id. This test pins the contract so
		// any future change that breaks the canonical happy path fails
		// loudly here rather than silently breaking the Tier 1 chat surfaces
		// that PR #1233 wired into Step 6.
		mocks.getRegisteredAgentByAgentId.mockResolvedValueOnce({
			agentId: "fabric-workspace-assistant",
			status: "ACTIVE",
			name: "fabric_workspace_assistant",
			displayName: "Fabric",
		});
		mocks.createAgentConversation.mockResolvedValueOnce({
			id: CONV_ID,
			agentId: "fabric-workspace-assistant",
			title: "First message",
			createdAt: new Date(),
		});

		await mocks.captured.createConversation!({
			context: makeContext(),
			input: {
				organizationId: null,
				agentId: "fabric-workspace-assistant",
				title: "First message",
			},
		});

		expect(mocks.getRegisteredAgentByAgentId).toHaveBeenCalledWith(
			"fabric-workspace-assistant",
		);
		expect(mocks.createAgentConversation).toHaveBeenCalledTimes(1);
		const callArg = mocks.createAgentConversation.mock.calls[0]?.[0];
		expect(callArg?.agentId).toBe("fabric-workspace-assistant");
	});

	it("ALSO delegates when agentId is the 'fabric-ai' compat alias (deprecation window)", async () => {
		// Conservative rollout (Codex round-2 on PR #1239): the "fabric-ai"
		// alias entry STAYS in seed-system-agents.ts during the graceful
		// deprecation window so stale browser tabs running pre-cleanup
		// frontend code continue to work post-Vercel-deploy. New code uses
		// the canonical "fabric-workspace-assistant" (asserted in the
		// canonical test above), but the alias must also pass the gate
		// until the follow-up PR drops the seed entry after observability
		// confirms zero callers. This test pins that the alias survives
		// this PR — a future PR that prematurely removes the alias entry
		// without first verifying zero traffic will fail loudly here
		// rather than silently 400ing stale clients.
		mocks.getRegisteredAgentByAgentId.mockResolvedValueOnce({
			agentId: "fabric-ai",
			status: "ACTIVE",
			name: "fabric_ai",
			displayName: "Fabric",
		});
		mocks.createAgentConversation.mockResolvedValueOnce({
			id: CONV_ID,
			agentId: "fabric-ai",
			title: "Stale-client first message",
			createdAt: new Date(),
		});

		await mocks.captured.createConversation!({
			context: makeContext(),
			input: {
				organizationId: null,
				agentId: "fabric-ai",
				title: "Stale-client first message",
			},
		});

		expect(mocks.getRegisteredAgentByAgentId).toHaveBeenCalledWith(
			"fabric-ai",
		);
		expect(mocks.createAgentConversation).toHaveBeenCalledTimes(1);
		const callArg = mocks.createAgentConversation.mock.calls[0]?.[0];
		expect(callArg?.agentId).toBe("fabric-ai");
	});

	it("delegates to createAgentConversation when agent is registered and ACTIVE", async () => {
		mocks.getRegisteredAgentByAgentId.mockResolvedValueOnce({
			agentId: "backlog_updater",
			status: "ACTIVE",
			name: "Backlog Updater",
			displayName: "Backlog Updater",
		});
		mocks.createAgentConversation.mockResolvedValueOnce({
			id: CONV_ID,
			agentId: "backlog_updater",
			title: "Backlog session",
			createdAt: new Date(),
		});

		const result = await mocks.captured.createConversation!({
			context: makeContext(),
			input: {
				organizationId: null,
				agentId: "backlog_updater",
				title: "Backlog session",
			},
		});

		expect(mocks.getRegisteredAgentByAgentId).toHaveBeenCalledWith(
			"backlog_updater",
		);
		expect(mocks.createAgentConversation).toHaveBeenCalledTimes(1);
		const callArg = mocks.createAgentConversation.mock.calls[0]?.[0];
		expect(callArg?.agentId).toBe("backlog_updater");
		expect(callArg?.userId).toBe(USER_ID);
		expect(result.id).toBe(CONV_ID);
	});

	it("rejects unknown agentId with BAD_REQUEST and does NOT touch the DB", async () => {
		mocks.getRegisteredAgentByAgentId.mockResolvedValueOnce(null);

		await expect(
			mocks.captured.createConversation!({
				context: makeContext(),
				input: {
					organizationId: null,
					agentId: "backlog-updater", // dash instead of underscore — typo
					title: "Backlog session",
				},
			}),
		).rejects.toThrow(ORPCError);

		expect(mocks.getRegisteredAgentByAgentId).toHaveBeenCalledWith(
			"backlog-updater",
		);
		expect(mocks.createAgentConversation).not.toHaveBeenCalled();
	});

	it("includes the offending agentId in the BAD_REQUEST message", async () => {
		mocks.getRegisteredAgentByAgentId.mockResolvedValueOnce(null);

		let captured: unknown;
		try {
			await mocks.captured.createConversation!({
				context: makeContext(),
				input: {
					organizationId: null,
					agentId: "made-up-agent-id",
				},
			});
		} catch (error) {
			captured = error;
		}

		expect(captured).toBeInstanceOf(ORPCError);
		// The message must surface the bad agentId so a developer reading logs
		// can diagnose the drift without correlating across files.
		expect((captured as ORPCError<string, unknown>).message).toContain(
			"made-up-agent-id",
		);
	});

	it("warns about INACTIVE agent but DOES create the conversation (gate 2 loosened)", async () => {
		// Gate 2 was a hard block in the original PR #1236 ship. Staging
		// incident 2026-05-28 showed that the catalog `status` column is
		// owned by the agent-health-monitor and flips to non-ACTIVE for
		// transient reasons (stale localhost deploymentUrls from a
		// misconfigured seed, brief ACA cold start, network blip) that
		// are independent of whether the user-facing chat should function.
		// The hotfix downgrades the gate to a `console.warn` so transient
		// health-monitor noise can't hard-block customer chat creation.
		// Existence (gate 1) and Zod bounds remain strict.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.getRegisteredAgentByAgentId.mockResolvedValueOnce({
			agentId: "fabric-workspace-assistant",
			status: "INACTIVE",
			name: "Fabric",
			displayName: "Fabric",
		});
		mocks.createAgentConversation.mockResolvedValueOnce({
			id: CONV_ID,
			agentId: "fabric-workspace-assistant",
			title: null,
			createdAt: new Date(),
		});

		await mocks.captured.createConversation!({
			context: makeContext(),
			input: {
				organizationId: null,
				agentId: "fabric-workspace-assistant",
			},
		});

		expect(mocks.createAgentConversation).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toContain("non-ACTIVE");
		expect(warnSpy.mock.calls[0]?.[0]).toContain("INACTIVE");
		warnSpy.mockRestore();
	});

	it("warns about ERROR-status agent but DOES create the conversation (gate 2 loosened)", async () => {
		// Mirror of the INACTIVE case — the staging incident that triggered
		// this hotfix had every seeded system_agent in status=ERROR because
		// the health monitor was probing seed-time-resolved localhost URLs
		// from a serverless context that obviously couldn't reach them.
		// ERROR must not block conversation creation.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.getRegisteredAgentByAgentId.mockResolvedValueOnce({
			agentId: "broken_agent",
			status: "ERROR",
			name: "Broken",
			displayName: "Broken",
		});
		mocks.createAgentConversation.mockResolvedValueOnce({
			id: CONV_ID,
			agentId: "broken_agent",
			title: null,
			createdAt: new Date(),
		});

		await mocks.captured.createConversation!({
			context: makeContext(),
			input: {
				organizationId: null,
				agentId: "broken_agent",
			},
		});

		expect(mocks.createAgentConversation).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toContain("ERROR");
		warnSpy.mockRestore();
	});

	it("surfaces the actual status + agentId in the warn payload", async () => {
		// Logged context must let a developer reading Vercel runtime logs
		// correlate the warn to the offending agentId without cross-file
		// archaeology — same intent as the pre-hotfix error message, just
		// routed to stdout instead of HTTP 400.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.getRegisteredAgentByAgentId.mockResolvedValueOnce({
			agentId: "fabric-workspace-assistant",
			status: "ERROR",
			name: "Fabric",
			displayName: "Fabric",
		});
		mocks.createAgentConversation.mockResolvedValueOnce({
			id: CONV_ID,
			agentId: "fabric-workspace-assistant",
			title: null,
			createdAt: new Date(),
		});

		await mocks.captured.createConversation!({
			context: makeContext(),
			input: {
				organizationId: null,
				agentId: "fabric-workspace-assistant",
			},
		});

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const [msg, ctx] = warnSpy.mock.calls[0] ?? [];
		expect(msg).toContain("status=ERROR");
		expect(ctx).toMatchObject({ agentId: "fabric-workspace-assistant" });
		warnSpy.mockRestore();
	});

	it("does NOT warn when agent is ACTIVE (baseline — no noise on happy path)", async () => {
		// Regression guard for the hotfix: ACTIVE agents must NOT trigger
		// the warn log. Otherwise Vercel runtime logs would flood with
		// false-positive non-ACTIVE warnings on every chat creation.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.getRegisteredAgentByAgentId.mockResolvedValueOnce({
			agentId: "fabric-workspace-assistant",
			status: "ACTIVE",
			name: "Fabric",
			displayName: "Fabric",
		});
		mocks.createAgentConversation.mockResolvedValueOnce({
			id: CONV_ID,
			agentId: "fabric-workspace-assistant",
			title: null,
			createdAt: new Date(),
		});

		await mocks.captured.createConversation!({
			context: makeContext(),
			input: {
				organizationId: null,
				agentId: "fabric-workspace-assistant",
			},
		});

		expect(mocks.createAgentConversation).toHaveBeenCalledTimes(1);
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("runs agentId validation BEFORE resolveOrganizationId (ordering)", async () => {
		// The handler should reject bad agentIds before doing any other work,
		// both because agentId is a context-free input field and because a bad
		// agentId is a cheap input error that should short-circuit early.
		// `invocationCallOrder` is Vitest's monotonic global counter — strictly
		// less means "called earlier".
		mocks.getRegisteredAgentByAgentId.mockResolvedValueOnce({
			agentId: "task_planner",
			status: "ACTIVE",
			name: "Task Planner",
			displayName: "Task Planner",
		});
		mocks.createAgentConversation.mockResolvedValueOnce({
			id: CONV_ID,
			agentId: "task_planner",
			title: null,
			createdAt: new Date(),
		});

		await mocks.captured.createConversation!({
			context: makeContext(),
			input: {
				organizationId: null,
				agentId: "task_planner",
			},
		});

		expect(mocks.getRegisteredAgentByAgentId).toHaveBeenCalledTimes(1);
		expect(mocks.resolveOrganizationId).toHaveBeenCalledTimes(1);
		expect(mocks.createAgentConversation).toHaveBeenCalledTimes(1);

		const lookupOrder =
			mocks.getRegisteredAgentByAgentId.mock.invocationCallOrder[0]!;
		const resolveOrder =
			mocks.resolveOrganizationId.mock.invocationCallOrder[0]!;
		const createOrder =
			mocks.createAgentConversation.mock.invocationCallOrder[0]!;
		expect(lookupOrder).toBeLessThan(resolveOrder);
		expect(resolveOrder).toBeLessThan(createOrder);
	});

	it("rejects empty-string agentId at the handler level (defense in depth)", async () => {
		// The Zod schema rejects empty agentId at the API boundary (min(1)).
		// The captured-handler tests bypass Zod (the mocked oRPC builder
		// discards `.input(...)`), so this test exercises the handler-level
		// defense path: even if input validation were skipped, the catalog
		// gate still rejects an empty string because no `RegisteredAgent`
		// row matches `agentId = ""`. The two layers together make the
		// contract robust to refactors that move/remove either.
		mocks.getRegisteredAgentByAgentId.mockResolvedValueOnce(null);

		await expect(
			mocks.captured.createConversation!({
				context: makeContext(),
				input: {
					organizationId: null,
					agentId: "",
				},
			}),
		).rejects.toThrow(ORPCError);

		expect(mocks.createAgentConversation).not.toHaveBeenCalled();
		// resolveOrganizationId must not run either — bad agentId short-circuits
		// before any context-bound work happens.
		expect(mocks.resolveOrganizationId).not.toHaveBeenCalled();
	});

	it("rejects whitespace-only agentId at the handler level (defense in depth)", async () => {
		// Codex round-3 finding #2: `"   "` (3 spaces) passes `.min(1)` by
		// raw length. The Zod schema now applies `.trim()` before `.min(1)`
		// so it's rejected at the API boundary. As with the empty-string
		// case above, captured-handler tests bypass Zod entirely — this
		// test exercises the handler's defensive backstop: a raw
		// whitespace-only agentId reaches `getRegisteredAgentByAgentId`,
		// returns null (no catalog row matches "   "), and the BAD_REQUEST
		// path fires. The two layers together (Zod trim + catalog gate)
		// make the contract robust if a future refactor removes either.
		mocks.getRegisteredAgentByAgentId.mockResolvedValueOnce(null);

		await expect(
			mocks.captured.createConversation!({
				context: makeContext(),
				input: {
					organizationId: null,
					agentId: "   ",
				},
			}),
		).rejects.toThrow(ORPCError);

		expect(mocks.createAgentConversation).not.toHaveBeenCalled();
		expect(mocks.resolveOrganizationId).not.toHaveBeenCalled();
	});

	it("does NOT call resolveOrganizationId when agentId is rejected", async () => {
		// Companion to the empty-string case: this verifies the
		// short-circuit holds for the more common "typo'd agentId" path too.
		// After RV1 (reordering), agentId validation is the FIRST async work
		// in the handler — when it throws, nothing downstream runs. This is a
		// mini-regression test against a future refactor that puts
		// resolveOrganizationId back above the catalog lookup.
		mocks.getRegisteredAgentByAgentId.mockResolvedValueOnce(null);

		await expect(
			mocks.captured.createConversation!({
				context: makeContext(),
				input: {
					organizationId: null,
					agentId: "totally-fake-agent",
				},
			}),
		).rejects.toThrow(ORPCError);

		expect(mocks.resolveOrganizationId).not.toHaveBeenCalled();
		expect(mocks.createAgentConversation).not.toHaveBeenCalled();
	});
});
