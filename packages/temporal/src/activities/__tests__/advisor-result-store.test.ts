import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	write: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	attempt: 1,
}));
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ info: { attempt: mocks.attempt } }) },
}));
vi.mock("@repo/database/prisma/queries/advisor-tool-results", () => ({
	ADVISOR_RESULT_MAX_BYTES: 1024 * 1024,
	advisorToolResultStorage: { write: mocks.write },
}));
vi.mock("@repo/logs", () => ({
	logger: { info: mocks.info, warn: mocks.warn },
}));

import {
	FABRIC_CATALOG_DIRECT_BUILDER_ACCESS,
	FABRIC_CATALOG_GATEWAY_ACCESS,
	FABRIC_CATALOG_STEP_HANDLER_ACCESS,
} from "../../workflows/orchestrator/fabric-catalog-access";
import { storeAdvisorResult } from "../advisor-result-store";

const input = {
	userId: "example-user",
	organizationId: "example-org",
	toolName: "code_tree",
	route: "catalog" as const,
	advisorResultStore: {
		toolName: "code_tree",
		conversationId: "example-conversation",
		turnId: "example-turn",
		sourceKey: "example-execution:0",
	},
	result: {
		content: [
			{ type: "text", text: "example first" },
			{ type: "image", data: "example omitted" },
			{ type: "text", text: "example second" },
		],
	},
};
describe("Advisor result writer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.attempt = 1;
		mocks.write.mockResolvedValue("stored");
	});
	it("shares the model's text projection and stores only explicit metadata", async () => {
		await storeAdvisorResult(input);
		expect(mocks.write).toHaveBeenCalledExactlyOnceWith({
			userId: "example-user",
			organizationId: "example-org",
			conversationId: "example-conversation",
			turnId: "example-turn",
			sourceKey: "example-execution:0",
			toolName: "code_tree",
			text: "example first\nexample second",
			attempt: 1,
		});
	});
	it.each(["conversationId", "turnId", "sourceKey"] as const)(
		"skips missing %s on mixed-version input",
		async (field) => {
			await storeAdvisorResult({
				...input,
				advisorResultStore: {
					...input.advisorResultStore,
					[field]: "",
				},
			});
			expect(mocks.write).not.toHaveBeenCalled();
		},
	);
	it("skips old inputs without optional metadata", async () => {
		await storeAdvisorResult({ ...input, advisorResultStore: undefined });
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("requires a resolved organization", async () => {
		await storeAdvisorResult({ ...input, organizationId: undefined });
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it.each([
		"fabric_get_undeclared",
		"undeclared_rag_query",
		"fabric_create_story",
		"load_skill",
		"read_skill_file",
		"get_tool_schema",
		"search_tools",
		"advisor_result_read",
	])("rejects undeclared or excluded %s", async (toolName) => {
		await storeAdvisorResult({ ...input, toolName });
		await storeAdvisorResult({ ...input, toolName, route: "built-in" });
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("rejects an external MCP tool even with a declared Fabric name", async () => {
		await storeAdvisorResult({ ...input, route: "external" });
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it.each([
		"project_rag_query",
		"workspace_rag_query",
		"workspace_rag_summarize",
		"search_slack_messages",
		"search_teams_messages",
		"fabric_list_meeting_transcripts",
	])("admits the declared built-in %s", async (toolName) => {
		await storeAdvisorResult({ ...input, route: "built-in", toolName });
		expect(mocks.write).toHaveBeenCalledOnce();
	});
	it.each(["stored", "duplicate", "row_limit", "conversation_limit"])(
		"logs %s without result content",
		async (outcome) => {
			mocks.write.mockResolvedValue(outcome);
			await storeAdvisorResult(input);
			const logs = JSON.stringify([
				mocks.info.mock.calls,
				mocks.warn.mock.calls,
			]);
			expect(logs).not.toContain("example first");
			expect(logs).not.toContain("example second");
			expect(logs).toContain(outcome);
		},
	);
	it("swallows a database error and does not log its content", async () => {
		mocks.write.mockRejectedValue(new Error("example first secret"));
		await expect(storeAdvisorResult(input)).resolves.toBeUndefined();
		expect(mocks.write).toHaveBeenCalledOnce();
		expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(
			"example first",
		);
	});
	it("skips oversized content before invoking storage", async () => {
		await storeAdvisorResult({
			...input,
			result: "x".repeat(1024 * 1024 + 1),
		});
		expect(mocks.write).not.toHaveBeenCalled();
		expect(JSON.stringify(mocks.info.mock.calls)).toContain("row_limit");
	});
	it.each([
		"load_skill",
		"read_skill_file",
		"get_tool_schema",
		"search_tools",
		"advisor_result_read",
	])(
		"excludes %s even if later declared a catalog read",
		async (toolName) => {
			FABRIC_CATALOG_DIRECT_BUILDER_ACCESS[toolName] = "READ";
			try {
				await storeAdvisorResult({ ...input, toolName });
				expect(mocks.write).not.toHaveBeenCalled();
			} finally {
				delete FABRIC_CATALOG_DIRECT_BUILDER_ACCESS[toolName];
			}
		},
	);
	it.each([
		FABRIC_CATALOG_DIRECT_BUILDER_ACCESS,
		FABRIC_CATALOG_STEP_HANDLER_ACCESS,
		FABRIC_CATALOG_GATEWAY_ACCESS,
	])(
		"admits each catalog's declared read and refuses its writes",
		async (catalog) => {
			for (const [toolName, access] of Object.entries(catalog)) {
				mocks.write.mockClear();
				await storeAdvisorResult({ ...input, toolName });
				expect(mocks.write.mock.calls.length).toBe(
					access === "READ" ? 1 : 0,
				);
			}
		},
	);
	it("uses the catalog resolver's precedence when declarations conflict", async () => {
		const toolName = "example_conflicting_declaration";
		FABRIC_CATALOG_DIRECT_BUILDER_ACCESS[toolName] = "WRITE";
		FABRIC_CATALOG_GATEWAY_ACCESS[toolName] = "READ";
		try {
			await storeAdvisorResult({ ...input, toolName });
			expect(mocks.write).not.toHaveBeenCalled();
		} finally {
			delete FABRIC_CATALOG_DIRECT_BUILDER_ACCESS[toolName];
			delete FABRIC_CATALOG_GATEWAY_ACCESS[toolName];
		}
	});
	it("takes attempt only from the activity context, ignoring input and result fields", async () => {
		mocks.attempt = 4;
		await storeAdvisorResult({
			...input,
			attempt: 999,
			result: {
				content: [{ type: "text", text: "example content" }],
				attempt: 999,
			},
		} as typeof input);
		expect(mocks.write).toHaveBeenCalledWith(
			expect.objectContaining({ attempt: 4 }),
		);
	});
});
