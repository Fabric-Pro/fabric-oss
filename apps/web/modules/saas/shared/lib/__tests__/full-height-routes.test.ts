import { describe, expect, it } from "vitest";
import {
	isAgentBuilderPath,
	isFullHeightPath,
	isWorkflowCanvasPath,
} from "../full-height-routes";

describe("isWorkflowCanvasPath", () => {
	it("matches the workflow studio and an individual editor", () => {
		expect(
			isWorkflowCanvasPath("/app/example-org/workflows/wf-example"),
		).toBe(true);
		expect(isWorkflowCanvasPath("/app/workflows/wf-example")).toBe(true);
		expect(isWorkflowCanvasPath("/app/example-org/workflows")).toBe(true);
		expect(isWorkflowCanvasPath("/app/example-org/workflows/new")).toBe(
			false,
		);
		expect(
			isWorkflowCanvasPath("/app/example-org/frames/frame-example"),
		).toBe(false);
	});
});

describe("isFullHeightPath", () => {
	it("keeps Genie inside the viewport without changing neighboring agent pages", () => {
		expect(isFullHeightPath("/app/example-org/agents/fabric-ai")).toBe(
			true,
		);
		expect(isFullHeightPath("/app/example-org/agents")).toBe(false);
		expect(isFullHeightPath("/app/example-org/agents/example-agent")).toBe(
			false,
		);
		expect(
			isFullHeightPath("/app/example-org/agents/fabric-ai/memory"),
		).toBe(false);
	});
	it("takes the workflow editor under an organization, which is where it lives", () => {
		expect(isFullHeightPath("/app/example-org/workflows/wf-example")).toBe(
			true,
		);
	});

	it("still takes the personal editor route", () => {
		expect(isFullHeightPath("/app/workflows/wf-example")).toBe(true);
	});

	it("fills the list studio while leaving new and integrations pages scrolling normally", () => {
		expect(isFullHeightPath("/app/example-org/workflows")).toBe(true);
		expect(isFullHeightPath("/app/example-org/workflows/new")).toBe(false);
		expect(
			isFullHeightPath("/app/example-org/workflows/integrations"),
		).toBe(false);
		expect(isFullHeightPath("/app/workflows/new")).toBe(false);
	});

	it("keeps the chatbot and kanban routes", () => {
		expect(isFullHeightPath("/app/example-org/agents/a1/chatbot")).toBe(
			true,
		);
		expect(isFullHeightPath("/app/example-org/projects/p1/kanban")).toBe(
			true,
		);
		expect(isFullHeightPath("/app/example-org/projects")).toBe(false);
	});
});

describe("dedicated agent authoring", () => {
	it.each([
		"/app/example-org/agents/create",
		"/app/example-org/agents/example-agent/edit",
		"/app/example-org/agents/example-agent/duplicate",
		"/app/example-org/agent-templates/example-template/create",
		"/app/example-org/agent-templates/agents/example-agent/edit",
	])("fills the viewport for %s", (path) => {
		expect(isAgentBuilderPath(path)).toBe(true);
		expect(isFullHeightPath(path)).toBe(true);
	});
	it.each([
		"/app/example-org/agents",
		"/app/example-org/agents/example-agent",
		"/app/example-org/agents/inbox",
		"/app/example-org/agents/fabric-ai",
		"/app/example-org/projects/example-project",
		"/app/agents/create",
	])("retains ordinary navigation for %s", (path) => {
		expect(isAgentBuilderPath(path)).toBe(false);
	});
});
