import { describe, expect, it } from "vitest";
import { findScheduleCron } from "../../schedules/workflow-builder-schedule";
import { AGENT_TASK_CAPABILITY_KEYS } from "../agent-task-capabilities";
import {
	AGENT_TASK_NODE_TYPE,
	AgentTaskNodeConfigSchema,
	AgentTaskToFramePresetSchema,
	applyPresetPatch,
	buildAgentTaskToFramePreset,
	FRAME_SURFACES,
	PresetCreateArgsSchema,
	PresetPatchSchema,
	PresetUpdateArgsSchema,
	PUBLISH_FRAME_NODE_TYPE,
	PublishFrameNodeConfigSchema,
	readGraphFacts,
	WorkflowDraftSchema,
} from "../agentic-workflow-preset";
import { FABRIC_WORKFLOW_TOOL_DEFINITIONS } from "../fabric-workflow-tool-definitions";

const preset = {
	name: "Weekly work items",
	cron: "0 9 * * 1",
	timezone: "Europe/Berlin",
	prompt: "Summarise my open work items.",
	mcpConfigIds: ["mcp-config-1"],
	builtInToolNames: ["project-context"],
	outputTitle: "Weekly status",
	projectId: "project-1",
};

describe("buildAgentTaskToFramePreset", () => {
	it("chains schedule → agent-task → publish-frame", () => {
		const { nodes, edges } = buildAgentTaskToFramePreset(preset);

		expect(nodes.map((node) => node.type)).toEqual([
			"trigger",
			AGENT_TASK_NODE_TYPE,
			PUBLISH_FRAME_NODE_TYPE,
		]);
		expect(edges).toEqual([
			{
				id: "trigger-agent-task",
				source: "trigger",
				target: "agent-task",
			},
			{
				id: "agent-task-publish-frame",
				source: "agent-task",
				target: "publish-frame",
			},
		]);
	});

	it("puts the cron and time zone where the schedule sync reads them", () => {
		const { nodes } = buildAgentTaskToFramePreset(preset);

		expect(findScheduleCron(nodes)).toBe("0 9 * * 1");
		expect(nodes[0]?.data.config).toMatchObject({
			triggerType: "schedule",
			scheduleTimezone: "Europe/Berlin",
		});
	});

	it("produces node configs that pass their own schemas", () => {
		const { nodes } = buildAgentTaskToFramePreset(preset);

		const agent = AgentTaskNodeConfigSchema.parse(nodes[1]?.data.config);
		const publish = PublishFrameNodeConfigSchema.parse(
			nodes[2]?.data.config,
		);

		expect(agent).toMatchObject({
			prompt: preset.prompt,
			mcpConfigIds: ["mcp-config-1"],
			builtInToolNames: ["project-context"],
			maxIterations: 10,
			outputFormat: "html",
		});
		expect(publish).toMatchObject({
			title: "Weekly status",
			content: "{{Agent Task.html}}",
			format: "html",
			projectId: "project-1",
			surface: "artifact",
			mode: "new-version",
		});
	});

	it("follows the agent's output format into the published content", () => {
		const { nodes } = buildAgentTaskToFramePreset({
			...preset,
			outputFormat: "markdown",
		});

		expect(nodes[2]?.data.config).toMatchObject({
			content: "{{Agent Task.markdown}}",
			format: "markdown",
		});
	});

	it("defaults the time zone to UTC", () => {
		const { timezone: _timezone, ...withoutTimezone } = preset;
		const { nodes } = buildAgentTaskToFramePreset(withoutTimezone);

		expect(nodes[0]?.data.config).toMatchObject({
			scheduleTimezone: "UTC",
		});
	});

	it("rejects an agent allowed more than ten iterations", () => {
		expect(() =>
			buildAgentTaskToFramePreset({ ...preset, maxIterations: 11 }),
		).toThrow();
	});
});

/** The graph as the builder saves it: the preset's nodes plus builder-only fields. */
function storedGraph() {
	return buildAgentTaskToFramePreset(preset).nodes.map((node) => ({
		...node,
		selected: false,
		width: 240,
	}));
}

