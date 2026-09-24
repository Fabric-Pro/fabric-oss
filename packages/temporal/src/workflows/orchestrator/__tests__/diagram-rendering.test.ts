/**
 * Diagram requests answer inline (#2040 review F34 / F39).
 *
 * Both chat engines render a ```mermaid block as a diagram, yet "visualize"
 * forced every such request into a frame and Direct's prompt ordered an MCP
 * drawing tool for any "draw / diagram" turn. Diagram wording now yields to
 * inline mermaid unless the user asks for a frame, slides or an interactive
 * page, and Excalidraw is called only on an explicit ask.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectUserIntent } from "../../../activities/orchestrator/routing/intent/user-intent-detector";
import {
	DIAGRAM_RENDERING_GUIDANCE,
	isInlineDiagramRequest,
} from "../diagram-rendering";
import { FABRIC_CREATE_FRAME_TOOL } from "../frame-tool-schemas";

function readSource(path: string): string {
	return readFileSync(join(process.cwd(), path), "utf-8");
}

describe("isInlineDiagramRequest", () => {
	it.each([
		"visualize this flow as a mermaid diagram",
		"draw a sequence diagram of login",
		"Can you make a flowchart of the release process?",
	])("treats %j as an inline diagram", (message) => {
		expect(isInlineDiagramRequest(message)).toBe(true);
	});

	it.each([
		"create a frame with a mermaid diagram of the pipeline",
		"build an interactive diagram of our services",
		"make slides with an architecture diagram",
		"draw an excalidraw diagram of the flow",
		"summarize the roadmap",
	])("does not treat %j as an inline diagram", (message) => {
		expect(isInlineDiagramRequest(message)).toBe(false);
	});
});

describe("orchestrator frame intent", () => {
	it("no longer forces a frame for a diagram worded 'visualize'", () => {
		expect(
			detectUserIntent("visualize this flow as a mermaid diagram")
				.requestedFrameOutput,
		).toBeUndefined();
		expect(
			detectUserIntent("visualize the login flow").requestedFrameOutput,
		).toBeUndefined();
	});

	it("still routes explicit frame and dashboard requests to a frame", () => {
		expect(
			detectUserIntent("create a frame with a mermaid diagram")
				.requestedFrameOutput,
		).toBe("frame");
		expect(
			detectUserIntent(
				"create an interactive dashboard of sprint velocity",
			).requestedFrameOutput,
		).toBe("frame");
	});
});

describe("prompt guidance", () => {
	it("tells the model mermaid renders inline and gates Excalidraw on an explicit ask", () => {
		expect(DIAGRAM_RENDERING_GUIDANCE).toMatch(/```mermaid/);
		expect(DIAGRAM_RENDERING_GUIDANCE).toMatch(
			/Excalidraw tool .* only when the user explicitly asks/,
		);
	});

	it("drops Mermaid from the frame tool's CDN list", () => {
		expect(FABRIC_CREATE_FRAME_TOOL.description).not.toMatch(
			/CDN OK for[^;]*Mermaid/,
		);
	});

	it("gates the orchestrator guidance on its own marker", () => {
		const source = readSource(
			"src/workflows/orchestrator/phases/iterative-execution.ts",
		);
		expect(source).toMatch(
			/if \(patched\("orch-diagram-inline-mermaid-v1"\)\) \{\s*iterationSystemPrompt \+= `\\n\\n\$\{DIAGRAM_RENDERING_GUIDANCE\}`;\s*\}/,
		);
	});

	it("replaces Direct's draw-means-call-a-tool rule with the shared guidance", () => {
		const source = readSource("src/activities/direct-chat/ai-execution.ts");
		expect(source).not.toMatch(/call the appropriate MCP tool immediately/);
		expect(source).toMatch(/\$\{DIAGRAM_RENDERING_GUIDANCE\}/);
		const framePatterns = source.slice(
			source.indexOf("const framePatterns = ["),
			source.indexOf("];", source.indexOf("const framePatterns = [")),
		);
		expect(framePatterns).not.toContain('"visualize",');
	});
});
