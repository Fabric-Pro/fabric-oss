import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentTaskToFramePresetSchema } from "../agentic-workflow-preset";
import { FABRIC_FRAME_TOOL_DEFINITIONS } from "../fabric-frame-tool-definitions";
import { FABRIC_FRAME_VERSION_TOOL_DEFINITIONS } from "../fabric-frame-version-tool-definitions";
import {
	FABRIC_CHAT_TOOL_DEFINITIONS,
	FABRIC_GATEWAY_TOOL_DEFINITIONS,
	gatewayCallNeedsConfirmation,
	gatewayToolAccess,
	isFabricChatTool,
	isFabricGatewayTool,
} from "../fabric-gateway-tools";
import { FABRIC_PAGE_TOOL_DEFINITIONS } from "../fabric-page-tool-definitions";
import {
	callNeedsConfirmation,
	confirmationMeta,
	type FabricToolDefinition,
	readConfirmationPolicy,
	toolAccess,
} from "../fabric-tool-definition";
import { FABRIC_WORKFLOW_TOOL_DEFINITIONS } from "../fabric-workflow-tool-definitions";

const GATEWAY_TOOLS: readonly FabricToolDefinition[] =
	FABRIC_GATEWAY_TOOL_DEFINITIONS;
const FRAME_TOOLS: readonly FabricToolDefinition[] =
	FABRIC_FRAME_TOOL_DEFINITIONS;
const WORKFLOW_TOOLS: readonly FabricToolDefinition[] =
	FABRIC_WORKFLOW_TOOL_DEFINITIONS;

type JsonSchemaNode = {
	type?: string;
	items?: { type?: string };
	properties?: Record<string, JsonSchemaNode>;
	required?: string[];
};

function presetSchemaOf(name: string): JsonSchemaNode {
	const tool = WORKFLOW_TOOLS.find((definition) => definition.name === name);
	const preset = (tool?.inputSchema as JsonSchemaNode | undefined)?.properties
		?.preset;
	if (!preset) {
		throw new Error(`${name} declares no preset`);
	}
	return preset;
}

/**
 * The `preset` the model sees is written by hand because the definitions are
 * imported by the workflow bundle, which keeps zod out. What keeps it honest is
 * this: every property it declares is a key of `AgentTaskToFramePresetSchema`
 * (or the one name the model uses for a key), with the type the schema reads,
 * and nothing it requires is something the schema defaults.
 */
describe("the preset a model is shown", () => {
	const zodPreset = z.toJSONSchema(AgentTaskToFramePresetSchema, {
		io: "input",
	}) as JsonSchemaNode;
	const ALIASES: Record<string, string> = { mcpServers: "mcpConfigIds" };

	it.each(["fabric_create_workflow"])(
		"%s declares only keys of the preset schema, with the types it reads",
		(name) => {
			const shown = presetSchemaOf(name);

			for (const [key, declared] of Object.entries(
				shown.properties ?? {},
			)) {
				const schemaKey = ALIASES[key] ?? key;
				const actual = zodPreset.properties?.[schemaKey];
				expect(
					actual,
					`${key} is not a key of the preset schema`,
				).toBeDefined();
				expect(declared.type, key).toBe(actual?.type);
				expect(declared.items?.type, key).toBe(actual?.items?.type);
			}
		},
	);

	it("requires only what the preset schema requires", () => {
		const shown = presetSchemaOf("fabric_create_workflow");

		for (const key of shown.required ?? []) {
			expect(zodPreset.required, key).toContain(ALIASES[key] ?? key);
		}
	});

	it("shows the keys a person has to give: name, schedule, prompt", () => {
		const shown = presetSchemaOf("fabric_create_workflow");

		expect(Object.keys(shown.properties ?? {})).toEqual(
			expect.arrayContaining(["name", "cron", "prompt", "outputTitle"]),
		);
		expect(shown.required).toEqual(["name", "cron", "prompt"]);
	});
});

