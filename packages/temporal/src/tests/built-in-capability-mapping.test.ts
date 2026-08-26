import { describe, expect, it } from "vitest";
import {
	buildAgentExecutionContext,
	extractBuiltInToolNames,
} from "../activities/agent-execution-core";

describe("agent execution built-in capability mapping", () => {
	it("treats Dust-style built-in capability ids as builtin tools", () => {
		const context = buildAgentExecutionContext(
			{
				id: "template_1",
				name: "test-template",
				displayName: "Test Template",
				description: "Test template",
				instructions: "",
				knowledgeSources: [],
				tools: [
					"agent-memory",
					"create-files",
					"create-frames",
					"create-images",
					"run-agent",
					"speech-generator",
					"web-search-browse",
				],
				suggestedModel: null,
			},
			{
				id: "instance_1",
				name: "test-instance",
				description: null,
				customInstructions: null,
				modelOverride: null,
				modelConfig: null,
			},
			{
				integrationConfigurations: [],
				toolConnections: {},
				workspaceIds: [],
			},
			"user_1",
			undefined,
		);

		expect(extractBuiltInToolNames(context.tools)).toEqual([
			"agent-memory",
			"create-files",
			"create-frames",
			"create-images",
			"run-agent",
			"speech-generator",
			"web-search-browse",
		]);
	});
});
