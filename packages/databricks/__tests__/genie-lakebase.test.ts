import { describe, expect, it, vi } from "vitest";
import type { DatabricksApiClient } from "../src/api-client";
import {
	DatabricksGenieClient,
	getDatabricksLakebaseConfig,
} from "../src/genie-lakebase";

describe("DatabricksGenieClient", () => {
	it("starts a Genie Agent conversation, polls until COMPLETED, and returns SQL + result rows", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				conversation_id: "conv_1",
				message_id: "msg_1",
			})
			.mockResolvedValueOnce({
				id: "msg_1",
				space_id: "space_1",
				conversation_id: "conv_1",
				content: "How many active runs?",
				status: "EXECUTING_QUERY",
			})
			.mockResolvedValueOnce({
				id: "msg_1",
				space_id: "space_1",
				conversation_id: "conv_1",
				content: "How many active runs?",
				status: "COMPLETED",
				attachments: [
					{
						attachment_id: "att_text",
						text: { content: "There are 12 active coding runs." },
					},
					{
						attachment_id: "att_sql",
						query: {
							title: "Count active runs",
							query: "SELECT COUNT(*) FROM coding_runs WHERE status = 'ACTIVE'",
						},
					},
				],
			})
			.mockResolvedValueOnce({
				statement_response: {
					manifest: {
						schema: {
							columns: [{ name: "active_runs" }],
						},
					},
					result: {
						data_array: [[12]],
					},
				},
			});

		const client = new DatabricksGenieClient({
			request,
		} as unknown as DatabricksApiClient);

		const result = await client.askGenieAgent(
			"space_1",
			"How many active runs?",
			{
				pollIntervalMs: 5,
			},
		);

		expect(result.status).toBe("COMPLETED");
		expect(result.conversationId).toBe("conv_1");
		expect(result.text).toEqual(["There are 12 active coding runs."]);
		expect(result.queries).toEqual([
			{
				attachmentId: "att_sql",
				title: "Count active runs",
				description: undefined,
				sql: "SELECT COUNT(*) FROM coding_runs WHERE status = 'ACTIVE'",
				columns: ["active_runs"],
				rows: [[12]],
			},
		]);
	});

	it("resolves Databricks Lakebase and Genie Agents configuration from environment", () => {
		const config = getDatabricksLakebaseConfig({
			DATABRICKS_LAKEBASE_INSTANCE_NAME: "fabric-lakebase-prod",
			DATABRICKS_UNITY_CATALOG: "fabric_catalog",
			DATABRICKS_UNITY_SCHEMA: "analytics",
			DATABRICKS_GENIE_DEFAULT_AGENT_ID: "agent_123",
		});

		expect(config).toEqual({
			instanceName: "fabric-lakebase-prod",
			databaseUrl: undefined,
			unityCatalog: "fabric_catalog",
			unitySchema: "analytics",
			defaultGenieAgentId: "agent_123",
			defaultGenieSpaceId: "agent_123",
			enabled: true,
		});
	});
});
