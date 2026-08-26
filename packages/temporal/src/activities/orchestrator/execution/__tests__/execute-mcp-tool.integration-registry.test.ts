/**
 * Chat-path execution of `integration__{PROVIDER}` tools.
 *
 * The dispatcher must resolve the provider/operation through the shared
 * executor registry, bind execution to the EXACT integration the user's search
 * discovered, and never fall back to a provider-wide credential lookup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	isProjectReadOnly: vi.fn(async () => false),
	fetchCredentialsByIdAndProviderInTenant: vi.fn(),
	fetchCredentialsByProvider: vi.fn(),
	fetchCredentialsByIdInTenant: vi.fn(),
	checkIntegrationAuthority:
		vi.fn<
			() => Promise<{
				authorized: boolean;
				reason?: string;
				providerKey?: string;
				requiredAccessLevel?: "READ" | "WRITE";
			}>
		>(),
	executeRegisteredIntegrationOperation:
		vi.fn<
			(params: {
				provider: string;
				operation: string;
				args: Record<string, unknown>;
				credentials?: Record<string, string> | null;
				signal?: AbortSignal;
			}) => Promise<{ data: unknown; text: string }>
		>(),
	getCachedToolResult: vi.fn(async () => ({ found: false })),
}));

vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: vi.fn(async () => ({
		client: { tools: async () => ({}) },
		serverName: "Fizzy",
		fromCache: true,
	})),
	invalidateMcpClientCache: vi.fn(),
	OAuthAuthorizationRequiredError: class extends Error {},
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/utils", async () => {
	const actual = (await vi.importActual(
		"../../../../../../utils/lib/read-only-mode",
	)) as Record<string, unknown>;
	return { getBaseUrl: () => "http://localhost:3000", ...actual };
});
vi.mock("@repo/database", () => ({
	db: {},
	isProjectReadOnly: h.isProjectReadOnly,
	fetchCredentialsByIdAndProviderInTenant:
		h.fetchCredentialsByIdAndProviderInTenant,
	fetchCredentialsByProvider: h.fetchCredentialsByProvider,
	fetchCredentialsByIdInTenant: h.fetchCredentialsByIdInTenant,
}));
vi.mock("@repo/integrations/github", () => ({ executeGitHubTool: vi.fn() }));
vi.mock("@repo/integrations/slack", () => ({ executeSlackTool: vi.fn() }));
vi.mock("@repo/integrations/executor-registry", async () => {
	// Real lookups (so operation validation is genuinely exercised), spy on the
	// executor so no provider API is contacted.
	const actual = (await vi.importActual(
		"@repo/integrations/executor-registry",
	)) as Record<string, unknown>;
	return {
		...actual,
		executeRegisteredIntegrationOperation:
			h.executeRegisteredIntegrationOperation,
	};
});
vi.mock("../authority-gate", () => ({
	checkIntegrationAuthority: h.checkIntegrationAuthority,
}));
vi.mock("../../../letta-memory-activities", () => ({
	cacheToolResult: vi.fn(),
	getCachedToolResult: h.getCachedToolResult,
}));
vi.mock("../../../shared/frame-service", () => ({
	createFirstClassFrame: vi.fn(),
	getFirstClassFrame: vi.fn(),
	listFirstClassFrames: vi.fn(),
	shareFirstClassFrame: vi.fn(),
	updateFirstClassFrame: vi.fn(),
}));
vi.mock("../../../shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));

const { executeMcpTool } = await import("../execute-mcp-tool");

const DATABRICKS_CREDS = {
	DATABRICKS_HOST: "https://example.azuredatabricks.net",
	DATABRICKS_CLIENT_ID: "client",
	DATABRICKS_CLIENT_SECRET: "secret",
};

/**
 * The two shapes every test in this file builds: an NHTSA call and a Databricks
 * call, each already bound to a well-formed synthetic config ID. Tests that are
 * ABOUT malformed references pass `mcpConfigId` explicitly instead.
 */
function nhtsaCall(
	args: Record<string, unknown>,
	overrides: Partial<Parameters<typeof executeMcpTool>[0]> = {},
) {
	return {
		toolName: "integration__NHTSA_VPIC",
		args,
		userId: "u1",
		mcpConfigId: "integration:NHTSA_VPIC:int-1",
		...overrides,
	};
}

