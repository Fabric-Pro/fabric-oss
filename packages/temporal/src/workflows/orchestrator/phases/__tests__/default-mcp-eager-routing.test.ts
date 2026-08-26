/**
 * Default-MCP eager routing — workflow phase unit tests.
 *
 * Exercises `applyDefaultMcpEagerRouting` in isolation. The helper is the
 * gate that decides whether to:
 *   - eager-load the matched server's `eagerToolName` into `discoveredTools`,
 *   - register `suppressOnEager` names for suppression for the turn, or
 *   - short-circuit to the "service-down" CTA branch.
 *
 * This file was renamed from `nexus-excalidraw-routing.test.ts` when the
 * helper was generalized away from a hardcoded Nexus/Excalidraw path. The
 * five baseline behavioral cases mirror the prior contract verbatim —
 * wired through the new discriminated-union return type. Additional
 * coverage:
 *   - Surface-gate matrix (every literal in `TEMPORAL_ROUTED_SURFACES` plus
 *     the explicit `"copilot"` exclusion plus `undefined` for legacy callers).
 *   - Empty-registry skip path.
 *   - The two extra failure-mode branches of the discriminated union
 *     (`failureKind: "server-unreachable"` from a throw and
 *     `failureKind: "schema-mismatch"` from a missing eagerToolName).
 *   - First-match-wins ordering across two default-enabled rows.
 *   - Explicit tenant XOR assertion on the activity's call args (both
 *     personal-context — `organizationId: undefined` — and org-context).
 *
 * The activity proxies (`findDefaultMcpConfigActivity`,
 * `listDefaultEnabledMcpServersActivity`, `fetchToolsFromServerIds`) are
 * wired via `vi.hoisted` stubs so the `proxyActivities` mock returns the
 * same function references the helper binds at module-load time. Without
 * `vi.hoisted` the mock stubs would not exist when `proxyActivities()` is
 * called during module import.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	findDefaultMcpConfigActivity: vi.fn(),
	listDefaultEnabledMcpServersActivity: vi.fn(),
	fetchToolsFromServerIds: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	patched: vi.fn(() => true),
	// Every `proxyActivities<...>()` call inside the workflow file gets the
	// same stub object. The helper only reads three of the keys; the rest
	// stay undefined and are never invoked in this suite.
	proxyActivities: vi.fn(() => activityStubs),
	workflowInfo: vi.fn(() => ({
		runId: "test-run-id",
		unsafe: { isReplaying: false },
	})),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import {
	type ApplyDefaultMcpEagerRoutingArgs,
	applyDefaultMcpEagerRouting,
} from "../iterative-execution";

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

const EXCALIDRAW_SERVER = {
	id: "srv-excalidraw-1",
	key: "excalidraw",
	name: "Excalidraw",
	eagerKeywords: ["excalidraw"],
	eagerToolName: "create_view",
	suppressOnEager: ["fabric_create_frame"],
};

const EXCALIDRAW_CONFIG = {
	configId: "cfg-excalidraw-1",
	mcpServerKey: "excalidraw",
};

const CREATE_VIEW_TOOL = {
	toolName: "create_view",
	description: "Create an Excalidraw view from element JSON.",
	inputSchema: {
		type: "object",
		properties: { elements: { type: "array" } },
		required: ["elements"],
	},
	configId: EXCALIDRAW_CONFIG.configId,
	serverName: "excalidraw",
};

function buildArgs(
	overrides: Partial<ApplyDefaultMcpEagerRoutingArgs> = {},
): ApplyDefaultMcpEagerRoutingArgs {
	return {
		surface: "nexus",
		userMessage: "Create a 3-tier diagram using excalidraw",
		enabledMcpConfigIds: [EXCALIDRAW_CONFIG.configId],
		userId: "user-1",
		organizationId: "org-1",
		discoveredTools: {},
		discoveredToolConfigIds: {},
		suppressedFrameTools: new Set<string>(),
		executionId: "exec-test-1",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The five behavioral cases (originally locked by the renamed
// `nexus-excalidraw-routing.test.ts`).
// ---------------------------------------------------------------------------

describe("applyDefaultMcpEagerRouting", () => {
	it("applies routing when surface is routed and message matches a registry keyword", async () => {
		activityStubs.listDefaultEnabledMcpServersActivity.mockResolvedValueOnce(
			[EXCALIDRAW_SERVER],
		);
		activityStubs.findDefaultMcpConfigActivity.mockResolvedValueOnce(
			EXCALIDRAW_CONFIG,
		);
		activityStubs.fetchToolsFromServerIds.mockResolvedValueOnce([
			CREATE_VIEW_TOOL,
		]);

		const args = buildArgs();
		const result = await applyDefaultMcpEagerRouting(args);

		expect(result).toEqual({
			kind: "eager-loaded",
			serverKey: "excalidraw",
			toolName: "create_view",
			// `configId` is on the discriminated union so the caller's
			// `executeMcpTool` wrapper can match a tool-call failure
			// back to the managed-default `MCPConfig` row.
			configId: EXCALIDRAW_CONFIG.configId,
		});
		// `create_view` was eager-loaded into the discovered tools map so the
		// model can call it without a `search_tools` round-trip.
		expect(args.discoveredTools.create_view).toEqual({
			description: CREATE_VIEW_TOOL.description,
			inputSchema: CREATE_VIEW_TOOL.inputSchema,
		});
		expect(args.discoveredToolConfigIds.create_view).toBe(
			EXCALIDRAW_CONFIG.configId,
		);
		// `fabric_create_frame` is registered for suppression — the caller
		// drops it from `availableTools` and forwards the set to the
		// `runAgentIteration` activity for defense-in-depth.
		expect(args.suppressedFrameTools.has("fabric_create_frame")).toBe(true);
	});

	it('returns "service-down" sentinel with failureKind="no-config" when no tenant MCP config', async () => {
		activityStubs.listDefaultEnabledMcpServersActivity.mockResolvedValueOnce(
			[EXCALIDRAW_SERVER],
		);
		activityStubs.findDefaultMcpConfigActivity.mockResolvedValueOnce(null);

		const args = buildArgs();
		const result = await applyDefaultMcpEagerRouting(args);

		// The service-down branch carries `failureKind` + sanitized
		// `errorMessage` for the `mcp_default_tool_failed` analytics
		// emission. For the no-config branch the error message is the
		// empty string (no underlying exception).
		expect(result).toEqual({
			kind: "service-down",
			serverKey: "excalidraw",
			serverName: "Excalidraw",
			failureKind: "no-config",
			errorMessage: "",
		});
		// The eager-load activity must NOT be called when the config is
		// absent — caller short-circuits to the CTA branch instead.
		expect(activityStubs.fetchToolsFromServerIds).not.toHaveBeenCalled();
		expect(args.discoveredTools.create_view).toBeUndefined();
		expect(args.suppressedFrameTools.has("fabric_create_frame")).toBe(
			false,
		);
	});

	it("is a no-op when surface is not in the routed set", async () => {
		const args = buildArgs({
			surface: "copilot",
			// Same triggering message — the surface gate alone must block.
			userMessage: "Create an excalidraw diagram of the auth flow",
		});

		const result = await applyDefaultMcpEagerRouting(args);

		expect(result).toEqual({ kind: "skipped" });
		// No DB I/O at all when the surface gate fails.
		expect(
			activityStubs.listDefaultEnabledMcpServersActivity,
		).not.toHaveBeenCalled();
		expect(
			activityStubs.findDefaultMcpConfigActivity,
		).not.toHaveBeenCalled();
		expect(activityStubs.fetchToolsFromServerIds).not.toHaveBeenCalled();
		expect(args.discoveredTools.create_view).toBeUndefined();
		expect(args.suppressedFrameTools.size).toBe(0);
	});

	it("is a no-op when message matches no registry keyword", async () => {
		activityStubs.listDefaultEnabledMcpServersActivity.mockResolvedValueOnce(
			[EXCALIDRAW_SERVER],
		);

		const args = buildArgs({
			userMessage: "Create a dashboard with three KPI cards",
		});

		const result = await applyDefaultMcpEagerRouting(args);

		expect(result).toEqual({ kind: "skipped" });
		expect(
			activityStubs.findDefaultMcpConfigActivity,
		).not.toHaveBeenCalled();
		expect(activityStubs.fetchToolsFromServerIds).not.toHaveBeenCalled();
		expect(args.discoveredTools.create_view).toBeUndefined();
		expect(args.suppressedFrameTools.size).toBe(0);
	});

	it('case-insensitive substring match (covers "Excalidraw", "EXCALIDRAW", "excaliDRAW")', async () => {
		const variants = ["Excalidraw", "EXCALIDRAW", "excaliDRAW"];

		for (const variant of variants) {
			activityStubs.listDefaultEnabledMcpServersActivity.mockResolvedValueOnce(
				[EXCALIDRAW_SERVER],
			);
			activityStubs.findDefaultMcpConfigActivity.mockResolvedValueOnce(
				EXCALIDRAW_CONFIG,
			);
			activityStubs.fetchToolsFromServerIds.mockResolvedValueOnce([
				CREATE_VIEW_TOOL,
			]);

			const args = buildArgs({
				userMessage: `Please render a ${variant} diagram of the API`,
			});
			const result = await applyDefaultMcpEagerRouting(args);

			expect(result, `variant: ${variant}`).toEqual({
				kind: "eager-loaded",
				serverKey: "excalidraw",
				toolName: "create_view",
				configId: EXCALIDRAW_CONFIG.configId,
			});
			expect(args.discoveredTools.create_view).toBeDefined();
			expect(args.suppressedFrameTools.has("fabric_create_frame")).toBe(
				true,
			);
		}

		// Each variant should have triggered both activity calls exactly once.
		expect(
			activityStubs.findDefaultMcpConfigActivity,
		).toHaveBeenCalledTimes(variants.length);
		expect(activityStubs.fetchToolsFromServerIds).toHaveBeenCalledTimes(
			variants.length,
		);
	});

	// ----------------------------------------------------------------------
	// Surface-gate matrix.
	// Every literal in `TEMPORAL_ROUTED_SURFACES` enters the loop; the
	// explicit "copilot" exclusion is a no-op; legacy `undefined` is a no-op.
	// ----------------------------------------------------------------------

	describe("surface gate", () => {
		// Surfaces that MUST enter the loop. We assert the registry activity
		// fired — the deepest observable signal that the gate did not block.
		const ROUTED_SURFACES: Array<
			NonNullable<ApplyDefaultMcpEagerRoutingArgs["surface"]>
		> = ["nexus", "document-editor", "agent-template", "weave"];

		for (const surface of ROUTED_SURFACES) {
			it(`enters the loop when surface = "${surface}"`, async () => {
				activityStubs.listDefaultEnabledMcpServersActivity.mockResolvedValueOnce(
					[],
				);

				const args = buildArgs({ surface });
				await applyDefaultMcpEagerRouting(args);

				expect(
					activityStubs.listDefaultEnabledMcpServersActivity,
				).toHaveBeenCalledTimes(1);
			});
		}

		it('skips when surface = "copilot" (explicit exclusion)', async () => {
			const args = buildArgs({ surface: "copilot" });
			const result = await applyDefaultMcpEagerRouting(args);

			expect(result).toEqual({ kind: "skipped" });
			expect(
				activityStubs.listDefaultEnabledMcpServersActivity,
			).not.toHaveBeenCalled();
		});

		it("skips when surface is undefined (legacy callers)", async () => {
			const args = buildArgs({ surface: undefined });
			const result = await applyDefaultMcpEagerRouting(args);

			expect(result).toEqual({ kind: "skipped" });
			expect(
				activityStubs.listDefaultEnabledMcpServersActivity,
			).not.toHaveBeenCalled();
		});
	});

	// ----------------------------------------------------------------------
	// Zero default-enabled rows.
	// The registry activity may legitimately return [] if the kill-switch
	// SQL has flipped every row to `defaultEnabled = false`. The helper
	// must short-circuit instead of falling through to the keyword gate
	// (which would no-op on `Array.find(...)` anyway, but we want the
	// behavior locked).
	// ----------------------------------------------------------------------

	it("skips when the registry returns zero default-enabled rows (kill-switch path)", async () => {
		activityStubs.listDefaultEnabledMcpServersActivity.mockResolvedValueOnce(
			[],
		);

		const result = await applyDefaultMcpEagerRouting(buildArgs());

		expect(result).toEqual({ kind: "skipped" });
		expect(
			activityStubs.findDefaultMcpConfigActivity,
		).not.toHaveBeenCalled();
		expect(activityStubs.fetchToolsFromServerIds).not.toHaveBeenCalled();
	});

	// ----------------------------------------------------------------------
	// Failure-mode discriminated-union coverage.
	// The "service-down" branch carries one of three `failureKind` values.
	// The existing "no-config" case stays above; we add the other two so
	// every literal of the discriminated union is exercised.
	// ----------------------------------------------------------------------

	it('returns "service-down" with failureKind="server-unreachable" when the fetch throws', async () => {
		activityStubs.listDefaultEnabledMcpServersActivity.mockResolvedValueOnce(
			[EXCALIDRAW_SERVER],
		);
		activityStubs.findDefaultMcpConfigActivity.mockResolvedValueOnce(
			EXCALIDRAW_CONFIG,
		);
		const underlying = new Error("ECONNRESET upstream");
		activityStubs.fetchToolsFromServerIds.mockRejectedValueOnce(underlying);

		const args = buildArgs();
		const result = await applyDefaultMcpEagerRouting(args);

		expect(result).toMatchObject({
			kind: "service-down",
			serverKey: "excalidraw",
			serverName: "Excalidraw",
			failureKind: "server-unreachable",
		});
		// errorMessage is sanitized — non-empty for the throw path, and the
		// underlying message is preserved (no PII or secrets in it).
		expect((result as { errorMessage: string }).errorMessage).toContain(
			"ECONNRESET",
		);
		// Mutations must NOT have been applied on the failure path.
		expect(args.discoveredTools.create_view).toBeUndefined();
		expect(args.suppressedFrameTools.size).toBe(0);
	});

	it('returns "service-down" with failureKind="schema-mismatch" when the eager tool is missing from the fetch result', async () => {
		activityStubs.listDefaultEnabledMcpServersActivity.mockResolvedValueOnce(
			[EXCALIDRAW_SERVER],
		);
		activityStubs.findDefaultMcpConfigActivity.mockResolvedValueOnce(
			EXCALIDRAW_CONFIG,
		);
		// Server returned a different tool than the registry's
		// `eagerToolName` (registry drift).
		activityStubs.fetchToolsFromServerIds.mockResolvedValueOnce([
			{
				...CREATE_VIEW_TOOL,
				toolName: "unrelated_tool",
			},
		]);

		const args = buildArgs();
		const result = await applyDefaultMcpEagerRouting(args);

		expect(result).toMatchObject({
			kind: "service-down",
			serverKey: "excalidraw",
			serverName: "Excalidraw",
			failureKind: "schema-mismatch",
		});
		expect(
			(result as { errorMessage: string }).errorMessage.length,
		).toBeGreaterThan(0);
		// Mutations must NOT have been applied on the failure path.
		expect(args.discoveredTools.create_view).toBeUndefined();
		expect(args.suppressedFrameTools.size).toBe(0);
	});

	// ----------------------------------------------------------------------
	// Two default-enabled servers, first-match-wins ordering.
	// The registry activity sorts by name ASC; the helper iterates the array
	// and picks the FIRST keyword match, leaving subsequent rows
	// unconsulted on the same turn (avoids combinatorial blowup).
	// ----------------------------------------------------------------------

	it("first-match-wins when two default-enabled rows could match the same message", async () => {
		// Both rows declare keywords that the message contains. The registry
		// is sorted by name ASC by the activity; the helper picks the first
		// row in that order. Here EXCALIDRAW comes before MERMAID
		// alphabetically (E < M), so Excalidraw wins.
		const MERMAID_SERVER = {
			id: "srv-mermaid-1",
			key: "mermaid",
			name: "Mermaid",
			eagerKeywords: ["mermaid", "diagram"],
			eagerToolName: "render_mermaid",
			suppressOnEager: ["fabric_create_frame"],
		};
		activityStubs.listDefaultEnabledMcpServersActivity.mockResolvedValueOnce(
			// Registry order — Excalidraw first by name ASC.
			[EXCALIDRAW_SERVER, MERMAID_SERVER],
		);
		activityStubs.findDefaultMcpConfigActivity.mockResolvedValueOnce(
			EXCALIDRAW_CONFIG,
		);
		activityStubs.fetchToolsFromServerIds.mockResolvedValueOnce([
			CREATE_VIEW_TOOL,
		]);

		const args = buildArgs({
			// Message contains both "excalidraw" and "diagram" — both rows
			// would match, but only the first should fire.
			userMessage: "render an excalidraw diagram of the auth flow",
		});
		const result = await applyDefaultMcpEagerRouting(args);

		expect(result).toMatchObject({
			kind: "eager-loaded",
			serverKey: "excalidraw",
		});
		// findDefaultMcpConfigActivity called once — for Excalidraw only.
		expect(
			activityStubs.findDefaultMcpConfigActivity,
		).toHaveBeenCalledTimes(1);
		expect(activityStubs.findDefaultMcpConfigActivity).toHaveBeenCalledWith(
			expect.objectContaining({ serverKey: "excalidraw" }),
		);
	});

	// ----------------------------------------------------------------------
	// Tenant XOR on the activity call args.
	// Personal-context (`organizationId: undefined`) and org-context calls
	// must forward the same `organizationId` literal they received.
	// ----------------------------------------------------------------------

	describe("tenant XOR forwarding", () => {
		it("personal-context call forwards organizationId: undefined to findDefaultMcpConfigActivity", async () => {
			activityStubs.listDefaultEnabledMcpServersActivity.mockResolvedValueOnce(
				[EXCALIDRAW_SERVER],
			);
			activityStubs.findDefaultMcpConfigActivity.mockResolvedValueOnce(
				EXCALIDRAW_CONFIG,
			);
			activityStubs.fetchToolsFromServerIds.mockResolvedValueOnce([
				CREATE_VIEW_TOOL,
			]);

			await applyDefaultMcpEagerRouting(
				buildArgs({ userId: "user-1", organizationId: undefined }),
			);

			expect(
				activityStubs.findDefaultMcpConfigActivity,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: "user-1",
					organizationId: undefined,
				}),
			);
		});

		it("org-context call forwards organizationId: <id> to findDefaultMcpConfigActivity", async () => {
			activityStubs.listDefaultEnabledMcpServersActivity.mockResolvedValueOnce(
				[EXCALIDRAW_SERVER],
			);
			activityStubs.findDefaultMcpConfigActivity.mockResolvedValueOnce(
				EXCALIDRAW_CONFIG,
			);
			activityStubs.fetchToolsFromServerIds.mockResolvedValueOnce([
				CREATE_VIEW_TOOL,
			]);

			await applyDefaultMcpEagerRouting(
				buildArgs({ userId: "user-1", organizationId: "org-123" }),
			);

			expect(
				activityStubs.findDefaultMcpConfigActivity,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: "user-1",
					organizationId: "org-123",
				}),
			);
		});
	});
});
