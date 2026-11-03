import { ORPCError } from "@orpc/server";
import {
	type CredentialActor,
	type CredentialMetadata,
	canManageCredential,
	isFeatureEnabled,
} from "@repo/database";
import {
	ORG_ROLE_PERMISSIONS,
	type OrgRole,
	Permissions,
} from "@repo/permissions";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

/**
 * Gate and actor for every credential-manager procedure.
 *
 * The organization passed in is the one the permission middleware already
 * authorized; this re-reads the caller's role from membership rather than
 * trusting anything the client sent. NOT_FOUND while the flag is off, as for
 * other gated surfaces: the routes behave as if they did not exist.
 */
export async function resolveCredentialActor(
	organizationId: string,
	userId: string,
): Promise<CredentialActor> {
	if (!(await isFeatureEnabled("CREDENTIAL_MANAGER", organizationId))) {
		throw new ORPCError("NOT_FOUND", {
			message: "Credential manager is not enabled",
		});
	}
	const membership = await verifyOrganizationMembership(
		organizationId,
		userId,
	);
	if (!membership) {
		throw new ORPCError("FORBIDDEN", {
			message: "Not a member of this organization",
		});
	}
	const permissions = ORG_ROLE_PERMISSIONS[membership.role as OrgRole] ?? [];
	return {
		userId,
		organizationId,
		canManageOrganizationIntegrations: permissions.includes(
			Permissions.ORG_INTEGRATIONS_MANAGE,
		),
	};
}

/** What a client may see of a credential. Never the secret or its ciphertext. */
export function toClientCredential(
	credential: CredentialMetadata,
	actor: CredentialActor,
) {
	return {
		id: credential.id,
		owner:
			credential.userId === null
				? ("organization" as const)
				: ("member" as const),
		ownedByMe: credential.userId === actor.userId,
		sharing: credential.sharing,
		provider: credential.provider,
		kind: credential.kind,
		principal: credential.principal,
		label: credential.label,
		origin: credential.origin,
		externalAccountLogin: credential.externalAccountLogin,
		scopes: credential.scopes,
		status: credential.status,
		expiresAt: credential.expiresAt,
		lastUsedAt: credential.lastUsedAt,
		lastCheckedAt: credential.lastCheckedAt,
		lastError: credential.lastError,
		createdAt: credential.createdAt,
		canManage: canManageCredential(credential, actor),
	};
}

/** Audit metadata: names, kinds and scopes only. */
export function credentialAuditMetadata(
	credential: Pick<
		CredentialMetadata,
		| "provider"
		| "kind"
		| "principal"
		| "origin"
		| "scopes"
		| "sharing"
		| "userId"
	>,
	extra: Record<string, unknown> = {},
) {
	return {
		provider: credential.provider,
		kind: credential.kind,
		principal: credential.principal,
		origin: credential.origin,
		scopes: credential.scopes,
		sharing: credential.sharing,
		owner: credential.userId === null ? "organization" : "member",
		...extra,
	};
}
