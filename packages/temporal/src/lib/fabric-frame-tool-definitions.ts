/**
 * What Fabric tells a client about its frame tools: names, descriptions, input
 * schemas, annotations, the scope each needs and when a call needs the person's
 * yes. A Frame is a page the agent writes; the Fabric MCP gateway serves these
 * definitions, and both chat engines take them from it, so the Orchestrator and
 * Direct chat offer the same `surface`, `runtimeTools` and
 * `sharedWithOrganization` arguments. Pure data (see
 * `fabric-workflow-tool-definitions`), importable by the web app through
 * `@repo/temporal/fabric-frame-tool-definitions`.
 *
 * Writing a page asks nothing, with one exception: a call that sets
 * `runtimeTools` gives the page the power to call Fabric tools as whoever opens
 * it, so that call asks the person first, in both engines.
 */

import { defineFabricTools } from "./fabric-tool-definition";

const BLOCKS_SCHEMA = {
	type: "array",
	items: {
		type: "object",
		properties: {
			id: { type: "string" },
			type: {
				type: "string",
				enum: ["html", "json", "mermaid", "markdown"],
			},
			title: { type: "string" },
			content: { type: "string" },
		},
		required: ["id", "type", "content"],
	},
} as const;

const SURFACE_SCHEMA = {
	type: "string",
	enum: ["artifact", "workspace"],
} as const;

const RUNTIME_TOOLS_SCHEMA = {
	type: "array",
	items: { type: "string" },
	description:
		"Declared fabric.call tools, max 50. Discover schemas with fabric_list_page_tools; use fabric_list_features(projectId), never fabric_list_project_features. Writes ask the viewer.",
} as const;

const READ = { readOnlyHint: true } as const;

const WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
} as const;

const REWRITE = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
} as const;

const ASK_WHEN_GIVEN_TOOLS = { whenArgumentPresent: "runtimeTools" } as const;

/** Who may open a frame, from the widest to the narrowest the owner can choose. */
export const FRAME_SHARE_SCOPES = [
	"PUBLIC",
	"WORKSPACE_AND_EMAILS",
	"EMAILS_ONLY",
	"PRIVATE",
] as const;

export type FrameShareScopeName = (typeof FRAME_SHARE_SCOPES)[number];

export const FABRIC_FRAME_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_create_frame",
		description:
			"Creates html/json/mermaid/markdown blocks. surface=artifact uses projectId (default current project); workspace = org Workspace. Html: a designed page (inline <style>, light/dark, tiles/cards/tables, SVG charts); no network. Scripts act as viewer: window.fabric.call(tool, args)->Promise, fabric.openAgent(prompt), fabric.navigate('/app/...'); discover via fabric_list_page_tools, declare in runtimeTools. PRIVATE: owner-only outside projects, keeps linked project members. Artifact/Workspace grant project/organization access; shareOnCreate adds an allowed public link. Create only when asked; chat renders ```mermaid directly.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string" },
				description: {
					type: "string",
					description: "Shown below the title",
				},
				blocks: { ...BLOCKS_SCHEMA, description: "Content blocks" },
				surface: SURFACE_SCHEMA,
				projectId: { type: "string" },
				runtimeTools: RUNTIME_TOOLS_SCHEMA,
				sharedWithOrganization: { type: "boolean", default: true },
				kind: {
					type: "string",
					enum: ["frame", "slideshow"],
					default: "frame",
				},
				shareOnCreate: { type: "boolean" },
			},
			required: ["title"],
		},
		annotations: WRITE,
		scope: "frames:write",
		confirm: ASK_WHEN_GIVEN_TOOLS,
	},
	{
		name: "fabric_update_frame",
		description:
			"Updates title, description, blocks or runtimeTools; omitted fields stay. frameId defaults to open Workspace. Runtime: see fabric_create_frame.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				title: { type: "string" },
				description: { type: "string" },
				blocks: { ...BLOCKS_SCHEMA, description: "Replacement blocks" },
				surface: SURFACE_SCHEMA,
				runtimeTools: RUNTIME_TOOLS_SCHEMA,
			},
		},
		annotations: REWRITE,
		scope: "frames:write",
		confirm: ASK_WHEN_GIVEN_TOOLS,
	},
	{
		name: "fabric_get_frame",
		description:
			"Reads blocks/surface/tools and published share URL. frameId defaults to open Workspace. For edits read offset:0,limit:6000; blockId defaults to first. Follow nextOffset; join only matching updatedAt chunks, restarting on change. Never edit summaries.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				blockId: { type: "string", minLength: 1 },
				offset: { type: "integer", minimum: 0 },
				limit: { type: "integer", minimum: 1, maximum: 6_000 },
			},
		},
		annotations: READ,
		scope: "frames:read",
	},
	{
		name: "fabric_list_frames",
		description:
			"Lists yours; surface=workspace lists accessible organization Workspaces; artifact+projectId lists project artifacts.",
		inputSchema: {
			type: "object",
			properties: {
				surface: SURFACE_SCHEMA,
				projectId: { type: "string" },
			},
		},
		annotations: READ,
		scope: "frames:read",
	},
	{
		name: "fabric_share_frame",
		description:
			"Changes your Frame's sharing: PUBLIC if the organization allows it, PRIVATE, EMAILS_ONLY or WORKSPACE_AND_EMAILS (last two invite emails).",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				scope: { type: "string", enum: [...FRAME_SHARE_SCOPES] },
				emails: { type: "array", items: { type: "string" } },
			},
			required: ["frameId", "scope"],
		},
		annotations: WRITE,
		scope: "frames:write",
		confirm: "always",
	},
	{
		name: "fabric_create_slideshow",
		description:
			"Creates a Slideshow: one slide per component. Private; shareOnCreate=true adds a public link if allowed.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string" },
				description: { type: "string" },
				components: {
					...BLOCKS_SCHEMA,
					description: "One entry per slide",
				},
				format: {
					type: "string",
					enum: ["html", "json", "mermaid", "markdown"],
					default: "html",
				},
				shareOnCreate: { type: "boolean" },
			},
			required: ["title"],
		},
		annotations: WRITE,
		scope: "frames:write",
	},
]);

export type FabricFrameToolName =
	(typeof FABRIC_FRAME_TOOL_DEFINITIONS)[number]["name"];
