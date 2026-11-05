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

const pinnedImplementation = {
	kind: "harness_finite",
	artifact: {
		digest: `sha256:${"a".repeat(64)}`,
		repository: {
			url: "https://example.com/agents.git",
			revision: "b".repeat(40),
		},
		packages: {
			sdk: {
				name: "@fabric-harness/sdk",
				version: "6.9.0",
				entrypoint: "strict",
			},
			node: { name: "@fabric-harness/node", version: "6.7.0" },
			client: { name: "@fabric-harness/client", version: "6.3.1" },
		},
		buildManifestVersion: 2,
	},
	entrypoint: {
		module: "dist/report.mjs",
		export: "reportJob",
		identity: "report-job",
	},
	protocol: { generation: "example-http-v1", interface: "finite_job" },
	schemas: {
		input: {
			path: "schemas/input.json",
			digest: `sha256:${"c".repeat(64)}`,
		},
		output: {
			path: "schemas/output.json",
			digest: `sha256:${"d".repeat(64)}`,
		},
	},
};
const logicalBindings = [
	{
		name: "project-context",
		kind: "knowledge",
		required: true,
		operations: ["read"],
	},
];
const harnessSource = () => ({
	...source,
	customInstructions: {
		...(source.customInstructions as object),
		portableDefinitionVersion: "fabric.ai/v2",
		portableImplementation: structuredClone(pinnedImplementation),
		portableBindings: logicalBindings,
		expectedOutput: "Cited documentation proposal",
	},
});

import {
	assertAgentDefinitionConfigUpdate,
	exportLegacyAgentDefinition,
	getAgentImplementationAvailability,
} from "../agent-definition";

