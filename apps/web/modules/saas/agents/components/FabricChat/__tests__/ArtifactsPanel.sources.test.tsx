import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildArtifactSources } from "../artifact-sources";
import { ArtifactsPanel } from "../orchestrator/ArtifactsPanel";

afterEach(cleanup);

// Labels emitted by the completion summary, also retained in saved executions.
const routingLabels = [
	"Past Executions",
	"Keyword Memory",
	"Failure Avoidance",
];

function showSources(
	sourcesUsed: string[],
	completedExecutions: { sourcesUsed?: string[] }[] = [],
) {
	const sources = buildArtifactSources(sourcesUsed, completedExecutions);
	render(
		<ArtifactsPanel
			isOpen
			onClose={() => {}}
			defaultTab="sources"
			sources={sources}
		/>,
	);
	return sources;
}

function expectMemoryRows(labels: string[]) {
	const panel = screen.getByRole("tabpanel");
	for (const label of labels) {
		expect(within(panel).getByText(label)).toBeInTheDocument();
	}
	expect(within(panel).getAllByText("memory")).toHaveLength(labels.length);
	expect(panel.querySelectorAll("svg.lucide-database")).toHaveLength(
		labels.length,
	);
	expect(within(panel).queryByText("document")).not.toBeInTheDocument();
	expect(panel.querySelector("svg.lucide-file-text")).toBeNull();
}

describe("ArtifactsPanel Advisor sources", () => {
	it("shows the empty state without a source count for empty summary and saved labels", () => {
		expect(showSources([], [{}])).toEqual([]);
		expect(screen.getByText("No sources referenced")).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Sources" })).toHaveTextContent(
			/^Sources$/,
		);
		expect(
			screen.getByRole("tabpanel").querySelector("svg.lucide-database"),
		).toBeNull();
	});

	it("converts the Orchestrator Memory summary label to the memory icon and type", () => {
		showSources(["Orchestrator Memory"]);
		expectMemoryRows(["Orchestrator Memory"]);
		expect(
			screen.getByRole("tab", { name: "Sources 1" }),
		).toBeInTheDocument();
		for (const label of routingLabels) {
			expect(screen.queryByText(label)).not.toBeInTheDocument();
		}
	});

	it("converts stored legacy routing labels to memory rows and deduplicates current labels", () => {
		const sources = showSources(
			["Past Executions"],
			[{ sourcesUsed: routingLabels }],
		);
		expect(sources.map(({ id, title }) => ({ id, title }))).toEqual(
			routingLabels.map((title, index) => ({
				id: `source-${index}`,
				title,
			})),
		);
		expectMemoryRows(routingLabels);
		expect(
			screen.getByRole("tab", { name: "Sources 3" }),
		).toBeInTheDocument();
	});
});

describe("all planning audit source categories", () => {
	it.each([
		["orchestrator_memory", "Orchestrator Memory", "memory", "database"],
		["workspace_rag", "Workspace Documents", "workspace", "folder"],
		["agent_template", "Agent Template", "document", "file-text"],
		["policy_enrichment", "System Policies", "document", "file-text"],
		["project_context", "Project Context", "workspace", "folder"],
		["fabric_pattern", "Fabric Patterns", "document", "file-text"],
		["semantic_memory", "Past Executions", "memory", "database"],
		["letta_memory", "Keyword Memory", "memory", "database"],
		["negative_memory", "Failure Avoidance", "memory", "database"],
		["trajectory_reuse", "Similar Trajectory", "memory", "database"],
		["agent_capabilities", "Agent Capabilities", "code", "code-xml"],
		["mcp_tool_discovery", "Available Tools", "code", "code-xml"],
		["user_input", "User Input", "document", "file-text"],
		["web_research", "Web Research", "web", "globe"],
	])(
		"renders %s and its summary label with the right icon",
		(raw, label, type, icon) => {
			const sources = showSources([label], [{ sourcesUsed: [raw] }]);
			expect(sources.map((source) => source.type)).toEqual([type, type]);
			const panel = screen.getByRole("tabpanel");
			expect(within(panel).getByText(label)).toBeInTheDocument();
			expect(within(panel).getByText(raw)).toBeInTheDocument();
			expect(within(panel).getAllByText(type)).toHaveLength(2);
			expect(panel.querySelectorAll(`svg.lucide-${icon}`)).toHaveLength(
				2,
			);
		},
	);
});
