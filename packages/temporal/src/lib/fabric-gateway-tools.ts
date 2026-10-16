/**
 * The Fabric tools the gateway serves its own agent runtime and the page host:
 * the workflow tools, the frame tools, the tools a page keeps things with and
 * the version tools, as one list. Each tool's access and confirmation policy
 * come from its own definition. The chat engines offer their model the names
 * that are not `pageOnly` (the allowlist); the gateway serves them all. Pure and
 * zod-free, so the workflow sandbox can read the names and the worker everything
 * else.
 */

import {
	FABRIC_FRAME_TOOL_DEFINITIONS,
	type FabricFrameToolName,
} from "./fabric-frame-tool-definitions";
import {
	FABRIC_FRAME_VERSION_TOOL_DEFINITIONS,
	type FabricFrameVersionToolName,
} from "./fabric-frame-version-tool-definitions";
import {
	FABRIC_PAGE_TOOL_DEFINITIONS,
	type FabricPageToolName,
} from "./fabric-page-tool-definitions";
import {
	callNeedsConfirmation,
	type FabricToolDefinition,
	toolAccess,
} from "./fabric-tool-definition";
import {
	FABRIC_WORKFLOW_TOOL_DEFINITIONS,
	type FabricWorkflowToolName,
} from "./fabric-workflow-tool-definitions";

export type FabricGatewayToolName =
	| FabricWorkflowToolName
	| FabricFrameToolName
	| FabricPageToolName
	| FabricFrameVersionToolName;

export const FABRIC_GATEWAY_TOOL_DEFINITIONS = [
	...FABRIC_WORKFLOW_TOOL_DEFINITIONS,
	...FABRIC_FRAME_TOOL_DEFINITIONS,
	...FABRIC_PAGE_TOOL_DEFINITIONS,
	...FABRIC_FRAME_VERSION_TOOL_DEFINITIONS,
];

/** The names only a page's script has a use for, as a type. */
type PageOnlyToolName = Extract<
	(typeof FABRIC_GATEWAY_TOOL_DEFINITIONS)[number],
	{ pageOnly: true }
>["name"];

export type FabricChatToolName = Exclude<
	FabricGatewayToolName,
	PageOnlyToolName
>;

/** The definitions the chat engines offer their model: everything but the page-only tools. */
export const FABRIC_CHAT_TOOL_DEFINITIONS =
	FABRIC_GATEWAY_TOOL_DEFINITIONS.filter(
		(tool): tool is typeof tool & { name: FabricChatToolName } =>
			!("pageOnly" in tool),
	);

const BY_NAME: ReadonlyMap<string, FabricToolDefinition> = new Map(
	FABRIC_GATEWAY_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
);

const CHAT_TOOL_NAMES: ReadonlySet<string> = new Set(
	FABRIC_CHAT_TOOL_DEFINITIONS.map((tool) => tool.name),
);

/** The definition of a tool the gateway serves, or undefined for any other name. */
export function fabricGatewayTool(
	name: string,
): FabricToolDefinition | undefined {
	return BY_NAME.get(name);
}

export function isFabricGatewayTool(name: string): boolean {
	return BY_NAME.has(name);
}

/** Whether the chat engines offer this tool to their model. */
export function isFabricChatTool(name: string): boolean {
	return CHAT_TOOL_NAMES.has(name);
}

/** What a call to a gateway tool asks of the person, from the tool's own definition. */
export function gatewayCallNeedsConfirmation(
	name: string,
	args: Record<string, unknown>,
): boolean {
	const tool = BY_NAME.get(name);
	return tool !== undefined && callNeedsConfirmation(tool, args);
}

/** READ or WRITE, from the tool's own definition; WRITE for a name that is no gateway tool. */
export function gatewayToolAccess(name: string): "READ" | "WRITE" {
	const tool = BY_NAME.get(name);
	return tool ? toolAccess(tool) : "WRITE";
}
