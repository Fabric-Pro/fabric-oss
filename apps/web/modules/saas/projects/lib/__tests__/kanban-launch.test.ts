import { describe, expect, it } from "vitest";
import {
	buildEmbeddedKanbanUrl,
	buildKanbanRuntimeStatusUrl,
	buildProtocolKanbanUrl,
	buildStandaloneKanbanUrl,
	getKanbanLaunchModeFromStatus,
} from "../kanban-launch";

describe("kanban launch urls", () => {
	it("builds embedded iframe urls with parent origin and embed token", () => {
		const url = new URL(
			buildEmbeddedKanbanUrl({
				projectId: "proj_123",
				storyId: "story_456",
				parentOrigin: "http://localhost:3001",
				token: "token_abc",
			}),
		);

		expect(url.origin).toBe("http://localhost:3484");
		expect(url.pathname).toBe("/fabric/");
		expect(url.searchParams.get("embed")).toBe("true");
		expect(url.searchParams.get("projectId")).toBe("proj_123");
		expect(url.searchParams.get("taskId")).toBe("story_456");
		expect(url.searchParams.get("parentOrigin")).toBe(
			"http://localhost:3001",
		);
		expect(url.searchParams.get("embedToken")).toBe("token_abc");
	});

	it("builds protocol urls that preserve token handoff for standalone launch", () => {
		const url = new URL(
			buildProtocolKanbanUrl({
				projectId: "proj_123",
				storyId: "story_456",
				parentOrigin: "http://localhost:3001",
				token: "token_abc",
			}),
		);

		expect(url.protocol).toBe("fabric-kanban:");
		expect(url.hostname).toBe("open");
		expect(url.searchParams.get("projectId")).toBe("proj_123");
		expect(url.searchParams.get("taskId")).toBe("story_456");
		expect(url.searchParams.get("origin")).toBe("http://localhost:3001");
		expect(url.searchParams.get("token")).toBe("token_abc");
	});

	it("builds standalone full-view urls from iframe urls", () => {
		const url = new URL(
			buildStandaloneKanbanUrl(
				"http://localhost:3484/?embed=true&projectId=proj_123&parentOrigin=http%3A%2F%2Flocalhost%3A3001&embedToken=token_...56&taskId=story_456",
			),
		);

		expect(url.origin).toBe("http://localhost:3484");
		expect(url.searchParams.get("embed")).toBeNull();
		expect(url.searchParams.get("projectId")).toBe("proj_123");
		expect(url.searchParams.get("embedToken")).toBe("token_...56");
		expect(url.searchParams.get("taskId")).toBe("story_456");
	});

	it("builds a runtime status endpoint url", () => {
		expect(buildKanbanRuntimeStatusUrl()).toBe(
			"http://localhost:3484/api/runtime/status",
		);
	});

	it("only embeds when runtime explicitly reports embed mode for this parent origin", () => {
		expect(
			getKanbanLaunchModeFromStatus(
				{ mode: "embed", parentOrigin: "http://localhost:3001" },
				"http://localhost:3001",
			),
		).toBe("embed");
		expect(
			getKanbanLaunchModeFromStatus(
				{ mode: "standalone", parentOrigin: null },
				"http://localhost:3001",
			),
		).toBe("external");
		expect(
			getKanbanLaunchModeFromStatus(
				{ mode: "embed", parentOrigin: "http://localhost:9999" },
				"http://localhost:3001",
			),
		).toBe("external");
	});

	it("normalizes parent origins before comparing embed eligibility", () => {
		expect(
			getKanbanLaunchModeFromStatus(
				{ mode: "embed", parentOrigin: "http://localhost:3001/" },
				"http://localhost:3001",
			),
		).toBe("embed");
	});
});
