/**
 * Holding a Fabric tool back until the person says yes, in the Direct chat.
 *
 * Whether a call needs the person's yes is the tool's own definition
 * (`ConfirmationPolicy`, read off the wire here and decided by
 * `confirmationRequired`, the same answer the Orchestrator reads). Without that
 * person's exact approval the call does not reach the gateway: it comes back as
 * `{ requiresConfirmation, toolName, args, draft }` for the chat to show, where
 * the draft of a create or an edit is the gateway's own dry run (it writes
 * nothing), so what the person confirms is what would be saved.
 *
 * The approval itself is `hasExactAgentToolApproval`: tool name and exact
 * arguments, bound to the user and organization. The one extension is that
 * approving a created workflow also approves publishing and running that same
 * workflow, because the draft card says so — one decision for "create it, put
 * it on its schedule and run it once".
 */

import type { FabricServiceIdentity } from "../../lib/fabric-mcp-service-headers";
import {
	callNeedsConfirmation,
	readConfirmationPolicy,
	supportsDryRun,
} from "../../lib/fabric-tool-definition";
import {
	CREATE_WORKFLOW_FOLLOW_UPS,
	isCreateFollowUpCall,
} from "../../lib/fabric-workflow-tool-definitions";
import {
	hasExactAgentToolApproval,
	withApprovedAgentTool,
} from "./agent-tool-runtime";
import type {
	FabricGateway,
	GatewayToolListing,
} from "./fabric-gateway-client";

/** The `configId` an approval of a Fabric tool is recorded under. */
export const FABRIC_PLATFORM_CONFIG_ID = "fabric-platform";

/**
 * The call the gateway receives is the call the person approved, so the key is
 * built in one place from exactly what is compared.
 */
function approvalOf(
	identity: FabricServiceIdentity,
	toolName: string,
	args: Record<string, unknown>,
) {
	return {
		userId: identity.userId,
		organizationId: identity.organizationId,
		configId: FABRIC_PLATFORM_CONFIG_ID,
		originalName: toolName,
		args,
	};
}

/** Whether a tool as the gateway lists it needs the person's yes for this call. */
export function listingNeedsConfirmation(
	listing: GatewayToolListing,
	args: Record<string, unknown>,
): boolean {
	return callNeedsConfirmation(
		{
			confirm: readConfirmationPolicy(listing._meta),
			inputSchema: listing.inputSchema,
		},
		args,
	);
}

export type ConfirmationCheck =
	/**
	 * `refund`: the call spends an allowance the person's earlier yes gave;
	 * call it when the gateway refused the call, so a retry is still covered.
	 */
	| { kind: "proceed"; refund?: () => void }
	| { kind: "answer"; result: unknown };

export interface ConfirmationGate {
	/**
	 * Whether this call may go to the gateway now, or what to answer instead:
	 * the confirmation request with its draft, or the gateway's refusal of the
	 * dry run.
	 */
	check(
		tool: GatewayToolListing,
		args: Record<string, unknown>,
		abortSignal: AbortSignal | undefined,
	): Promise<ConfirmationCheck>;
	/** Records a tool's result, so approving a create also covers the follow-ups. */
	noteResult(toolName: string, result: unknown): void;
	/** Runs `run` as the call the person approved, with exactly these arguments. */
	asApproved<T>(
		toolName: string,
		args: Record<string, unknown>,
		run: () => Promise<T>,
	): Promise<T>;
}

/** The id of the workflow a `fabric_create_workflow` result created, if it created one. */
export function createdWorkflowId(result: unknown): string | undefined {
	if (
		typeof result !== "object" ||
		result === null ||
		!("workflow" in result)
	) {
		return undefined;
	}
	const { workflow } = result;
	return typeof workflow === "object" &&
		workflow !== null &&
		"id" in workflow &&
		typeof workflow.id === "string"
		? workflow.id
		: undefined;
}

export function createConfirmationGate(
	identity: FabricServiceIdentity,
	gateway: Pick<FabricGateway, "call">,
	offers: (toolName: string) => boolean,
): ConfirmationGate {
	/**
	 * Per workflow created in this turn, the follow-ups its approval still
	 * covers: one publish and one run with no inputs, each spent when its call
	 * goes through, as the Orchestrator's one-shot grants are.
	 */
	const followUpsLeft = new Map<string, Set<string>>();

	/**
	 * Spends the follow-up allowance this call uses, if it is one, and returns
	 * how to give it back: the call it let through may still be refused (a run
	 * started before the publish went through), and the retry is covered.
	 */
	const spendFollowUp = (
		name: string,
		args: Record<string, unknown>,
	): (() => void) | undefined => {
		const workflowId =
			typeof args.workflowId === "string" ? args.workflowId : undefined;
		const left = workflowId ? followUpsLeft.get(workflowId) : undefined;
		if (
			!workflowId ||
			!left?.has(name) ||
			!isCreateFollowUpCall(name, args, workflowId)
		) {
			return undefined;
		}
		left.delete(name);
		return () => left.add(name);
	};

	/**
	 * What the person is shown: the gateway's own dry run when the tool has one,
	 * else a read of the workflow the call acts on.
	 */
	const draftOf = async (
		tool: GatewayToolListing,
		args: Record<string, unknown>,
		abortSignal: AbortSignal | undefined,
	): Promise<{ draft: unknown } | { error: unknown }> => {
		if (supportsDryRun(tool)) {
			const result = await gateway.call(
				tool.name,
				{ ...args, dryRun: true },
				abortSignal,
			);
			return typeof result === "object" &&
				result !== null &&
				"draft" in result
				? { draft: result.draft }
				: { error: result };
		}
		if (
			typeof args.workflowId !== "string" ||
			!offers("fabric_get_workflow")
		) {
			return { draft: undefined };
		}
		const workflow = await gateway.call(
			"fabric_get_workflow",
			{ workflowId: args.workflowId },
			abortSignal,
		);
		if (typeof workflow !== "object" || workflow === null) {
			return { draft: undefined };
		}
		return {
			draft: {
				kind: "workflow-action",
				workflowId: args.workflowId,
				workflowName: "name" in workflow ? workflow.name : undefined,
				description:
					"description" in workflow
						? workflow.description
						: undefined,
				status: "status" in workflow ? workflow.status : undefined,
			},
		};
	};

	return {
		async check(tool, args, abortSignal) {
			if (
				!listingNeedsConfirmation(tool, args) ||
				hasExactAgentToolApproval(approvalOf(identity, tool.name, args))
			) {
				return { kind: "proceed" };
			}
			const refund = spendFollowUp(tool.name, args);
			if (refund) {
				return { kind: "proceed", refund };
			}
			const prepared = await draftOf(tool, args, abortSignal);
			if ("error" in prepared) {
				return { kind: "answer", result: prepared.error };
			}
			return {
				kind: "answer",
				result: {
					requiresConfirmation: true,
					toolName: tool.name,
					args,
					...(prepared.draft === undefined
						? {}
						: { draft: prepared.draft }),
					message: `${tool.name} needs the user's approval before it runs. Nothing has been changed.`,
				},
			};
		},
		noteResult(toolName, result) {
			const workflowId =
				toolName === "fabric_create_workflow"
					? createdWorkflowId(result)
					: undefined;
			if (workflowId) {
				followUpsLeft.set(
					workflowId,
					new Set(CREATE_WORKFLOW_FOLLOW_UPS),
				);
			}
		},
		asApproved(toolName, args, run) {
			return withApprovedAgentTool(
				approvalOf(identity, toolName, args),
				run,
			);
		},
	};
}