function databricksCall(
	args: Record<string, unknown>,
	overrides: Partial<Parameters<typeof executeMcpTool>[0]> = {},
) {
	return {
		toolName: "integration__DATABRICKS_VECTOR_SEARCH",
		args,
		userId: "u1",
		mcpConfigId: "integration:DATABRICKS_VECTOR_SEARCH:int-2",
		...overrides,
	};
}

function errorOf(output: unknown): string {
	return String((output as { error?: unknown })?.error ?? "");
}

beforeEach(() => {
	h.isProjectReadOnly.mockReset();
	h.isProjectReadOnly.mockResolvedValue(false);
	h.fetchCredentialsByIdAndProviderInTenant.mockReset();
	h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue({
		NHTSA_ENABLED: "true",
	});
	h.fetchCredentialsByProvider.mockReset();
	h.fetchCredentialsByIdInTenant.mockReset();
	h.checkIntegrationAuthority.mockReset();
	h.checkIntegrationAuthority.mockResolvedValue({ authorized: true });
	h.executeRegisteredIntegrationOperation.mockReset();
	h.executeRegisteredIntegrationOperation.mockResolvedValue({
		data: { ok: true },
		text: "ok",
	});
	h.getCachedToolResult.mockClear();
});

// Operations are projected as their own tools, so the operation arrives in the
// tool NAME and `args` is the operation's arguments directly. The legacy
// two-segment form only appears when replaying an activity result recorded
// before that change.
describe("per-operation tool names", () => {
	it("takes the operation from the tool name and args directly", async () => {
		const result = await executeMcpTool({
			toolName: "integration__NHTSA_VPIC__decode_vin",
			args: { vin: "1FT" },
			userId: "u1",
			organizationId: "org-1",
			mcpConfigId: "integration:NHTSA_VPIC:int-1",
			executionId: "exec-9",
		});

		expect(result.success).toBe(true);
		expect(h.executeRegisteredIntegrationOperation).toHaveBeenCalledWith({
			provider: "NHTSA_VPIC",
			operation: "decode_vin",
			args: { vin: "1FT" },
			credentials: { NHTSA_ENABLED: "true" },
		});
	});

	it("does not look for an envelope on the per-operation form", async () => {
		// `operation` and `args` here are ordinary argument names, not an
		// envelope — they must be forwarded as-is.
		await executeMcpTool({
			toolName: "integration__DATABRICKS_VECTOR_SEARCH__query_index",
			args: { query: "onboarding" },
			userId: "u1",
			mcpConfigId: "integration:DATABRICKS_VECTOR_SEARCH:int-2",
		});

		expect(h.executeRegisteredIntegrationOperation).toHaveBeenCalledWith(
			expect.objectContaining({
				operation: "query_index",
				args: { query: "onboarding" },
			}),
		);
	});

	it("rejects an unknown operation named in the tool name", async () => {
		const result = await executeMcpTool({
			toolName: "integration__NHTSA_VPIC__delete_everything",
			args: {},
			userId: "u1",
			mcpConfigId: "integration:NHTSA_VPIC:int-1",
		});

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain(
			'Unsupported operation "delete_everything"',
		);
		expect(h.executeRegisteredIntegrationOperation).not.toHaveBeenCalled();
	});

	it("applies the same config-ID provider check on the per-operation form", async () => {
		const result = await executeMcpTool({
			toolName: "integration__NHTSA_VPIC__decode_vin",
			args: { vin: "1FT" },
			userId: "u1",
			mcpConfigId: "integration:DATABRICKS_VECTOR_SEARCH:int-2",
		});

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain(
			"belongs to DATABRICKS_VECTOR_SEARCH",
		);
		expect(
			h.fetchCredentialsByIdAndProviderInTenant,
		).not.toHaveBeenCalled();
	});

	it("rejects an unregistered provider on the per-operation form", async () => {
		const result = await executeMcpTool({
			toolName: "integration__SLACK__send_message",
			args: { text: "hi" },
			userId: "u1",
			mcpConfigId: "integration:SLACK:int-3",
		});

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain(
			"Unsupported integration provider: SLACK",
		);
	});
});

