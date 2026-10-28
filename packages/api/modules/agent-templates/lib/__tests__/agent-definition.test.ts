import { describe, expect, it } from "vitest";
import {
	type AgentDefinitionSource,
	exportAgentDefinition,
	parseAgentDefinition,
	serializeAgentDefinition,
} from "../agent-definition";

const source: AgentDefinitionSource = {
	name: "Research assistant",
	description: "Summarize authorized documents",
	template: {
		instructions: "Cite your sources.",
		suggestedModel: "example-model",
		modelConfig: { temperature: 0.2 },
	},
	customInstructions: {
		role: "Research a topic",
		starterMessages: ["Summarize the report"],
		knowledgeFilters: ["source-document"],
		apiKey: "example-secret",
	},
	modelOverride: null,
	modelConfig: {
		temperature: 0.4,
		apiKey: "example-secret",
		baseURL: "https://example.com/private",
	},
	executionMode: "single_turn",
	goal: null,
	maxIterations: 10,
	successCriteria: null,
	toolConnections: {
		"web-search": { enabled: true },
		"mcp:source-connection": {
			enabled: true,
			credentials: "example-secret",
		},
	},
	triggers: [
		{
			type: "slack",
			config: { token: "example-secret", channel: "source-channel" },
		},
	],
	workspaceIds: ["source-workspace"],
	memoryFiles: [
		{
			path: "skills/research/SKILL.md",
			content: "# Research\nFind relevant sources.",
			isEnabled: true,
		},
	],
	integrationConfigurations: [{ integrationType: "SLACK" }],
	mcpServerConfigurations: [{ name: "Example tools" }],
};

describe("portable agent definitions", () => {
	it.each(["json", "yaml"] as const)(
		"round trips %s without changing portable intent",
		(format) => {
			const definition = exportAgentDefinition(source);
			const document = serializeAgentDefinition(definition, format);
			expect(parseAgentDefinition(document)).toEqual(definition);
			expect(
				serializeAgentDefinition(
					parseAgentDefinition(document),
					format,
				),
			).toBe(document);
		},
	);
	it("excludes tenant references, credentials and arbitrary model options", () => {
		const definition = exportAgentDefinition(source);
		const document = serializeAgentDefinition(definition, "yaml");
		for (const value of [
			"example-secret",
			"source-connection",
			"source-workspace",
			"source-channel",
			"source-document",
			"baseURL",
		]) {
			expect(document).not.toContain(value);
		}
		expect(definition.requirements).toEqual(
			expect.arrayContaining([
				{ kind: "tool", name: "web-search" },
				{ kind: "trigger", name: "slack" },
				{ kind: "knowledge", name: "Knowledge access" },
			]),
		);
	});
	it("retains unresolved requirements on re-export and deduplicates them", () => {
		const definition = exportAgentDefinition(source);
		expect(
			exportAgentDefinition({
				...source,
				customInstructions: {
					...(source.customInstructions as object),
					portableRequirements: definition.requirements,
				},
			}).requirements,
		).toEqual(definition.requirements);
	});
	it.each([
		[
			"unsupported version",
			(d: Record<string, unknown>) => ({
				...d,
				apiVersion: "fabric.ai/v99",
			}),
		],
		[
			"credential field",
			(d: Record<string, unknown>) => ({
				...d,
				credentials: "example-secret",
			}),
		],
		[
			"tenant field",
			(d: Record<string, unknown>) => ({
				...d,
				organizationId: "source-org",
			}),
		],
		[
			"duplicate paths",
			(d: Record<string, unknown>) => ({
				...d,
				skills: [...source.memoryFiles, ...source.memoryFiles].map(
					(s) => ({
						path: s.path,
						content: s.content,
						enabled: true,
					}),
				),
			}),
		],
		[
			"path traversal",
			(d: Record<string, unknown>) => ({
				...d,
				skills: [
					{
						path: "skills/../SKILL.md",
						content: "test",
						enabled: true,
					},
				],
			}),
		],
		[
			"goal missing",
			(d: Record<string, unknown>) => ({
				...d,
				execution: { mode: "goal_oriented", maxIterations: 10 },
			}),
		],
	] as const)("rejects %s", (_, change) => {
		expect(() =>
			parseAgentDefinition(
				JSON.stringify(change(exportAgentDefinition(source))),
			),
		).toThrow();
	});
	it.each(["json", "yaml"] as const)(
		"rejects duplicate instruction keys in %s",
		(format) => {
			const document = serializeAgentDefinition(
				exportAgentDefinition(source),
				format,
			);
			expect(() => parseAgentDefinition(document)).not.toThrow();
			const duplicate =
				format === "json"
					? document.replace(
							/"template":/,
							'"template":"Hidden instructions", "template":',
						)
					: document.replace(
							"  template:",
							"  template: Hidden instructions\n  template:",
						);
			expect(duplicate).not.toBe(document);
			expect(() => parseAgentDefinition(duplicate)).toThrow();
		},
	);
	it("rejects YAML aliases, deep nesting and oversized inputs", () => {
		expect(() =>
			parseAgentDefinition(
				serializeAgentDefinition(exportAgentDefinition(source), "yaml")
					.replace(
						"name: Research assistant",
						"name: &a Research assistant",
					)
					.replace(
						"description: Summarize authorized documents",
						"description: *a",
					),
			),
		).toThrowError(expect.objectContaining({ code: "ALIAS_LIMIT" }));
		expect(() =>
			parseAgentDefinition(
				JSON.stringify({
					...exportAgentDefinition(source),
					model: {
						temperature: JSON.parse(
							`${"[".repeat(20)}0${"]".repeat(20)}`,
						),
					},
				}),
			),
		).toThrowError(expect.objectContaining({ code: "TOO_DEEP" }));
		expect(() =>
			parseAgentDefinition(" ".repeat(1024 * 1024 + 1)),
		).toThrow();
	});
});