describe("readGraphFacts", () => {
	it("reads the schedule, the agent, the page and the steps off a stored graph", () => {
		const facts = readGraphFacts(storedGraph());

		expect(facts).toEqual({
			schedule: { cron: "0 9 * * 1", timezone: "Europe/Berlin" },
			agent: {
				prompt: preset.prompt,
				mcpConfigIds: ["mcp-config-1"],
				builtInToolNames: ["project-context"],
				outputFormat: "html",
			},
			publish: { title: "Weekly status", projectId: "project-1" },
			steps: [
				{ type: "trigger", label: "Schedule" },
				{ type: AGENT_TASK_NODE_TYPE, label: "Agent Task" },
				{ type: PUBLISH_FRAME_NODE_TYPE, label: "Publish Frame" },
			],
		});
	});

	it("reads the cron the way the schedule sync does", () => {
		const nodes = storedGraph();

		expect(readGraphFacts(nodes).schedule?.cron).toBe(
			findScheduleCron(nodes),
		);
	});

	it("reads a workflow saved without a time zone as UTC", () => {
		const nodes = storedGraph();
		const trigger = nodes[0];
		if (!trigger) {
			throw new Error("no trigger");
		}
		const { scheduleTimezone: _zone, ...config } = trigger.data.config;
		trigger.data.config = config;

		expect(readGraphFacts(nodes).schedule?.timezone).toBe("UTC");
	});

	it("finds no schedule when the trigger is not a schedule", () => {
		const nodes = storedGraph();
		const trigger = nodes[0];
		if (!trigger) {
			throw new Error("no trigger");
		}
		trigger.data.config = { triggerType: "manual" };

		expect(readGraphFacts(nodes).schedule).toBeNull();
	});

	it("tolerates a graph that is not a node list, and nodes that are not objects", () => {
		expect(readGraphFacts(null).steps).toEqual([]);
		expect(readGraphFacts([null, "x", 4]).steps).toEqual([]);
	});

	it("names a step without a label by its id", () => {
		const facts = readGraphFacts([{ id: "n1", type: "http-request" }]);

		expect(facts.steps).toEqual([{ type: "http-request", label: "n1" }]);
	});
});

describe("the frame surfaces a published page may use", () => {
	it("are the ones the frame queries know, so a preset never names a surface they refuse", async () => {
		const { FRAME_SURFACES: queried } = await import("@repo/database");

		expect([...FRAME_SURFACES]).toEqual([...queried]);
	});

	it("are what the publish step's config accepts", () => {
		for (const surface of FRAME_SURFACES) {
			expect(
				PublishFrameNodeConfigSchema.safeParse({
					title: "Page",
					content: "{{x}}",
					surface,
				}).success,
			).toBe(true);
		}
		expect(
			PublishFrameNodeConfigSchema.safeParse({
				title: "Page",
				content: "{{x}}",
				surface: "elsewhere",
			}).success,
		).toBe(false);
	});
});

describe("PresetPatchSchema", () => {
	it("patches every preset field except the workflow's own name and description", () => {
		const presetKeys = Object.keys(
			AgentTaskToFramePresetSchema.shape,
		).filter((key) => key !== "name" && key !== "description");

		expect(Object.keys(PresetPatchSchema.shape).sort()).toEqual(
			presetKeys.sort(),
		);
	});

	it("leaves an omitted field omitted, instead of filling in the preset's default", () => {
		const patch = PresetPatchSchema.parse({ prompt: "New prompt." });

		expect(patch).toEqual({ prompt: "New prompt." });
	});

	it("holds a field to the preset's own rule for it", () => {
		expect(PresetPatchSchema.safeParse({ maxIterations: 11 }).success).toBe(
			false,
		);
		expect(PresetPatchSchema.safeParse({ cron: "  " }).success).toBe(false);
		expect(
			PresetPatchSchema.safeParse({ outputFormat: "pdf" }).success,
		).toBe(false);
	});
});

