import {
	createOAuthM2MProvider,
	DatabricksTokenTimeoutError,
} from "@repo/databricks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	credentials: vi.fn(),
	execute: vi.fn(),
	signal: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	fetchCredentialsByIdAndProviderInTenant: mocks.credentials,
}));
vi.mock("@repo/integrations", async () => ({
	executeDatabricksSql: mocks.execute,
	DatabricksSqlError: (
		await import("../../../../../../integrations/src/databricks-sql")
	).DatabricksSqlError,
}));
vi.mock("../../activity-liveness", () => ({
	activityCancellationSignal: mocks.signal,
}));

import {
	isExternalWriteNodeType,
	isNonRetryableNodeType,
} from "../../../../workflows/lib/workflow-builder-nodes";
import { executeDatabricksAiQueryStep } from "../databricks-sql-ai-query";
import { executeDatabricksSqlStep } from "../databricks-sql-query";

const base = {
	userId: "example-user",
	organizationId: "example-org",
	inputs: { Start: { name: "Robert'); DROP TABLE example;--" } },
	nodeConfig: {
		integrationId: "example-connection",
		warehouseId: "example-warehouse",
		statement: "SELECT :name",
		parameters: [{ name: "name", type: "STRING", value: "{{Start.name}}" }],
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.credentials.mockResolvedValue({
		DATABRICKS_HOST: "https://example.cloud.databricks.com",
	});
	mocks.execute.mockResolvedValue({
		statementId: "example-statement",
		workspaceUrl: "https://example.cloud.databricks.com",
		columns: [{ name: "name" }],
		rows: [["Example"]],
		truncated: false,
	});
});
afterEach(() => vi.unstubAllGlobals());
describe("Databricks workflow steps", () => {
	it("pins the exact selected provider and actor, never a provider fallback", async () => {
		const result = await executeDatabricksSqlStep(base);
		expect(mocks.credentials).toHaveBeenCalledExactlyOnceWith(
			"example-connection",
			"DATABRICKS_SQL",
			"example-user",
			"example-org",
		);
		expect(result).toMatchObject({
			success: true,
			output: {
				statementId: "example-statement",
				rows: [["Example"]],
				columns: [{ name: "name" }],
				truncated: false,
			},
		});
	});
	it("reports a refused Databricks token redirect through the SQL client", async () => {
		const { executeDatabricksSql } = await import(
			"../../../../../../integrations/src/databricks-sql"
		);
		const transport = vi.fn(async () =>
			Response.redirect("https://example.com/", 302),
		);
		vi.stubGlobal("fetch", transport);
		mocks.credentials.mockResolvedValueOnce({
			DATABRICKS_HOST: "https://example.cloud.databricks.com",
			DATABRICKS_CLIENT_ID: "example-client",
			DATABRICKS_CLIENT_SECRET: "example-secret",
		});
		mocks.execute.mockImplementationOnce(executeDatabricksSql);

		expect(await executeDatabricksSqlStep(base)).toMatchObject({
			success: false,
			error: "Request failed: the server responded with a redirect, and redirects are not followed.",
		});
		expect(transport).toHaveBeenCalledExactlyOnceWith(
			"https://example.cloud.databricks.com/oidc/v1/token",
			expect.objectContaining({
				dispatcher: expect.anything(),
				redirect: "manual",
			}),
		);
	});
	it("reports a refused Databricks destination without sending a request", async () => {
		const transport = vi.fn();
		vi.stubGlobal("fetch", transport);
		mocks.execute.mockImplementationOnce(
			async (_credentials, { fetchImpl }) =>
				fetchImpl("https://127.0.0.1/"),
		);

		expect(await executeDatabricksSqlStep(base)).toMatchObject({
			success: false,
			error: "Request blocked: destination is not allowed.",
		});
		expect(transport).not.toHaveBeenCalled();
	});

	it("preserves the OAuth token timeout class through the workflow transport", async () => {
		const timeout = new DOMException(
			"Example token timeout",
			"TimeoutError",
		);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));
		let tokenFailure: unknown;
		mocks.execute.mockImplementationOnce(
			async (credentials, { fetchImpl }) => {
				const provider = createOAuthM2MProvider(
					credentials.DATABRICKS_HOST,
					"example-client",
					"example-secret",
					fetchImpl,
				);
				try {
					return await provider.getToken();
				} catch (error) {
					tokenFailure = error;
					throw error;
				}
			},
		);

		expect(await executeDatabricksSqlStep(base)).toMatchObject({
			success: false,
			error: "Databricks SQL could not run. Check the selected connection.",
		});
		expect(tokenFailure).toBeInstanceOf(DatabricksTokenTimeoutError);
	});

	it("keeps the SQL connection guidance when the warehouse transport fails", async () => {
		const { executeDatabricksSql } = await import(
			"../../../../../../integrations/src/databricks-sql"
		);
		const error = new TypeError("Example connection failed");
		const transport = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					access_token: "example-token",
					expires_in: 3600,
				}),
			)
			.mockRejectedValueOnce(error);
		vi.stubGlobal("fetch", transport);
		mocks.credentials.mockResolvedValueOnce({
			DATABRICKS_HOST: "https://example.cloud.databricks.com",
			DATABRICKS_CLIENT_ID: "example-client",
			DATABRICKS_CLIENT_SECRET: "example-secret",
		});
		mocks.execute.mockImplementationOnce(executeDatabricksSql);

		expect(await executeDatabricksSqlStep(base)).toMatchObject({
			success: false,
			error: "Databricks SQL request failed. Check the selected connection and warehouse permissions.",
		});
		expect(transport).toHaveBeenCalledTimes(2);
	});
	it("keeps hostile upstream values in bound parameters rather than SQL source", async () => {
		await executeDatabricksSqlStep(base);
		expect(mocks.execute.mock.calls[0][1]).toMatchObject({
			statement: "SELECT :name",
			parameters: [
				{ name: "name", type: "STRING", value: base.inputs.Start.name },
			],
		});
	});
	it("denies missing, wrong-provider, cross-organization, unshared or revoked connections without network execution", async () => {
		mocks.credentials.mockResolvedValue(null);
		expect(await executeDatabricksSqlStep(base)).toMatchObject({
			success: false,
		});
		expect(mocks.execute).not.toHaveBeenCalled();
	});
	it("refuses unresolved SQL parameter references before network execution", async () => {
		expect(
			await executeDatabricksSqlStep({ ...base, inputs: {} }),
		).toMatchObject({
			success: false,
			error: expect.stringContaining("unresolved"),
		});
		expect(mocks.execute).not.toHaveBeenCalled();
	});
	it("requires organization context before even reading credentials", async () => {
		expect(
			await executeDatabricksSqlStep({
				...base,
				organizationId: undefined,
			}),
		).toMatchObject({ success: false });
		expect(mocks.credentials).not.toHaveBeenCalled();
	});
	it("rejects SQL source interpolation before credentials or network access", async () => {
		expect(
			await executeDatabricksSqlStep({
				...base,
				nodeConfig: {
					...base.nodeConfig,
					statement: "SELECT {{Start.name}}",
				},
			}),
		).toMatchObject({ success: false });
		expect(mocks.credentials).not.toHaveBeenCalled();
	});
	it("binds one bounded AI request and fixes its output budget", async () => {
		await executeDatabricksAiQueryStep({
			...base,
			nodeConfig: {
				integrationId: "example-connection",
				warehouseId: "example-warehouse",
				endpoint: "example-model",
				request: "Summarize {{Start.name}}",
			},
		});
		expect(mocks.execute.mock.calls[0][1]).toMatchObject({
			statement:
				"SELECT ai_query('example-model', :request, modelParameters => named_struct('max_tokens', 512)) AS response",
			rowLimit: 1,
			parameters: [
				{
					name: "request",
					type: "STRING",
					value: `Summarize ${base.inputs.Start.name}`,
				},
			],
		});
	});
	it("rejects an interpolated endpoint and oversized expanded AI request", async () => {
		const config = {
			integrationId: "example-connection",
			warehouseId: "example-warehouse",
			endpoint: "bad' endpoint",
			request: "Example",
		};
		expect(
			await executeDatabricksAiQueryStep({ ...base, nodeConfig: config }),
		).toMatchObject({ success: false });
		expect(
			await executeDatabricksAiQueryStep({
				...base,
				inputs: { Start: { name: "x".repeat(8193) } },
				nodeConfig: {
					...config,
					endpoint: "example-model",
					request: "{{Start.name}}",
				},
			}),
		).toMatchObject({ success: false });
		expect(mocks.execute).not.toHaveBeenCalled();
	});
	it("propagates cancellation and sanitizes unexpected errors", async () => {
		const signal = new AbortController().signal;
		mocks.signal.mockReturnValue(signal);
		mocks.execute.mockRejectedValue(new Error("example-secret"));
		const result = await executeDatabricksSqlStep(base);
		expect(result.error).not.toContain("example-secret");
		expect(mocks.execute.mock.calls[0][1].signal).toBe(signal);
	});
	it.each(["databricks-sql-query", "databricks-sql-ai-query"])(
		"conservatively gates external side effects and disables automatic retries for %s",
		(type) => {
			expect(isNonRetryableNodeType(type)).toBe(true);
			expect(isExternalWriteNodeType(type)).toBe(true);
		},
	);
});
