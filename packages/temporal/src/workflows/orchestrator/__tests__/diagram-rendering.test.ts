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
import { FABRIC_GATEWAY_CATALOG_TOOLS } from "../../../activities/orchestrator/tools/fabric-gateway-catalog-tools";
import {
	DIAGRAM_RENDERING_GUIDANCE,
	isInlineDiagramRequest,
} from "../diagram-rendering";

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

describe("orchestrator agent intent", () => {
	it.each([
		"Use an agent to research pricing",
		"Ask the agent to summarize",
		"use another agent",
		"Run this agent again",
		"Call any agent that can help",
	])("does not name an agent in generic phrasing: %s", (message) => {
		const intent = detectUserIntent(message);
		expect(intent.requestedAgentName).toBeUndefined();
		expect(intent.requestedAgent).toBeUndefined();
	});

	it.each([
		"a",
		"an",
		"the",
		"this",
		"that",
		"these",
		"those",
		"another",
		"any",
		"some",
		"each",
		"every",
		"my",
		"our",
		"your",
		"their",
		"other",
		"same",
		"new",
		"right",
		"best",
		"appropriate",
		"relevant",
		"suitable",
		"specialized",
		"specialised",
		"correct",
		"proper",
		"available",
		"an_agent",
	])("rejects a generic capture ignoring case: %s", (word) => {
		expect(
			detectUserIntent(`use "${word.toUpperCase()}" agent`)
				.requestedAgentName,
		).toBeUndefined();
	});

	it.each([
		{ message: "Use the agent called cuga to summarize", expected: "cuga" },
		{
			message: "Ask an agent named data_analyst to chart this",
			expected: "data_analyst",
		},
		{
			message: "Use this agent with the data_analyst agent",
			expected: "data_analyst",
		},
		{ message: "use cuga agent", expected: "cuga" },
		{ message: 'use "Task Planner" agent', expected: "Task Planner" },
	])("keeps a named agent in $message", ({ message, expected }) => {
		expect(detectUserIntent(message)).toMatchObject({
			requestedAgentName: expected,
			requestedAgent: expected,
		});
	});
});

describe("prompt guidance", () => {
	it("tells the model mermaid renders inline and gates Excalidraw on an explicit ask", () => {
		expect(DIAGRAM_RENDERING_GUIDANCE).toMatch(/```mermaid/);
		expect(DIAGRAM_RENDERING_GUIDANCE).toMatch(
			/Excalidraw tool .* only when the user explicitly asks/,
		);
	});

	it("offers the frame tool no CDN list a no-network page could not load, and points a plain diagram at the inline block", () => {
		const description =
			FABRIC_GATEWAY_CATALOG_TOOLS.find(
				(tool) => tool.name === "fabric_create_frame",
			)?.description ?? "";

		expect(description).not.toMatch(/CDN/);
		expect(description).toMatch(/```mermaid/);
	});

	it("gates the orchestrator guidance on its own marker", () => {
		const source = readSource(
			"src/workflows/orchestrator/phases/iterative-execution.ts",
		);
		expect(source).toMatch(
			/if \(patched\("orch-diagram-inline-mermaid-v1"\)\) \{\s*systemPrompt \+= `\\n\\n\$\{DIAGRAM_RENDERING_GUIDANCE\}`;\s*\}/,
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
