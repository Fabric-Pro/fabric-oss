/**
 * What Fabric tells a client about the tools that go back and sideways on a
 * page: its saved versions, restoring one, and forking it. Every edit of a page
 * is saved as a version, so a change is never final.
 *
 * Restoring brings the old content back and keeps the tools the page declares
 * now, so an old version never widens what the page may call; it still always
 * asks, because it replaces what people see. A fork copies the page's content under a
 * new owner and carries no page data; it carries the page's tools only when the
 * caller passes them, which asks like any page given tools. Pure data (see
 * `fabric-workflow-tool-definitions`), importable by the web app through
 * `@repo/temporal/fabric-frame-version-tool-definitions`.
 */

import { defineFabricTools, TOOL_ANNOTATIONS } from "./fabric-tool-definition";

const FRAME_ID = { frameId: { type: "string" } } as const;

export const FABRIC_FRAME_VERSION_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_list_frame_versions",
		description:
			"Lists a page's saved versions, newest first, without their content. frameId defaults to the open Workspace.",
		inputSchema: {
			type: "object",
			properties: { ...FRAME_ID, limit: { type: "number" } },
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "frames:read",
	},
	{
		name: "fabric_restore_frame_version",
		description:
			"Puts a page back to one of its saved versions. The current content is kept as a version, so this can be undone. Always asks.",
		inputSchema: {
			type: "object",
			properties: { ...FRAME_ID, version: { type: "number" } },
			required: ["version"],
		},
		annotations: TOOL_ANNOTATIONS.rewrite,
		scope: "frames:write",
		confirm: "always",
	},
	{
		name: "fabric_duplicate_frame",
		description:
			"Forks a page you can open into a copy of your own, keeping its surface and project. Page data is not copied. The page's tools are copied only when you pass runtimeTools.",
		inputSchema: {
			type: "object",
			properties: {
				...FRAME_ID,
				title: { type: "string" },
				runtimeTools: { type: "array", items: { type: "string" } },
			},
		},
		annotations: TOOL_ANNOTATIONS.write,
		scope: "frames:write",
		confirm: { whenArgumentPresent: "runtimeTools" },
	},
]);

export type FabricFrameVersionToolName =
	(typeof FABRIC_FRAME_VERSION_TOOL_DEFINITIONS)[number]["name"];
