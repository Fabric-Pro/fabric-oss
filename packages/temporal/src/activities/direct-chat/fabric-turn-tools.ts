/**
 * Fabric's own tools for one direct chat turn: loading them from Fabric MCP for
 * the interactive chat. Legacy raw approval payloads are refused; supported
 * approval resumes belong to the Orchestrator. The shared gateway wrapper keeps
 * protected calls behind the verified runtime authorization boundary.
 */

import { z } from "zod";
import { directApprovalRefusal } from "../../lib/direct-approval-policy";
import { needsFabricPortalTools } from "../../lib/fabric-portal-tools";
import type {
	DirectChatWorkflowConfirmation,
	DirectChatWorkflowInput,
} from "../../types";
import type { AgentToolSource } from "../shared/agent-tool-runtime";
import { FABRIC_PLATFORM_CONFIG_ID } from "../shared/fabric-confirmation";
import {
	type FabricPlatformTools,
	loadFabricPlatformTools,
} from "../shared/fabric-platform-mcp";

/**
 * The Fabric tools this turn takes from Fabric MCP, every turn: only for the
 * interactive chat (`fabricPlatformTools`), only with tools on, and only in an
 * organization with the acting grant its web route minted — there is no
 * organization-less actor, and the gateway refuses a call nobody vouched for.
 */
export async function loadFabricToolsForTurn(
	input: DirectChatWorkflowInput,
): Promise<FabricPlatformTools | null> {
	if (!input.fabricPlatformTools || input.forceDisableTools) {
		return null;
	}
	if (!input.organizationId) {
		console.warn(
			"[DirectChat AI] No organization for this turn; Fabric tools unavailable",
		);
		return null;
	}
	if (!input.actingGrant) {
		console.warn(
			"[DirectChat AI] No acting grant for this turn; Fabric tools unavailable",
		);
		return null;
	}
	const actor = {
		userId: input.userId,
		organizationId: input.organizationId,
		actingGrant: input.actingGrant,
		projectId: input.projectId,
		workspaceId: input.workspaceId,
		surface: input.surface,
		conversationId: input.conversationId,
		sourceRunType: "direct-chat",
		sourceRunId: input.executionId,
	};
	return loadFabricPlatformTools(actor, {
		confirmationMode: "unavailable",
		...(input.fabricPortalTools
			? { portal: { offer: portalToolsRequested(input) } }
			: {}),
	});
}

/**
 * Whether this turn's words ask for something only the portal tools do. The
 * schemas of those tools are a large part of a turn's input, so a turn that
 * does not ask carries none, and one that does has them in that same turn: the
 * decision is made here, before the model is called, from the request and the
 * speaker's previous one (a "do it" after "which task?" still asks).
 */
function portalToolsRequested(input: DirectChatWorkflowInput): boolean {
	const previous = [...(input.history ?? [])]
		.reverse()
		.find((entry) => entry.role === "user");
	return needsFabricPortalTools(
		input.message,
		typeof previous?.content === "string" ? previous.content : undefined,
	);
}

/**
 * Where each Fabric MCP tool of this turn comes from, for a runtime that
 * decides what a tool may do from its source (Parlume's action gate). The
 * source is the `configId` Fabric's own approval check records an approval
 * under, so a runtime that approves a call as this source approves it for the
 * gate that would otherwise ask the person again.
 */
export function fabricToolSources(
	platform:
		| (Pick<FabricPlatformTools, "tools"> &
				Partial<Pick<FabricPlatformTools, "access">>)
		| null,
): Record<string, AgentToolSource> {
	return Object.fromEntries(
		Object.keys(platform?.tools ?? {}).map((name) => [
			name,
			{
				configId: FABRIC_PLATFORM_CONFIG_ID,
				originalName: name,
				...(platform?.access?.[name]
					? { access: platform.access[name] }
					: {}),
			},
		]),
	);
}

const ToolConfirmationOutput = z.object({
	requiresConfirmation: z.literal(true),
	message: z.string().optional(),
	toolName: z.string(),
	args: z.record(z.string(), z.unknown()),
	draft: z.unknown().optional(),
});

const WorkflowConfirmationOutput = z.object({
	requiresConfirmation: z.literal(true),
	message: z.string().optional(),
	workflowId: z.string(),
	workflowName: z.string().optional(),
	description: z.string().nullish(),
});

/**
 * The confirmation a tool result asks the chat to show, or undefined for a
 * result that asks for none. Any tool that needs the person's yes answers with
 * `requiresConfirmation: true`; the chat card is drawn from what it carries.
 * The in-process workflow tools that non-interactive callers keep answer with
 * the workflow alone.
 */
export function confirmationFromToolOutput(
	output: unknown,
): DirectChatWorkflowConfirmation | undefined {
	const tool = ToolConfirmationOutput.safeParse(output);
	if (tool.success) {
		const { requiresConfirmation: _, message, ...rest } = tool.data;
		return {
			...rest,
			message:
				message ??
				`${rest.toolName} needs your approval before it runs.`,
		};
	}
	const workflow = WorkflowConfirmationOutput.safeParse(output);
	if (workflow.success) {
		const {
			requiresConfirmation: _,
			message,
			description,
			...rest
		} = workflow.data;
		return {
			...rest,
			description: description ?? undefined,
			message:
				message ?? "This action needs your approval before it runs.",
		};
	}
	return undefined;
}

/** Defense in depth for callers outside the activity entry point; never dispatch raw approvals. */
export async function runApprovedAction(
	input: DirectChatWorkflowInput,
	_platform: Pick<FabricPlatformTools, "runApproved"> | null,
): Promise<string | null> {
	return directApprovalRefusal(input.approvedToolCall)?.message ?? null;
}