describe("pinned implementation definitions", () => {
	it.each(["json", "yaml"] as const)(
		"retains exact implementation identity, schemas and logical intent through %s export/import",
		(format) => {
			const exported = exportAgentDefinition(harnessSource());
			expect(exported.apiVersion).toBe("fabric.ai/v2");
			expect(exported.implementation).toEqual(pinnedImplementation);
			expect(exported.logicalBindings).toEqual(logicalBindings);
			expect(exported.expectedOutput).toBe(
				"Cited documentation proposal",
			);
			expect(
				parseAgentDefinition(
					serializeAgentDefinition(exported, format),
				),
			).toEqual(exported);
		},
	);
	it("never downgrades an advanced release or native output requirements into lossy v1", () => {
		expect(() => exportLegacyAgentDefinition(harnessSource())).toThrow(
			/v2/,
		);
		expect(() =>
			exportLegacyAgentDefinition({
				...source,
				customInstructions: { expectedOutput: "Review the report" },
			}),
		).toThrow(/v2/);
		expect(exportLegacyAgentDefinition(source).apiVersion).toBe(
			"fabric.ai/v1",
		);
	});
	it("refuses invalid stored metadata rather than exporting a native replacement", () => {
		expect(() =>
			exportAgentDefinition({
				...source,
				customInstructions: {
					portableImplementation: { kind: "unknown" },
				},
			}),
		).toThrow();
	});
	it.each([
		[
			"floating package",
			(d: any) => {
				d.implementation.artifact.packages.sdk.version = "^6.9.0";
			},
		],
		[
			"repository branch",
			(d: any) => {
				d.implementation.artifact.repository.revision = "main";
			},
		],
		[
			"repository credential",
			(d: any) => {
				d.implementation.artifact.repository.url =
					"https://token@example.com/agents.git";
			},
		],
		[
			"missing identity",
			(d: any) => {
				delete d.implementation.entrypoint.identity;
			},
		],
		[
			"implicit entrypoint",
			(d: any) => {
				delete d.implementation.entrypoint.export;
			},
		],
		[
			"path traversal",
			(d: any) => {
				d.implementation.entrypoint.module = "../other.ts";
			},
		],
		[
			"missing output schema",
			(d: any) => {
				delete d.implementation.schemas.output;
			},
		],
		[
			"mismatched runtime",
			(d: any) => {
				d.implementation.kind = "harness_persistent";
			},
		],
		[
			"source destination grant",
			(d: any) => {
				d.logicalBindings[0].connectionId = "source-connection";
			},
		],
		[
			"duplicate bindings",
			(d: any) => {
				d.logicalBindings.push({ ...d.logicalBindings[0] });
			},
		],
		[
			"unsupported legacy implementation",
			(d: any) => {
				d.apiVersion = "fabric.ai/v1";
			},
		],
	] as const)("rejects %s", (_, change) => {
		const definition = exportAgentDefinition(harnessSource());
		change(definition);
		expect(() =>
			parseAgentDefinition(JSON.stringify(definition)),
		).toThrow();
	});
	it("preserves explicit persistent submission identity without pretending it can execute", () => {
		const definition = exportAgentDefinition(harnessSource());
		const persistent = {
			...definition,
			implementation: {
				...pinnedImplementation,
				kind: "harness_persistent",
				protocol: {
					...pinnedImplementation.protocol,
					interface: "persistent_submission",
				},
			},
		};
		const parsed = parseAgentDefinition(JSON.stringify(persistent));
		expect(parsed).toMatchObject({
			implementation: {
				kind: "harness_persistent",
				entrypoint: pinnedImplementation.entrypoint,
			},
		});
		expect(
			getAgentImplementationAvailability({
				portableImplementation: persistent.implementation,
			}).available,
		).toBe(false);
	});
	it.each(["harness_finite", "harness_persistent", "unknown", null])(
		"blocks unsupported implementation admission: %s",
		(kind) => {
			expect(
				getAgentImplementationAvailability({
					portableImplementation: kind === null ? null : { kind },
				}).available,
			).toBe(false);
		},
	);
	it("allows existing native agents but fails closed on malformed native metadata or missing v2 identity", () => {
		expect(getAgentImplementationAvailability(null).available).toBe(true);
		expect(
			getAgentImplementationAvailability({
				portableImplementation: { kind: "native" },
			}).available,
		).toBe(true);
		expect(
			getAgentImplementationAvailability({
				portableDefinitionVersion: "fabric.ai/v2",
			}).available,
		).toBe(false);
		expect(
			getAgentImplementationAvailability({
				portableImplementation: { kind: "native", artifact: {} },
			}).available,
		).toBe(false);
	});
	it("protects code-owned fields and reserved metadata across generic command paths", () => {
		for (const field of [
			"customInstructions",
			"modelOverride",
			"modelConfig",
			"executionMode",
			"goal",
			"successCriteria",
			"maxIterations",
			"toolConnections",
			"knowledgeConnections",
			"knowledgeResources",
			"workspaceIds",
			"triggers",
		]) {
			expect(() =>
				assertAgentDefinitionConfigUpdate(
					harnessSource().customInstructions,
					{ [field]: {} },
				),
			).toThrow(/read-only/);
		}
		for (const key of [
			"portableImplementation",
			"portableBindings",
			"portableDefinitionVersion",
		]) {
			expect(() =>
				assertAgentDefinitionConfigUpdate(null, {
					customInstructions: { [key]: {} },
				}),
			).toThrow(/release metadata/);
		}
		expect(() =>
			assertAgentDefinitionConfigUpdate(
				harnessSource().customInstructions,
				{
					name: "Renamed report",
					projectId: "example-project",
					expectedOutput: "Review this result",
				},
			),
		).not.toThrow();
		expect(() =>
			assertAgentDefinitionConfigUpdate(null, {
				customInstructions: { role: "Native instructions" },
				executionMode: "single_turn",
			}),
		).not.toThrow();
	});
});

describe("portable project association", () => {
	it("retains a logical project requirement while removing the source project identity", () => {
		const definition = exportAgentDefinition({
			...source,
			customInstructions: {
				projectId: "source-project",
				expectedOutput: "Cited project report",
			},
		});
		expect(definition.logicalBindings).toEqual([
			{
				name: "associated-project",
				kind: "project",
				required: true,
				operations: [],
			},
		]);
		expect(JSON.stringify(definition)).not.toContain("source-project");
		expect(definition.expectedOutput).toBe("Cited project report");
	});
	it("does not qualify a different selected agent simply because the artifact digest matches", () => {
		const custom = harnessSource().customInstructions;
		custom.portableImplementation.entrypoint.identity =
			"other-agent-in-same-bundle";
		expect(getAgentImplementationAvailability(custom).available).toBe(
			false,
		);
	});
});