describe("registry dispatch", () => {
	it("executes a registered operation and returns its structured data", async () => {
		const result = await executeMcpTool(
			nhtsaCall(
				{ operation: "decode_vin", args: { vin: "1FT" } },
				{ organizationId: "org-1", executionId: "exec-9" },
			),
		);

		expect(result.success).toBe(true);
		expect(result.output).toEqual({ ok: true });
		expect(h.executeRegisteredIntegrationOperation).toHaveBeenCalledWith({
			provider: "NHTSA_VPIC",
			operation: "decode_vin",
			args: { vin: "1FT" },
			credentials: { NHTSA_ENABLED: "true" },
		});
	});

	it("rejects an unregistered provider", async () => {
		const result = await executeMcpTool({
			toolName: "integration__SLACK",
			args: { operation: "list_channels" },
			userId: "u1",
			mcpConfigId: "integration:SLACK:int-1",
		});

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain(
			"Unsupported integration provider: SLACK",
		);
		expect(h.executeRegisteredIntegrationOperation).not.toHaveBeenCalled();
	});

	it("rejects an unknown operation before authority or credential access", async () => {
		const result = await executeMcpTool(
			databricksCall({ operation: "query_indx", args: { query: "x" } }),
		);

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain(
			'Unsupported operation "query_indx"',
		);
		expect(h.checkIntegrationAuthority).not.toHaveBeenCalled();
		expect(
			h.fetchCredentialsByIdAndProviderInTenant,
		).not.toHaveBeenCalled();
	});

	it("rejects a missing operation", async () => {
		const result = await executeMcpTool(nhtsaCall({}));

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain('Missing "operation"');
	});

	it("rejects malformed args instead of silently substituting an empty object", async () => {
		const result = await executeMcpTool(
			nhtsaCall({ operation: "decode_vin", args: "{not json" }),
		);

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain("not valid JSON");
		expect(h.executeRegisteredIntegrationOperation).not.toHaveBeenCalled();
	});

	it("accepts a JSON-encoded args object", async () => {
		await executeMcpTool(
			nhtsaCall({ operation: "decode_vin", args: '{"vin":"1FT"}' }),
		);

		expect(h.executeRegisteredIntegrationOperation).toHaveBeenCalledWith(
			expect.objectContaining({ args: { vin: "1FT" } }),
		);
	});

	it("surfaces executor failures as structured failures, not throws", async () => {
		h.executeRegisteredIntegrationOperation.mockRejectedValue(
			new Error("Databricks vector search failed"),
		);
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue(
			DATABRICKS_CREDS,
		);

		const result = await executeMcpTool(
			databricksCall({ operation: "query_index", args: { query: "x" } }),
		);

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toBe("Databricks vector search failed");
	});
});

// Test 8
describe("synthetic config ID parsing", () => {
	it("rejects a missing config ID", async () => {
		const result = await executeMcpTool({
			toolName: "integration__NHTSA_VPIC",
			args: { operation: "decode_vin" },
			userId: "u1",
		});

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain(
			"not bound to a specific integration",
		);
		expect(
			h.fetchCredentialsByIdAndProviderInTenant,
		).not.toHaveBeenCalled();
	});

	it.each([
		"nonsense",
		"integration:NHTSA_VPIC",
		"integration:NHTSA_VPIC:",
		"mcp:NHTSA_VPIC:int-1",
		"integration:NHTSA_VPIC:int-1:extra",
	])("rejects the malformed reference %s", async (configId) => {
		const result = await executeMcpTool({
			toolName: "integration__NHTSA_VPIC",
			args: { operation: "decode_vin" },
			userId: "u1",
			mcpConfigId: configId,
		});

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain("Cannot execute NHTSA_VPIC");
		expect(
			h.fetchCredentialsByIdAndProviderInTenant,
		).not.toHaveBeenCalled();
	});

	it("rejects a provider mismatch between the tool name and the reference", async () => {
		const result = await executeMcpTool({
			toolName: "integration__NHTSA_VPIC",
			args: { operation: "decode_vin" },
			userId: "u1",
			mcpConfigId: "integration:DATABRICKS_VECTOR_SEARCH:int-2",
		});

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain(
			"belongs to DATABRICKS_VECTOR_SEARCH",
		);
		expect(
			h.fetchCredentialsByIdAndProviderInTenant,
		).not.toHaveBeenCalled();
	});
});