describe("applyPresetPatch", () => {
	function applied(patch: Parameters<typeof applyPresetPatch>[1]) {
		const result = applyPresetPatch(storedGraph(), patch);
		if (!result.ok) {
			throw new Error(result.error);
		}
		return result.nodes as ReturnType<typeof storedGraph>;
	}

	it("changes the schedule on the trigger and keeps it a schedule trigger", () => {
		const nodes = applied({ cron: "0 8 * * 5", timezone: "Asia/Tokyo" });

		expect(nodes[0]?.data.config).toEqual({
			triggerType: "schedule",
			scheduleCron: "0 8 * * 5",
			scheduleTimezone: "Asia/Tokyo",
		});
		expect(findScheduleCron(nodes)).toBe("0 8 * * 5");
	});

	it("changes the agent's configuration and nothing else", () => {
		const nodes = applied({
			prompt: "A new brief.",
			builtInToolNames: [],
			maxIterations: 4,
			modelId: "model-x",
		});

		expect(nodes[1]?.data.config).toMatchObject({
			prompt: "A new brief.",
			builtInToolNames: [],
			maxIterations: 4,
			modelId: "model-x",
			mcpConfigIds: ["mcp-config-1"],
		});
		expect(nodes[2]).toEqual(storedGraph()[2]);
	});

	it("moves the page's title and project", () => {
		const nodes = applied({
			outputTitle: "Friday digest",
			projectId: "p-2",
		});

		expect(nodes[2]?.data.config).toMatchObject({
			title: "Friday digest",
			projectId: "p-2",
		});
	});

	it("carries a new output format to both steps, and into the page's content", () => {
		const nodes = applied({ outputFormat: "markdown" });

		expect(nodes[1]?.data.config).toMatchObject({
			outputFormat: "markdown",
		});
		expect(nodes[2]?.data.config).toMatchObject({
			format: "markdown",
			content: "{{Agent Task.markdown}}",
		});
	});

	it("builds the content template the same way the preset builder does", () => {
		const built = buildAgentTaskToFramePreset({
			...preset,
			outputFormat: "markdown",
		});

		const nodes = applied({ outputFormat: "markdown" });

		expect(nodes[2]?.data.config.content).toBe(
			built.nodes[2]?.data.config.content,
		);
	});

	it("keeps what the builder saved on the nodes it did not edit", () => {
		const nodes = applied({ prompt: "A new brief." });

		expect(nodes[0]).toMatchObject({ selected: false, width: 240 });
		expect(nodes[1]).toMatchObject({ selected: false, width: 240 });
	});

	it("applies an empty patch as no change", () => {
		expect(applied({})).toEqual(storedGraph());
	});

	it("refuses a field whose step the graph does not have, rather than patching another", () => {
		const withoutPublish = storedGraph().filter(
			(node) => node.type !== PUBLISH_FRAME_NODE_TYPE,
		);

		const result = applyPresetPatch(withoutPublish, { outputTitle: "x" });

		expect(result).toEqual({
			ok: false,
			error: "This workflow has no publish step; send nodes and edges instead of a preset",
		});
	});

	it("refuses a schedule change on a graph with no trigger", () => {
		const withoutTrigger = storedGraph().filter(
			(node) => node.type !== "trigger",
		);

		const result = applyPresetPatch(withoutTrigger, { cron: "0 8 * * 5" });

		expect(result).toEqual({
			ok: false,
			error: "This workflow has no trigger step to change",
		});
	});

	it("refuses a patch that leaves a step invalid, naming it", () => {
		const result = applyPresetPatch(storedGraph(), {
			mcpConfigIds: Array.from({ length: 11 }, (_, i) => `mcp-${i}`),
		});

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("Agent step");
	});

	it("patches only the first step of a type", () => {
		const nodes = [
			...storedGraph(),
			{ ...storedGraph()[1], id: "agent-2" },
		];

		const result = applyPresetPatch(nodes, { prompt: "A new brief." });

		expect(result.ok).toBe(true);
		const patched = (result.ok ? result.nodes : []) as typeof nodes;
		expect(patched[1]?.data.config).toMatchObject({
			prompt: "A new brief.",
		});
		expect(patched[3]?.data.config).toMatchObject({
			prompt: preset.prompt,
		});
	});
});