describe("Fabric's tool definitions", () => {
	it("name every tool once, with the scope it needs", () => {
		const names = GATEWAY_TOOLS.map((tool) => tool.name);

		expect(new Set(names).size).toBe(names.length);
		expect(
			GATEWAY_TOOLS.filter(
				(tool) =>
					!/^(workflows|frames):(read|write|run)$/.test(tool.scope),
			).map((tool) => [tool.name, tool.scope]),
		).toEqual([["fabric_page_read_connected", "mcp:read"]]);
	});

	it("keep the tools only a page's script has a use for out of what the chat engines offer", () => {
		const pageOnly = GATEWAY_TOOLS.filter((tool) => tool.pageOnly === true);

		expect(pageOnly.map((tool) => tool.name).sort()).toEqual([
			"fabric_page_ask",
			"fabric_page_read_connected",
		]);
		const chat = FABRIC_CHAT_TOOL_DEFINITIONS.map((tool) => tool.name);
		for (const tool of pageOnly) {
			expect(chat, tool.name).not.toContain(tool.name);
			expect(isFabricChatTool(tool.name), tool.name).toBe(false);
			expect(isFabricGatewayTool(tool.name), tool.name).toBe(true);
		}
		expect(chat).toContain("fabric_page_data_set");
		expect(chat).toContain("fabric_get_page_viewer");
		expect(chat).toHaveLength(GATEWAY_TOOLS.length - pageOnly.length);
	});

	it("ask for every call of every workflow write", () => {
		const writes = WORKFLOW_TOOLS.filter(
			(tool) => toolAccess(tool) === "WRITE",
		);

		expect(writes.map((tool) => tool.name).sort()).toEqual([
			"fabric_create_workflow",
			"fabric_execute_workflow",
			"fabric_pause_workflow",
			"fabric_publish_workflow",
			"fabric_resume_workflow",
			"fabric_unpublish_workflow",
			"fabric_update_workflow",
		]);
		expect(writes.every((tool) => tool.confirm === "always")).toBe(true);
	});

	it("ask about a frame only when it is given page tools or shared, and about no other frame write", () => {
		const asking = FRAME_TOOLS.filter((tool) => tool.confirm !== undefined);

		expect(asking.map((tool) => [tool.name, tool.confirm])).toEqual([
			["fabric_create_frame", { whenArgumentPresent: "runtimeTools" }],
			["fabric_update_frame", { whenArgumentPresent: "runtimeTools" }],
			["fabric_share_frame", "always"],
		]);
	});

	it("ask before a version is restored, and when a fork is given page tools, and never on a list", () => {
		const versionTools: readonly FabricToolDefinition[] =
			FABRIC_FRAME_VERSION_TOOL_DEFINITIONS;
		const policy = (name: string) =>
			versionTools.find((tool) => tool.name === name)?.confirm;

		expect(policy("fabric_restore_frame_version")).toBe("always");
		expect(policy("fabric_duplicate_frame")).toEqual({
			whenArgumentPresent: "runtimeTools",
		});
		expect(policy("fabric_list_frame_versions")).toBeUndefined();
		expect(
			gatewayCallNeedsConfirmation("fabric_duplicate_frame", {
				frameId: "frame-1",
			}),
		).toBe(false);
		expect(
			gatewayCallNeedsConfirmation("fabric_duplicate_frame", {
				frameId: "frame-1",
				runtimeTools: ["fabric_list_frames"],
			}),
		).toBe(true);
	});

	it("ask before a page's data or files are deleted, and let everything else the page keeps be written without asking", () => {
		const pageTools: readonly FabricToolDefinition[] =
			FABRIC_PAGE_TOOL_DEFINITIONS;
		const asking = pageTools
			.filter((tool) => tool.confirm !== undefined)
			.map((tool) => [tool.name, tool.confirm]);

		expect(asking).toEqual([
			["fabric_page_data_delete", "always"],
			["fabric_page_file_delete", "always"],
		]);
	});

	it("ask on every call to a page's delete tools, whatever the arguments", () => {
		const pageTools: readonly FabricToolDefinition[] =
			FABRIC_PAGE_TOOL_DEFINITIONS;
		for (const name of [
			"fabric_page_data_delete",
			"fabric_page_file_delete",
		]) {
			const tool = pageTools.find((candidate) => candidate.name === name);
			expect(tool && callNeedsConfirmation(tool, {}), name).toBe(true);
		}
	});

	it("never ask about a read", () => {
		for (const tool of GATEWAY_TOOLS) {
			if (toolAccess(tool) === "READ") {
				expect(tool.confirm, tool.name).toBeUndefined();
			}
		}
	});

	it("serve the policy on the wire exactly as a client reads it back", () => {
		for (const tool of GATEWAY_TOOLS) {
			expect(
				readConfirmationPolicy(confirmationMeta(tool)),
				tool.name,
			).toEqual(tool.confirm);
		}
	});

	it("tell the sandbox what each gateway tool reads or writes without loading a schema", () => {
		expect(gatewayToolAccess("fabric_list_workflows")).toBe("READ");
		expect(gatewayToolAccess("fabric_create_frame")).toBe("WRITE");
		expect(gatewayToolAccess("fabric_unknown")).toBe("WRITE");
	});
});