describe("credential resolution", () => {
	// Test 9
	it("never falls back to a provider-wide lookup when the exact ID is missing", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue(null);

		const result = await executeMcpTool(
			databricksCall(
				{ operation: "list_indexes" },
				{ organizationId: "org-1" },
			),
		);

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain("Settings > Integrations");
		expect(h.fetchCredentialsByProvider).not.toHaveBeenCalled();
		expect(h.executeRegisteredIntegrationOperation).not.toHaveBeenCalled();
	});

	// Test 10
	it("blocks a disabled or deleted integration — including credentialless NHTSA", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue(null);

		const result = await executeMcpTool(
			nhtsaCall({ operation: "decode_vin", args: { vin: "1FT" } }),
		);

		expect(result.success).toBe(false);
		expect(h.executeRegisteredIntegrationOperation).not.toHaveBeenCalled();
	});

	// Test 11
	it("uses the discovered integration's own credentials and tenant scope", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue(
			DATABRICKS_CREDS,
		);

		await executeMcpTool({
			toolName: "integration__DATABRICKS_VECTOR_SEARCH",
			args: { operation: "query_index", args: { query: "onboarding" } },
			userId: "member-b",
			organizationId: "org-1",
			mcpConfigId: "integration:DATABRICKS_VECTOR_SEARCH:int-2",
		});

		expect(h.fetchCredentialsByIdAndProviderInTenant).toHaveBeenCalledWith(
			"int-2",
			"DATABRICKS_VECTOR_SEARCH",
			"member-b",
			"org-1",
		);
		expect(h.executeRegisteredIntegrationOperation).toHaveBeenCalledWith(
			expect.objectContaining({ credentials: DATABRICKS_CREDS }),
		);
	});
});

describe("authority binding", () => {
	// Test 12
	it("passes the operation and run ID, and does not prompt for registered reads", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue(
			DATABRICKS_CREDS,
		);

		for (const operation of ["query_index", "list_indexes"]) {
			h.checkIntegrationAuthority.mockClear();
			const result = await executeMcpTool({
				toolName: "integration__DATABRICKS_VECTOR_SEARCH",
				args: { operation, args: { query: "x" } },
				userId: "u1",
				organizationId: "org-1",
				mcpConfigId: "integration:DATABRICKS_VECTOR_SEARCH:int-2",
				executionId: "exec-9",
			});

			expect(result.success).toBe(true);
			expect(h.checkIntegrationAuthority).toHaveBeenCalledWith({
				userId: "u1",
				organizationId: "org-1",
				provider: "DATABRICKS_VECTOR_SEARCH",
				operation,
				runType: "ORCHESTRATOR",
				runId: "exec-9",
			});
		}
	});

	it("blocks execution when authority is denied", async () => {
		h.checkIntegrationAuthority.mockResolvedValue({
			authorized: false,
			reason: "No active authority grant.",
			providerKey: "custom:nhtsa-vpic",
			requiredAccessLevel: "WRITE",
		});

		const result = await executeMcpTool(
			nhtsaCall({ operation: "decode_vin" }),
		);

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain("Runtime authority required");
		expect(h.executeRegisteredIntegrationOperation).not.toHaveBeenCalled();
	});

	it("fails closed when the authority check itself errors", async () => {
		h.checkIntegrationAuthority.mockRejectedValue(new Error("db down"));

		const result = await executeMcpTool(
			nhtsaCall({ operation: "decode_vin" }),
		);

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain("Authority check failed");
		expect(h.executeRegisteredIntegrationOperation).not.toHaveBeenCalled();
	});
});

