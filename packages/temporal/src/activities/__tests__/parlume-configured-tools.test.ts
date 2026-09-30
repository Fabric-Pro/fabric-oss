import { describe, expect, it, vi } from "vitest";
import { executeAgentTurn } from "../agent-execution-core/agent-executor";
import {
	isExecutableAgentTool,
	withAgentToolRuntime,
} from "../shared/agent-tool-runtime";

const permission = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	canCreateProjectStory: permission,
	loadProjectDatabricksKnowledgeBinding: async () => null,
}));

describe("configured agent tool parity", () => {
	it("loads configured story creation through the canonical factory and retains its live permission check", async () => {
		const result = await withAgentToolRuntime(
			{
				invoke: vi.fn(),
				prepared: async (tools) => {
					const create = tools.fabric_create_story;
					expect(isExecutableAgentTool(create)).toBe(true);
					if (!isExecutableAgentTool(create)) {
						throw new Error("Configured tool missing");
					}
					expect(
						await create.execute({
							title: "Ticket",
							request: "Review the launch",
						}),
					).toMatchObject({
						error: expect.stringContaining("permission"),
					});
					return "Prepared";
				},
			},
			() =>
				executeAgentTurn({
					systemPrompt: "Agent",
					userMessage: "Create a ticket",
					userId: "user",
					organizationId: "org",
					projectId: "project",
					builtInToolNames: ["create-story"],
				}),
		);
		expect(result).toMatchObject({ success: true, response: "Prepared" });
		expect(permission).toHaveBeenCalledWith("project", "user");
	});
});