describe("callNeedsConfirmation", () => {
	const WITH_DRY_RUN = {
		confirm: "always",
		inputSchema: { properties: { dryRun: { type: "boolean" } } },
	} as const;

	it("takes a policy to mean what it says", () => {
		expect(callNeedsConfirmation({ confirm: "always" }, {})).toBe(true);
		expect(callNeedsConfirmation({}, {})).toBe(false);
		const gated = { confirm: { whenArgumentPresent: "runtimeTools" } };
		expect(callNeedsConfirmation(gated, {})).toBe(false);
		expect(callNeedsConfirmation(gated, { runtimeTools: [] })).toBe(false);
		expect(callNeedsConfirmation(gated, { runtimeTools: "" })).toBe(false);
		expect(callNeedsConfirmation(gated, { runtimeTools: ["x"] })).toBe(
			true,
		);
		expect(callNeedsConfirmation(gated, { runtimeTools: { a: 1 } })).toBe(
			true,
		);
	});

	it("lets a dryRun through on a tool that takes one, because it writes nothing", () => {
		expect(callNeedsConfirmation(WITH_DRY_RUN, { dryRun: true })).toBe(
			false,
		);
		expect(callNeedsConfirmation(WITH_DRY_RUN, { dryRun: false })).toBe(
			true,
		);
		expect(callNeedsConfirmation(WITH_DRY_RUN, {})).toBe(true);
	});

	it("does not take dryRun on trust for a tool that has no draft", () => {
		expect(
			callNeedsConfirmation({ confirm: "always" }, { dryRun: true }),
		).toBe(true);
		expect(
			gatewayCallNeedsConfirmation("fabric_execute_workflow", {
				dryRun: true,
			}),
		).toBe(true);
	});
});

describe("readConfirmationPolicy", () => {
	it("reads no policy where the tool names none", () => {
		expect(readConfirmationPolicy(undefined)).toBeUndefined();
		expect(readConfirmationPolicy({})).toBeUndefined();
		expect(
			readConfirmationPolicy({ "fabric/confirm": false }),
		).toBeUndefined();
	});

	it("reads a shape it does not know as every call, never as none", () => {
		expect(readConfirmationPolicy({ "fabric/confirm": true })).toBe(
			"always",
		);
		expect(readConfirmationPolicy({ "fabric/confirm": "yes" })).toBe(
			"always",
		);
		expect(
			readConfirmationPolicy({ "fabric/confirm": { someNewShape: 1 } }),
		).toBe("always");
		expect(
			readConfirmationPolicy({
				"fabric/confirm": { whenArgumentPresent: "" },
			}),
		).toBe("always");
	});

	it("reads a named argument", () => {
		expect(
			readConfirmationPolicy({
				"fabric/confirm": { whenArgumentPresent: "runtimeTools" },
			}),
		).toEqual({ whenArgumentPresent: "runtimeTools" });
	});
});
