import { describe, expect, it } from "vitest";
import { buildFabricAgentHref } from "../fabric-agent-links";

describe("buildFabricAgentHref", () => {
	it("builds a base Fabric Agent link without context", () => {
		expect(buildFabricAgentHref({ basePath: "/app" })).toBe(
			"/app/agents/fabric-ai",
		);
	});

	it("includes contextual params and a suggested prompt", () => {
		const href = buildFabricAgentHref({
			basePath: "/app/acme",
			projectId: "project_1",
			projectName: "Fabric",
			storyId: "story_1",
			storyIdentifier: "US-12",
			storyTitle: "Launch task-first workflows",
			taskId: "task_9",
			taskIdentifier: "TASK-9",
			taskTitle: "Wire contextual links",
			prompt: "Summarize this task and propose next steps.",
		});

		expect(href).toContain("/app/acme/agents/fabric-ai?");
		expect(href).toContain("projectId=project_1");
		expect(href).toContain("storyIdentifier=US-12");
		expect(href).toContain("taskIdentifier=TASK-9");
		expect(href).toContain(
			"prompt=Summarize+this+task+and+propose+next+steps.",
		);
	});
});
