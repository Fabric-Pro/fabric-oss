/**
 * IntegrationHandler delegation to the shared executor registry.
 *
 * NHTSA and Databricks no longer have private execution methods here — the step
 * path and the chat path must run the exact same code, so a fix or a new
 * operation lands in both at once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildContext,
	buildInput,
	DATABRICKS_CREDS,
} from "./integration-handler-fixtures";

const h = vi.hoisted(() => ({
	fetchCredentialsByIdAndProviderInTenant: vi.fn(),
	fetchCredentialsByProvider: vi.fn(),
	guardToolWriteForReadOnly: vi.fn(async () => null),
	checkIntegrationAuthority: vi.fn(async () => ({ authorized: true })),
	executeRegisteredIntegrationOperation: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	fetchCredentialsByIdAndProviderInTenant:
		h.fetchCredentialsByIdAndProviderInTenant,
	fetchCredentialsByProvider: h.fetchCredentialsByProvider,
}));
vi.mock("@repo/integrations/executor-registry", async () => {
	const actual = (await vi.importActual(
		"@repo/integrations/executor-registry",
	)) as Record<string, unknown>;
	return {
		...actual,
		executeRegisteredIntegrationOperation:
			h.executeRegisteredIntegrationOperation,
	};
});
vi.mock("../../../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: h.guardToolWriteForReadOnly,
}));
vi.mock("../../authority-gate", () => ({
	checkIntegrationAuthority: h.checkIntegrationAuthority,
}));
vi.mock("../../../../shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));

const { IntegrationHandler } = await import("../integration-handler");

beforeEach(() => {
	h.fetchCredentialsByIdAndProviderInTenant.mockReset();
	h.fetchCredentialsByProvider.mockReset();
	h.guardToolWriteForReadOnly.mockReset();
	h.guardToolWriteForReadOnly.mockResolvedValue(null);
	h.checkIntegrationAuthority.mockReset();
	h.checkIntegrationAuthority.mockResolvedValue({ authorized: true });
	h.executeRegisteredIntegrationOperation.mockReset();
	h.executeRegisteredIntegrationOperation.mockResolvedValue({
		data: { rows: 1 },
		text: "rendered output",
	});
});

// Test 16
describe("registry delegation", () => {
	it("routes NHTSA through the shared executor", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue({
			NHTSA_ENABLED: "true",
		});
		const input = buildInput("NHTSA_VPIC", {
			inputs: { operation: "decode_vin", vin: "1FT" },
		});

		const result = await new IntegrationHandler().execute(
			buildContext(input),
		);

		expect(h.executeRegisteredIntegrationOperation).toHaveBeenCalledWith({
			provider: "NHTSA_VPIC",
			operation: "decode_vin",
			args: { vin: "1FT" },
			credentials: { NHTSA_ENABLED: "true" },
		});
		expect(result.handled).toBe(true);
		expect(result.output?.response).toBe("rendered output");
		expect(result.output?.outputs?.integration_result).toEqual({ rows: 1 });
	});

	it("routes Databricks Vector Search through the shared executor", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue(
			DATABRICKS_CREDS,
		);
		const input = buildInput("DATABRICKS_VECTOR_SEARCH", {
			inputs: { operation: "query_index", query: "onboarding" },
		});

		const result = await new IntegrationHandler().execute(
			buildContext(input),
		);

		expect(h.executeRegisteredIntegrationOperation).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "DATABRICKS_VECTOR_SEARCH",
				operation: "query_index",
				credentials: DATABRICKS_CREDS,
			}),
		);
		expect(result.handled).toBe(true);
	});

	it("returns a structured failure when the shared executor rejects", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue(
			DATABRICKS_CREDS,
		);
		h.executeRegisteredIntegrationOperation.mockRejectedValue(
			new Error('Unsupported operation "query_indx"'),
		);
		const input = buildInput("DATABRICKS_VECTOR_SEARCH", {
			inputs: { operation: "query_indx" },
		});

		const result = await new IntegrationHandler().execute(
			buildContext(input),
		);

		// An explicitly-matched integration never falls back to MCP on failure.
		expect(result.handled).toBe(false);
		expect(result.shouldFallback).toBe(false);
		expect(String(result.error)).toContain(
			'Unsupported operation "query_indx"',
		);
	});

	it("still routes an unmigrated provider to the legacy switch", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue({
			PERPLEXITY_API_KEY: "",
		});
		const input = buildInput("PERPLEXITY", {
			inputs: { operation: "search", query: "x" },
		});

		await new IntegrationHandler().execute(buildContext(input));

		expect(h.executeRegisteredIntegrationOperation).not.toHaveBeenCalled();
	});
});

// Defect 1: an exact integration ID must be bound to the provider it is being
// executed as. Without the provider predicate, a step could name NHTSA_VPIC,
// point at an active row belonging to some other provider, satisfy NHTSA's
// credentialless policy, and run NHTSA with no NHTSA integration configured.
describe("exact-ID credential binding", () => {
	it("fetches credentials bound to both the ID and the declared provider", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue({
			NHTSA_ENABLED: "true",
		});

		await new IntegrationHandler().execute(
			buildContext(
				buildInput("NHTSA_VPIC", {
					inputs: { operation: "decode_vin", vin: "1FT" },
					integrationId: "int-42",
				}),
			),
		);

		expect(h.fetchCredentialsByIdAndProviderInTenant).toHaveBeenCalledWith(
			"int-42",
			"NHTSA_VPIC",
			"u1",
			"org-1",
		);
	});

	it("refuses to execute when the ID belongs to another provider", async () => {
		// The provider-bound query finds nothing for this pairing.
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue(null);

		const result = await new IntegrationHandler().execute(
			buildContext(
				buildInput("NHTSA_VPIC", {
					inputs: { operation: "decode_vin", vin: "1FT" },
					integrationId: "slack-row-id",
				}),
			),
		);

		expect(result.handled).toBe(false);
		expect(String(result.error)).toContain("not configured");
		expect(h.executeRegisteredIntegrationOperation).not.toHaveBeenCalled();
		expect(h.fetchCredentialsByProvider).not.toHaveBeenCalled();
	});
});

// Defect 3: registry resolution runs before the authority and Read-only gates.
describe("validation order", () => {
	it("rejects an unknown registered-provider operation before either gate", async () => {
		const result = await new IntegrationHandler().execute(
			buildContext(
				buildInput("DATABRICKS_VECTOR_SEARCH", {
					inputs: { operation: "drop_index" },
				}),
			),
		);

		expect(result.handled).toBe(false);
		expect(String(result.error)).toContain(
			'Unsupported operation "drop_index"',
		);
		expect(h.checkIntegrationAuthority).not.toHaveBeenCalled();
		expect(h.guardToolWriteForReadOnly).not.toHaveBeenCalled();
		expect(
			h.fetchCredentialsByIdAndProviderInTenant,
		).not.toHaveBeenCalled();
	});

	it("gates a registered operation on its declared access, not its name", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue({
			NHTSA_ENABLED: "true",
		});

		await new IntegrationHandler().execute(
			buildContext(
				buildInput("NHTSA_VPIC", {
					inputs: { operation: "decode_vin", vin: "1FT" },
				}),
			),
		);

		// `decode_vin` reads as a write to the name heuristic; the registry
		// says READ and that is what the gate must be given.
		expect(h.guardToolWriteForReadOnly).toHaveBeenCalledWith(
			undefined,
			"decode_vin",
			{ accessOverride: "READ" },
		);
	});

	it("leaves unregistered providers on the name heuristic", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue({
			PERPLEXITY_API_KEY: "k",
		});

		await new IntegrationHandler().execute(
			buildContext(
				buildInput("PERPLEXITY", {
					inputs: { operation: "search", query: "x" },
				}),
			),
		);

		expect(h.guardToolWriteForReadOnly).toHaveBeenCalledWith(
			undefined,
			"search",
			undefined,
		);
	});
});

describe("operation resolution", () => {
	it("resolves registered operations from registry keywords", async () => {
		h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue({
			NHTSA_ENABLED: "true",
		});
		const input = buildInput("NHTSA_VPIC", {
			description: "Please decode vin 1FTFW1ET5DFC10312 for the customer",
		});

		await new IntegrationHandler().execute(buildContext(input));

		expect(h.executeRegisteredIntegrationOperation).toHaveBeenCalledWith(
			expect.objectContaining({ operation: "decode_vin" }),
		);
	});

	it("claims steps whose executor names a registered provider", () => {
		const handler = new IntegrationHandler();
		const input = buildInput("NHTSA_VPIC");
		input.step.capability = undefined;
		input.step.executor = "databricks_vector_search";
		input.matchedIntegrations = [];

		expect(handler.canHandle(input)).toBe(true);
	});
});
