/**
 * The Agent Task and Publish Frame nodes are authored on the canvas and run by
 * the worker, and the two sides meet in one contract (the node config schemas
 * and the node labels `{{Agent Task.html}}` interpolates). These keep the
 * palette on the right side of it, and the trigger's time zone options inside
 * what the schedule will accept.
 */

import {
	AGENT_TASK_NODE_LABEL,
	AGENT_TASK_NODE_TYPE,
	AgentTaskNodeConfigSchema,
	PUBLISH_FRAME_NODE_LABEL,
	PUBLISH_FRAME_NODE_TYPE,
	PublishFrameNodeConfigSchema,
} from "@repo/temporal/agentic-workflow-preset";
import { isValidScheduleTimeZone } from "@repo/temporal/workflow-builder-schedule";
import { adoStoryReviewConfigFieldsSchema } from "@repo/temporal/ado-story-review-config";
import { ADO_STORY_REVIEW_NODE_TYPE } from "@repo/temporal/workflow-node-types";
import { describe, expect, it } from "vitest";

import "../plugins";
import { getNodeDefinition, nodeCategories } from "../node-definitions";
import { listTimeZoneOptions } from "../time-zones";
import { findActionById } from "../plugins";

describe("Agent Task node", () => {
	const definition = getNodeDefinition(AGENT_TASK_NODE_TYPE);

	it("is offered in the AI group", () => {
		expect(definition?.category).toBe("AI");
		expect(
			nodeCategories
				.find((category) => category.id === "AI")
				?.nodes.map((node) => node.type),
		).toContain(AGENT_TASK_NODE_TYPE);
	});

	it("is labelled the way upstream references expect", () => {
		expect(definition?.label).toBe(AGENT_TASK_NODE_LABEL);
		expect(definition?.defaultData.label).toBe(AGENT_TASK_NODE_LABEL);
	});

	it("starts from a config the worker accepts once a task is written", () => {
		const parsed = AgentTaskNodeConfigSchema.safeParse({
			...definition?.defaultData.config,
			prompt: "Summarise the open work items.",
		});

		expect(parsed.success).toBe(true);
	});

	it("only edits fields the worker reads", () => {
		const known = Object.keys(AgentTaskNodeConfigSchema.shape);
		const offered = (definition?.configFields ?? []).map((f) => f.name);

		expect(offered.filter((name) => !known.includes(name))).toEqual([]);
	});

	it("lets the author choose MCP servers with the shared picker", () => {
		expect(
			definition?.configFields?.find((f) => f.name === "mcpConfigIds")
				?.type,
		).toBe("mcp-selector");
	});

	it("offers the worker's optional model choice through the canonical picker", () => {
		expect(
			definition?.configFields?.find((field) => field.name === "modelId")
				?.type,
		).toBe("ai-model-selector");
	});

	it("lets the author grant the agent Fabric data and tools, which it has none of by default", () => {
		const field = definition?.configFields?.find(
			(f) => f.name === "builtInToolNames",
		);

		expect(field?.type).toBe("capability-selector");
		expect(field?.label).toBe("Fabric data and tools the agent may use");
		expect(definition?.defaultData.config).toMatchObject({
			builtInToolNames: [],
		});
	});
});

describe("ADO story review plugin action", () => {
	it("derives its node name from the MCP plugin and binds the matching executor", () => {
		const action = findActionById(ADO_STORY_REVIEW_NODE_TYPE);
		expect(action).toMatchObject({
			slug: "review-ado-stories",
			nodeType: ADO_STORY_REVIEW_NODE_TYPE,
			stepImportPath: ADO_STORY_REVIEW_NODE_TYPE,
			stepFunction: "executeAdoStoryReviewStep",
		});
		expect(action?.configComponent).toBeDefined();
		expect(getNodeDefinition(ADO_STORY_REVIEW_NODE_TYPE)?.category).toBe(
			"AI",
		);
	});

	it("exposes exactly the canonical configurable review fields", () => {
		const action = findActionById(ADO_STORY_REVIEW_NODE_TYPE);
		expect(action?.configFields.map((field) => field.key).sort()).toEqual(
			Object.keys(adoStoryReviewConfigFieldsSchema.shape).sort(),
		);
		expect(
			action?.configFields.find((field) => field.key === "model")?.type,
		).toBe("ai-model-selector");
		expect(
			action?.configFields.find(
				(field) => field.key === "agentInstructionsInstanceId",
			)?.label,
		).toContain("instructions and model only");
	});
});

describe("Publish Frame node", () => {
	const definition = getNodeDefinition(PUBLISH_FRAME_NODE_TYPE);

	it("is offered in the AI group", () => {
		expect(definition?.category).toBe("AI");
	});

	it("publishes the Agent Task's html by default", () => {
		expect(definition?.defaultData.config).toMatchObject({
			content: `{{${AGENT_TASK_NODE_LABEL}.html}}`,
		});
		expect(definition?.defaultData.label).toBe(PUBLISH_FRAME_NODE_LABEL);
	});

	it("starts from a config the worker accepts once a title is written", () => {
		const parsed = PublishFrameNodeConfigSchema.safeParse({
			...definition?.defaultData.config,
			title: "Weekly status",
		});

		expect(parsed.success).toBe(true);
	});

	it("only edits fields the worker reads", () => {
		const known = Object.keys(PublishFrameNodeConfigSchema.shape);
		const offered = (definition?.configFields ?? []).map((f) => f.name);

		expect(offered.filter((name) => !known.includes(name))).toEqual([]);
	});
});

describe("trigger time zone", () => {
	const field = getNodeDefinition("trigger")?.configFields?.find(
		(f) => f.name === "scheduleTimezone",
	);

	it("is a select that starts at UTC", () => {
		expect(field?.type).toBe("select");
		expect(field?.options?.[0]).toEqual({ value: "UTC", label: "UTC" });
	});

	it("offers well-known zones", () => {
		const values = (field?.options ?? []).map((option) => option.value);

		expect(values).toContain("Europe/Berlin");
		expect(values).toContain("America/New_York");
	});

	it("offers only zones the schedule accepts", () => {
		const rejected = listTimeZoneOptions()
			.map((option) => option.value)
			.filter((zone) => !isValidScheduleTimeZone(zone));

		expect(rejected).toEqual([]);
	});

	it("offers each zone once", () => {
		const values = listTimeZoneOptions().map((option) => option.value);

		expect(new Set(values).size).toBe(values.length);
	});
});
