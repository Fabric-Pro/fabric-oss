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
		"Tools the page script calls via fabric.call; max 50. Reads run at once, writes ask the viewer first.",
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
			"Creates a Frame: a page of html, mermaid, markdown or json blocks. Pass the whole page in blocks. " +
			'surface "artifact" puts it on a project\'s Artifacts tab (projectId defaults to the project the user is in); "workspace" makes an organization Workspace. ' +
			"Such pages run in a sandbox with no network; their script reaches Fabric as the viewer through fabric.call(tool, args) -> Promise, fabric.openAgent(prompt) and fabric.navigate('/app/...'). " +
			"List every tool the script calls in runtimeTools. Example: " +
			"<button onclick=\"fabric.call('fabric_list_workflows',{}).then(r=>out.textContent=JSON.stringify(r))\">Refresh</button><pre id=out></pre>. " +
			"Create one only when the user asks for a page or something shareable; a chat that renders Markdown can show a ```mermaid block instead.",
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
			"Updates a Frame's title, description, blocks or runtimeTools; omitted fields are unchanged. " +
			"frameId defaults to the open Workspace. Pages use window.fabric as fabric_create_frame describes.",
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
			"Gets a Frame's blocks, surface, runtimeTools and share URL if published. frameId defaults to the open Workspace.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
			},
		},
		annotations: READ,
		scope: "frames:read",
	},
	{
		name: "fabric_list_frames",
		description:
			"Lists Frames: yours by default; surface workspace lists the organization's Workspaces you can open; surface artifact with projectId lists a project's artifacts.",
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
			"Changes who can open a Frame you own. scope PUBLIC (default) returns a link anyone can view; PRIVATE stops sharing; EMAILS_ONLY or WORKSPACE_AND_EMAILS (plus the organization) can invite emails.",
		inputSchema: {
			type: "object",
			properties: {
				frameId: { type: "string" },
				scope: { type: "string", enum: [...FRAME_SHARE_SCOPES] },
				emails: { type: "array", items: { type: "string" } },
			},
			required: ["frameId"],
		},
		annotations: WRITE,
		scope: "frames:write",
		confirm: "always",
	},
	{
		name: "fabric_create_slideshow",
		description:
			"Creates a Slideshow: each component becomes one slide. shareOnCreate=true returns a public share URL.",
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
