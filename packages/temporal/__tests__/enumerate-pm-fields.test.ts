/**
 * Regression guard for the enumeration activity's MCP call.
 *
 * The activity failed live ("every wit_get_work_item_type call failed") because
 * it passed the wrong argument key (`type`) to the ADO MCP tool, whose required
 * param is `workItemType`. The original unit tests only covered the pure
 * union/dedupe helper (`tool-analyzer.ts`) and mocked the MCP layer away, so the
 * wrong arg name slipped through. These tests assert the ACTUAL args handed to
 * `executeMcpTool`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	executeMcpTool: vi.fn(),
	discoverPMToolCapabilities: vi.fn(),
}));

vi.mock("../src/activities/orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: mocks.executeMcpTool,
}));
vi.mock("../src/activities/pm-integration/story-sync", () => ({
	discoverPMToolCapabilities: mocks.discoverPMToolCapabilities,
}));
vi.mock("@repo/database", () => ({
	ADO_FIELD_MAPPING_PROVIDER: "azure-devops",
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { enumeratePmFields } from "../src/activities/pm-integration/enumerate-pm-fields";

const baseInput = {
	mcpConfigId: "cfg1",
	containerId: "ExampleProject",
	containerName: "ExampleProject",
	workItemTypes: ["User Story", "Bug"],
	userId: "u1",
	organizationId: "o1",
};

beforeEach(() => {
	mocks.executeMcpTool.mockReset();
	mocks.discoverPMToolCapabilities.mockReset();
	mocks.discoverPMToolCapabilities.mockResolvedValue({
		detectedType: "azure-devops",
		availableTools: ["mcp__azure-devops__wit_get_work_item_type"],
	});
});

describe("enumeratePmFields — MCP arg contract", () => {
	it("calls wit_get_work_item_type with `workItemType` (not `type`)", async () => {
		mocks.executeMcpTool.mockResolvedValue({
			success: true,
			output: {
				fields: [
					{
						referenceName: "Custom.BusinessRules",
						name: "Business Rules",
					},
				],
			},
		});

		await enumeratePmFields(baseInput);

		expect(mocks.executeMcpTool).toHaveBeenCalledTimes(2);
		const firstArgs = mocks.executeMcpTool.mock.calls[0][0];
		expect(firstArgs.args).toEqual({
			project: "ExampleProject",
			workItemType: "User Story",
		});
		// Explicitly guard against the regressed key.
		expect(firstArgs.args).not.toHaveProperty("type");
		expect(mocks.executeMcpTool.mock.calls[1][0].args).toEqual({
			project: "ExampleProject",
			workItemType: "Bug",
		});
	});

	it("unions + dedupes fields across work item types", async () => {
		mocks.executeMcpTool
			.mockResolvedValueOnce({
				success: true,
				output: {
					fields: [
						{ referenceName: "System.Title", name: "Title" },
						{ referenceName: "Custom.A", name: "A" },
					],
				},
			})
			.mockResolvedValueOnce({
				success: true,
				output: {
					fields: [
						{ referenceName: "Custom.A", name: "A" },
						{ referenceName: "Custom.B", name: "B" },
					],
				},
			});

		const res = await enumeratePmFields(baseInput);
		expect("fields" in res).toBe(true);
		if ("fields" in res) {
			expect(res.fields.map((f) => f.referenceName).sort()).toEqual([
				"Custom.A",
				"Custom.B",
				"System.Title",
			]);
			expect(res.workItemTypeCount).toBe(2);
		}
	});

	it("throws the retryable error when every type call fails", async () => {
		mocks.executeMcpTool.mockResolvedValue({ success: false });
		await expect(enumeratePmFields(baseInput)).rejects.toThrow(
			/every wit_get_work_item_type call failed/,
		);
	});

	it("returns unsupported for non-ADO providers without calling the tool", async () => {
		mocks.discoverPMToolCapabilities.mockResolvedValue({
			detectedType: "jira",
			availableTools: [],
		});
		const res = await enumeratePmFields(baseInput);
		expect(res).toEqual({ unsupported: true, provider: "jira" });
		expect(mocks.executeMcpTool).not.toHaveBeenCalled();
	});
});
