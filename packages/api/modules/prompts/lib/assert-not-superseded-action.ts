import { ORPCError } from "@orpc/client";
import { isProposalArtifactEnabledForOrganization } from "@repo/database";
import {
	isSupersededPromptAction,
	PROPOSAL_ACTION_SUPERSEDED,
} from "@repo/utils/prompt-action-catalog";

/**
 * No new organization or project default at a prompt action the Proposal
 * artifact supersedes (Fizzy #2946).
 *
 * While an organization has the Proposal artifact on, its Proposals are
 * written from Client proposal (Main), so a default at the legacy Proposal
 * action would never run. Refusing the write keeps an admin from choosing a
 * prompt nobody will read. Shared by `bindings.set`, `bindings.setMany` and
 * nomination create/approve, so no route to the same binding is left open.
 *
 * Only ORG scope is refused (with or without a project; the PROJECT tier is
 * ORG narrowed to one project). USER and SYSTEM stay open: a personal binding
 * carries no organization and follows its owner into organizations whose
 * gate is off, and SYSTEM is the fallback those organizations use. Clearing,
 * and declining a nomination, never come here, so nothing saved at the slot
 * can be stranded. Nothing is deleted: switching the gate off makes existing
 * bindings live again.
 *
 * Call it AFTER the caller's tier authority (org admin for ORG) and the
 * project-to-organization check, so a caller without that authority learns
 * nothing that depends on the gate, and `organizationId` is the organization
 * the binding is written in. Call it BEFORE any write. One refused target
 * refuses the whole request.
 */
export async function assertNotSupersededAction(
	scope: "SYSTEM" | "ORG" | "USER",
	targets: readonly { targetKey: string; documentType: string }[],
	organizationId: string | null | undefined,
): Promise<void> {
	if (scope !== "ORG") {
		return;
	}
	// The pure rule first, read as if the gate were on: the flag is looked up
	// only when a target could be superseded at all.
	const touchesSupersededAction = targets.some((target) =>
		isSupersededPromptAction(target.targetKey, target.documentType, true),
	);
	if (!touchesSupersededAction) {
		return;
	}
	if (!(await isProposalArtifactEnabledForOrganization(organizationId))) {
		return;
	}
	throw new ORPCError("BAD_REQUEST", {
		message:
			"Proposals are written from Client proposal (Main) while the Proposal artifact is on, so a new organization or project default cannot be set at this action. Bind the prompt to Client proposal (Main) instead.",
		data: { code: PROPOSAL_ACTION_SUPERSEDED },
	});
}