// Test item 15 + defect 3: exactly one Read-only gate, and it runs AFTER the
// registry has resolved the operation, using the declared access.
//
// An earlier version of this suite asserted the INVERSE — that
// `integration__SLACK/send_message` in a read-only project returns
// PROJECT_READ_ONLY — and so locked in the bug. Two reasons that ordering is
// wrong. First, it misreports: SLACK has no shared executor at all, so the
// honest answer is "unsupported provider"; telling the model the project is
// read-only sends it off to ask the user to disable read-only mode, which
// would not help. Second, it means the gate classifies an attacker-influenced
// string (`args.operation`) with a name heuristic, when the registry can state
// the operation's real effect. Shape first, then gate on declared access.
describe("read-only mode gating order", () => {
	it("reports an unregistered provider as unsupported, not as read-only", async () => {
		h.isProjectReadOnly.mockResolvedValue(true);

		const result = await executeMcpTool({
			toolName: "integration__SLACK",
			args: { operation: "send_message", args: { text: "hi" } },
			userId: "u1",
			projectId: "p1",
			mcpConfigId: "integration:SLACK:int-3",
		});

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain(
			"Unsupported integration provider: SLACK",
		);
		// Gate never consulted — the call was rejected on shape first.
		expect(h.isProjectReadOnly).not.toHaveBeenCalled();
		expect(h.executeRegisteredIntegrationOperation).not.toHaveBeenCalled();
	});

	it("reports an unknown operation as unsupported, not as read-only", async () => {
		h.isProjectReadOnly.mockResolvedValue(true);

		const result = await executeMcpTool({
			toolName: "integration__NHTSA_VPIC",
			args: { operation: "delete_everything" },
			userId: "u1",
			projectId: "p1",
			mcpConfigId: "integration:NHTSA_VPIC:int-1",
		});

		expect(result.success).toBe(false);
		expect(errorOf(result.output)).toContain(
			'Unsupported operation "delete_everything"',
		);
		expect(h.isProjectReadOnly).not.toHaveBeenCalled();
	});

	it("lets a registry-declared READ through a read-only project", async () => {
		h.isProjectReadOnly.mockResolvedValue(true);
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue(
			DATABRICKS_CREDS,
		);

		const result = await executeMcpTool({
			toolName: "integration__DATABRICKS_VECTOR_SEARCH",
			args: { operation: "query_index", args: { query: "x" } },
			userId: "u1",
			projectId: "p1",
			mcpConfigId: "integration:DATABRICKS_VECTOR_SEARCH:int-2",
		});

		expect(result.success).toBe(true);
		// A declared READ short-circuits the gate — no project lookup at all,
		// and there is no second gate anywhere on this path.
		expect(h.isProjectReadOnly).not.toHaveBeenCalled();
	});

	it("does not consult the generic result cache for integration tools", async () => {
		// A cache hit would return provider data without re-checking authority
		// or that the integration row is still active.
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue(
			DATABRICKS_CREDS,
		);

		await executeMcpTool({
			toolName: "integration__DATABRICKS_VECTOR_SEARCH",
			args: { operation: "list_indexes" },
			userId: "u1",
			projectId: "p1",
			lettaAgentId: "letta-1",
			mcpConfigId: "integration:DATABRICKS_VECTOR_SEARCH:int-2",
		});

		expect(h.getCachedToolResult).not.toHaveBeenCalled();
		expect(h.executeRegisteredIntegrationOperation).toHaveBeenCalled();
	});
});

// Defect 5: a timed-out tool call must be able to cancel the provider request.
describe("abort signal", () => {
	it("forwards the activity's abort signal to the registry", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue(
			DATABRICKS_CREDS,
		);
		h.executeRegisteredIntegrationOperation.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return { data: {}, text: "" };
		});

		const result = await executeMcpTool({
			toolName: "integration__DATABRICKS_VECTOR_SEARCH",
			args: { operation: "list_indexes" },
			userId: "u1",
			mcpConfigId: "integration:DATABRICKS_VECTOR_SEARCH:int-2",
			timeoutMs: 5,
		});

		expect(result.success).toBe(false);
		const passedSignal =
			h.executeRegisteredIntegrationOperation.mock.calls[0]?.[0]?.signal;
		expect(passedSignal).toBeInstanceOf(AbortSignal);
		expect(passedSignal?.aborted).toBe(true);
	});
});
