import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
	credentials: vi.fn(),
	execute: vi.fn(),
	signal: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	fetchCredentialsByIdAndProviderInTenant: mocks.credentials,
}));
vi.mock("@repo/integrations", () => ({
	executeDatabricksSql: mocks.execute,
	DatabricksSqlError: class extends Error {},
}));
vi.mock("../../activity-liveness", () => ({
	activityCancellationSignal: mocks.signal,
}));
import { executeDatabricksSqlStep } from "../databricks-sql-query";
import { executeDatabricksAiQueryStep } from "../databricks-sql-ai-query";
import {
	isExternalWriteNodeType,
	isNonRetryableNodeType,
} from "../../../../workflows/lib/workflow-builder-nodes";
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
