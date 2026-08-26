/**
 * Databricks index selection on the step path.
 *
 * Execution moved to `@repo/integrations/executor-registry`, so this drives the
 * handler end-to-end (with the real registry) rather than its former private
 * method. The guarantee is unchanged: an explicit `indexNames` array is
 * sanitized and used as-is, and the handler must never fall back to listing
 * every index in the workspace when the caller named them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildContext,
	buildInput as buildIntegrationInput,
} from "./integration-handler-fixtures";

const { listIndexesMock, queryIndexesMock, fetchCredentialsMock } = vi.hoisted(
	() => ({
		listIndexesMock: vi.fn(),
		queryIndexesMock: vi.fn(),
		fetchCredentialsMock: vi.fn(),
	}),
);

const CREDENTIALS = {
	DATABRICKS_HOST: "https://workspace.cloud.databricks.com",
	DATABRICKS_CLIENT_ID: "client-id",
	DATABRICKS_CLIENT_SECRET: "client-secret",
};

vi.mock("@repo/database", () => ({
	fetchCredentialsByIdAndProviderInTenant: fetchCredentialsMock,
	fetchCredentialsByProvider: vi.fn(),
}));

vi.mock("@repo/integrations/databricks-vector-search", () => ({
	listDatabricksVectorIndexes: listIndexesMock,
	queryDatabricksVectorIndexes: queryIndexesMock,
	MAX_QUERY_INDEXES: 16,
}));

vi.mock("../../../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn(async () => null),
}));

vi.mock("../../authority-gate", () => ({
	checkIntegrationAuthority: vi.fn(async () => ({ authorized: true })),
}));

vi.mock("../../../../shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));

import { IntegrationHandler } from "../integration-handler";

describe("IntegrationHandler Databricks index selection", () => {
	beforeEach(() => {
		listIndexesMock.mockReset();
		queryIndexesMock.mockReset();
		queryIndexesMock.mockResolvedValue({
			chunks: [],
			failures: [],
			skippedIndexes: [],
		});
		fetchCredentialsMock.mockReset();
		fetchCredentialsMock.mockResolvedValue(CREDENTIALS);
	});

	it("accepts a validated indexNames array without listing org-wide indexes", async () => {
		const result = await new IntegrationHandler().execute(
			buildContext(
				buildIntegrationInput("DATABRICKS_VECTOR_SEARCH", {
					inputs: {
						operation: "query_index",
						query: "agent knowledge",
						indexNames: [
							"catalog.schema.docs",
							42,
							"",
							"catalog.schema.runbooks",
						],
					},
				}),
			),
		);

		expect(result.handled).toBe(true);
		expect(listIndexesMock).not.toHaveBeenCalled();
		expect(queryIndexesMock).toHaveBeenCalledWith(CREDENTIALS, {
			indexNames: ["catalog.schema.docs", "catalog.schema.runbooks"],
			query: "agent knowledge",
			numResults: undefined,
		});
	});

	it("lists indexes only when the caller named none", async () => {
		listIndexesMock.mockResolvedValue([
			{ name: "catalog.schema.docs", schema: "catalog.schema" },
		]);

		await new IntegrationHandler().execute(
			buildContext(
				buildIntegrationInput("DATABRICKS_VECTOR_SEARCH", {
					inputs: {
						operation: "query_index",
						query: "agent knowledge",
					},
				}),
			),
		);

		expect(listIndexesMock).toHaveBeenCalledTimes(1);
		expect(queryIndexesMock).toHaveBeenCalledWith(
			CREDENTIALS,
			expect.objectContaining({
				indexNames: ["catalog.schema.docs"],
			}),
		);
	});
});
