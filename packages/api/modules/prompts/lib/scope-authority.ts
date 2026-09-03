/**
 * The per-scope authority a prompt deletion requires.
 *
 * Extracted verbatim from `procedures/delete.ts`, where it lived inline, so the
 * deletion and the platform-wide impact read that precedes it are gated by ONE
 * rule rather than two that can drift. The impact read is un-scoped across every
 * tenant; the only thing that makes it legitimate is that its caller could carry
 * out the deletion, and the only way to keep that true is to ask the same
 * function.
 *
 * The branch ORDER is part of the contract: `apps/web`'s client-side predicate
 * mirrors these branches so a reviewer can diff them by eye. Keep them aligned.
 *
 * Throws on refusal and returns nothing on success, so a caller cannot forget
 * to check a boolean.
 */

import { ORPCError } from "@orpc/server";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

/** The fields of a prompt row this decision reads — nothing else is consulted. */
type PromptScopeSubject = {
	scope: string;
	organizationId?: string | null;
	userId?: string | null;
};

/**
 * The acting user. `role` is the GLOBAL (platform) role from the user record —
 * a different field from an organization member's role, and the two are never
 * interchangeable here.
 */
type PromptDeleteActor = {
	id: string;
	role?: string | null;
};

export async function assertPromptDeleteAuthority(
	prompt: PromptScopeSubject,
	user: PromptDeleteActor,
): Promise<void> {
	if (prompt.scope === "SYSTEM") {
		// Only admins can delete system prompts
		if (user.role !== "admin") {
			throw new ORPCError("FORBIDDEN", {
				message: "Only administrators can delete system prompts",
			});
		}
		return;
	}

	if (prompt.scope === "ORG") {
		// Verify organization membership and admin role
		if (!prompt.organizationId) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Organization prompt missing organization ID",
			});
		}

		const membership = await verifyOrganizationMembership(
			prompt.organizationId,
			user.id,
		);

		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			});
		}

		if (membership.role !== "admin" && membership.role !== "owner") {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only organization admins can delete organization prompts",
			});
		}
		return;
	}

	if (prompt.scope === "USER") {
		// Only the owner can delete user prompts
		if (prompt.userId !== user.id) {
			throw new ORPCError("FORBIDDEN", {
				message: "You can only delete your own prompts",
			});
		}
		return;
	}

	// A scope no branch above claimed. This function signals refusal by
	// throwing, so an if/return chain that simply runs off the end AUTHORIZES —
	// the caller reads "returned normally" as "allowed" and deletes. Unreachable
	// while `scope` is a Postgres enum of exactly these three, but `apps/web`'s
	// mirror of these branches refuses an unrecognised scope explicitly, and the
	// two must not be allowed to diverge in the direction where the server is
	// the permissive one. If the enum ever gains a member, deleting a prompt in
	// the new scope has to wait for someone to write its rule — not be granted
	// by omission, silently, on the module's most destructive path.
	throw new ORPCError("FORBIDDEN", {
		message: "This prompt's scope has no deletion rule",
	});
}