describe("the arguments the MCP tools accept", () => {
	it("create takes the preset, with the title optional and servers by name", () => {
		const parsed = PresetCreateArgsSchema.parse({
			name: "Weekly work items",
			cron: "0 9 * * 1",
			prompt: "Summarise.",
			mcpServers: ["Azure DevOps"],
		});

		expect(parsed).toMatchObject({
			name: "Weekly work items",
			timezone: "UTC",
			mcpServers: ["Azure DevOps"],
		});
		expect(parsed.outputTitle).toBeUndefined();
	});

	it("create still requires a name, a schedule and a prompt", () => {
		const result = PresetCreateArgsSchema.safeParse({ name: "x" });

		expect(result.success).toBe(false);
	});

	it("update takes only the fields to change, plus servers by name", () => {
		const parsed = PresetUpdateArgsSchema.parse({
			prompt: "New.",
			mcpServers: ["Azure DevOps"],
		});

		expect(parsed).toEqual({
			prompt: "New.",
			mcpServers: ["Azure DevOps"],
		});
	});

	it("advertises no preset property the zod arguments would refuse", () => {
		const create = FABRIC_WORKFLOW_TOOL_DEFINITIONS.find(
			(definition) => definition.name === "fabric_create_workflow",
		);
		const properties = (
			create?.inputSchema.properties as {
				preset: { properties: Record<string, unknown> };
			}
		).preset.properties;

		const accepted = Object.keys(PresetCreateArgsSchema.shape);

		for (const advertised of Object.keys(properties)) {
			expect(accepted).toContain(advertised);
		}
	});

	it("advertises no update preset property the zod arguments would refuse", () => {
		const update = FABRIC_WORKFLOW_TOOL_DEFINITIONS.find(
			(definition) => definition.name === "fabric_update_workflow",
		);
		const properties = (
			update?.inputSchema.properties as {
				preset: { properties: Record<string, unknown> };
			}
		).preset.properties;

		const accepted = Object.keys(PresetUpdateArgsSchema.shape);

		for (const advertised of Object.keys(properties)) {
			expect(accepted).toContain(advertised);
		}
	});

	it.each(["fabric_create_workflow", "fabric_update_workflow"])(
		"%s offers builtInToolNames as the capability keys, not tool names",
		(toolName) => {
			const definition = FABRIC_WORKFLOW_TOOL_DEFINITIONS.find(
				(candidate) => candidate.name === toolName,
			);
			const properties = (
				definition?.inputSchema.properties as {
					preset: {
						properties: {
							builtInToolNames: {
								items: { enum: readonly string[] };
								description: string;
							};
						};
					};
				}
			).preset.properties;

			const field = properties.builtInToolNames;

			expect(field.items.enum).toEqual([...AGENT_TASK_CAPABILITY_KEYS]);
			expect(field.items.enum).toContain("project-context");
			expect(field.items.enum).not.toContain(
				"fabric_list_project_features",
			);
			expect(field.description).toBeTruthy();
		},
	);

	it("says on creation what each capability grants", () => {
		const create = FABRIC_WORKFLOW_TOOL_DEFINITIONS.find(
			(candidate) => candidate.name === "fabric_create_workflow",
		);
		const field = (
			create?.inputSchema.properties as {
				preset: {
					properties: { builtInToolNames: { description: string } };
				};
			}
		).preset.properties.builtInToolNames;

		expect(field.description).toContain(
			"project-context (read this project's roadmap, documents, sources and meetings)",
		);
	});

	it("accepts every capability key the schema offers", () => {
		const created = PresetCreateArgsSchema.safeParse({
			name: "Weekly work items",
			cron: "0 9 * * 1",
			prompt: "Summarise.",
			builtInToolNames: [...AGENT_TASK_CAPABILITY_KEYS],
		});
		const updated = PresetUpdateArgsSchema.safeParse({
			builtInToolNames: [...AGENT_TASK_CAPABILITY_KEYS],
		});

		expect(created.success).toBe(true);
		expect(updated.success).toBe(true);
	});
});

describe("WorkflowDraftSchema", () => {
	const draft = {
		kind: "workflow" as const,
		name: "Weekly work items",
		description: null,
		schedule: {
			cron: "0 9 * * 1",
			timezone: "UTC",
			description: "Every Monday at 09:00",
		},
		prompt: "Summarise.",
		mcpServers: [{ configId: "mcp-1", name: "Tracker" }],
		builtInTools: ["project-context"],
		project: { id: "project-1", name: "Example" },
		outputTitle: "Weekly status",
		outputFormat: "html",
		steps: [{ type: "trigger", label: "Schedule" }],
		problems: [],
	};

	it("accepts the draft the commands build", () => {
		expect(WorkflowDraftSchema.parse(draft)).toEqual(draft);
	});

	it("refuses a draft missing a part the chat shows", () => {
		const { problems: _problems, ...incomplete } = draft;

		expect(WorkflowDraftSchema.safeParse(incomplete).success).toBe(false);
	});
});
