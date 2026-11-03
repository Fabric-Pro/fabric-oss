/**
 * Who may see, use and manage an outbound credential
 * (docs/adr/026-outbound-credentials-are-one-entity.md §4.5).
 *
 * Pure so the API, the resolver and tests share one rule. RLS already keeps a
 * credential inside its organization; these rules decide among the members of
 * that organization.
 *
 * - A member's own credential: they use and manage it.
 * - A member's credential shared with the organization: every member may use
 *   it; only its owner manages it.
 * - An organization-owned credential: every member may use it; members whose
 *   role may manage integrations manage it.
 */

export type CredentialAccessRow = {
	organizationId: string;
	userId: string | null;
	sharing: "PRIVATE" | "ORGANIZATION";
	status: "ACTIVE" | "EXPIRING" | "NEEDS_REAUTH" | "REVOKED" | "ERROR";
};

export type CredentialActor = {
	userId: string;
	organizationId: string;
	/** The actor's role may manage the organization's integrations. */
	canManageOrganizationIntegrations: boolean;
};

function sameOrganization(row: CredentialAccessRow, actor: CredentialActor) {
	return row.organizationId === actor.organizationId;
}

/** Visible in the actor's lists and pickers. */
export function canSeeCredential(
	row: CredentialAccessRow,
	actor: CredentialActor,
): boolean {
	if (!sameOrganization(row, actor)) {
		return false;
	}
	if (row.userId === null) {
		return true;
	}
	return row.userId === actor.userId || row.sharing === "ORGANIZATION";
}

/** May be bound to something the actor connects. Revoked rows never are. */
export function canUseCredential(
	row: CredentialAccessRow,
	actor: CredentialActor,
): boolean {
	return row.status !== "REVOKED" && canSeeCredential(row, actor);
}

/** May rename, replace the secret, change sharing or delete. */
export function canManageCredential(
	row: CredentialAccessRow,
	actor: CredentialActor,
): boolean {
	if (!sameOrganization(row, actor)) {
		return false;
	}
	if (row.userId === null) {
		return actor.canManageOrganizationIntegrations;
	}
	return row.userId === actor.userId;
}
