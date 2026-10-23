import { describe, expect, it } from "vitest";
import { isFullHeightPath, isWorkflowCanvasPath } from "../full-height-routes";

describe("isWorkflowCanvasPath", () => {
	it("matches only the editor of one workflow, in either context", () => {
		expect(
			isWorkflowCanvasPath("/app/example-org/workflows/wf-example"),
		).toBe(true);
		expect(isWorkflowCanvasPath("/app/workflows/wf-example")).toBe(true);
		expect(isWorkflowCanvasPath("/app/example-org/workflows")).toBe(false);
		expect(isWorkflowCanvasPath("/app/example-org/workflows/new")).toBe(
			false,
		);
		expect(
			isWorkflowCanvasPath("/app/example-org/frames/frame-example"),
		).toBe(false);
	});
});

describe("isFullHeightPath", () => {
	it("takes the workflow editor under an organization, which is where it lives", () => {
		expect(isFullHeightPath("/app/example-org/workflows/wf-example")).toBe(
			true,
		);
	});

	it("still takes the personal editor route", () => {
		expect(isFullHeightPath("/app/workflows/wf-example")).toBe(true);
	});

	it("leaves the workflow list, new and integrations pages scrolling normally", () => {
		expect(isFullHeightPath("/app/example-org/workflows")).toBe(false);
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
