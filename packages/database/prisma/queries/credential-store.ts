/**
 * Outbound credentials (ADR-026).
 *
 * The secret column is written here and read here only, through
 * `readCredentialSecret`. Every other read selects `CREDENTIAL_METADATA_SELECT`,
 * which leaves it out, so a list or picker can never carry ciphertext to a
 * client by accident.
 *
 * Callers authorize first (`lib/credential-access.ts`); these functions take an
 * explicit `organizationId` and never widen past it.
 */

import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { db, type Prisma } from "../client";
import type {
	CredentialKind,
	CredentialPrincipal,
	CredentialProvider,
	CredentialSharing,
	CredentialStatus,
} from "../zod";

export const CREDENTIAL_METADATA_SELECT = {
	id: true,
	organizationId: true,
	userId: true,
	sharing: true,
	provider: true,
	kind: true,
	principal: true,
	label: true,
	origin: true,
	externalAccountId: true,
	externalAccountLogin: true,
	installationId: true,
	installation: true,
	scopes: true,
	generation: true,
	status: true,
	expiresAt: true,
	refreshRejectedAt: true,
	lastCheckedAt: true,
	lastUsedAt: true,
	lastError: true,
	createdByUserId: true,
	createdAt: true,
	updatedAt: true,
} as const satisfies Prisma.CredentialSelect;

export type CredentialMetadata = Prisma.CredentialGetPayload<{
	select: typeof CREDENTIAL_METADATA_SELECT;
}>;

/**
 * The decrypted secret. Shape depends on `kind`; every field is optional so a
 * provider adapter validates what it needs.
 */
export type CredentialSecret = {
	accessToken?: string;
	refreshToken?: string;
	idToken?: string;
	token?: string;
	username?: string;
	clientId?: string;
	clientSecret?: string;
	/** The OAuth client that issued a grant; a refresh uses exactly this one. */
	issuer?: string;
	[key: string]: unknown;
};

function encryptSecret(secret: CredentialSecret | null | undefined) {
	return secret ? encryptApiKey(JSON.stringify(secret)) : null;
}

type Client = Prisma.TransactionClient | typeof db;

/**
 * Credentials the actor may see in one organization: their own, the ones
 * other members share, and the organization's. The organization is fixed;
 * the OR below chooses among its members' rows and is not a tenant arm.
 */
export async function listVisibleCredentials(input: {
	organizationId: string;
	userId: string;
	provider?: CredentialProvider;
	includeRevoked?: boolean;
}): Promise<CredentialMetadata[]> {
	return db.credential.findMany({
		where: {
			organizationId: input.organizationId,
			...(input.provider ? { provider: input.provider } : {}),
			...(input.includeRevoked ? {} : { status: { not: "REVOKED" } }),
			OR: [
				{ userId: input.userId },
				{ userId: null },
				{ sharing: "ORGANIZATION" },
			],
		},
		select: CREDENTIAL_METADATA_SELECT,
		orderBy: [{ provider: "asc" }, { label: "asc" }],
	});
}

/**
 * The caller's own saved token for one provider account, if any: the match a
 * pasted token is offered instead of saving a duplicate. Only the owner's own
 * non-revoked `PAT` rows in this organization qualify, so a credential of
 * another member or another organization never answers.
 */
export async function findOwnPatCredentialForAccount(input: {
	organizationId: string;
	userId: string;
	provider: CredentialProvider;
	externalAccountId: string;
}): Promise<CredentialMetadata | null> {
	return db.credential.findFirst({
		where: {
			organizationId: input.organizationId,
			userId: input.userId,
			provider: input.provider,
			kind: "PAT",
			externalAccountId: input.externalAccountId,
			status: { not: "REVOKED" },
		},
		select: CREDENTIAL_METADATA_SELECT,
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Each member's GitHub login, from their own non-revoked GitHub credential in
 * this organization (`externalAccountLogin`). A member's credential in another
 * organization, an organization-owned credential and a credential that names
 * no account are never read. Selects the login only, never a secret. When a
 * member holds several, the most recently updated one wins.
 */
export async function listMemberGitHubLogins(input: {
	organizationId: string;
	userIds: readonly string[];
}): Promise<Map<string, string>> {
	if (input.userIds.length === 0) {
		return new Map();
	}
	const rows = await db.credential.findMany({
		where: {
			organizationId: input.organizationId,
			userId: { in: [...input.userIds] },
			provider: "GITHUB",
			status: { not: "REVOKED" },
			externalAccountLogin: { not: null },
		},
		select: { userId: true, externalAccountLogin: true },
		orderBy: { updatedAt: "desc" },
	});
	const logins = new Map<string, string>();
	for (const row of rows) {
		if (row.userId && row.externalAccountLogin && !logins.has(row.userId)) {
			logins.set(row.userId, row.externalAccountLogin);
		}
	}
	return logins;
}

/** A member's GitHub credential as the account backfill sees it. */
export type MemberGitHubCredential = {
	id: string;
	userId: string;
	kind: CredentialKind;
	origin: string;
	generation: number;
	externalAccountLogin: string | null;
};

/**
 * Every member's own non-revoked GitHub credentials in this organization,
 * newest first: whether a member is connected at all, and which credentials
 * still name no account. Organization-owned rows and app installations are
 * left out. Selects no secret.
 */
export async function listMemberGitHubCredentials(input: {
	organizationId: string;
	userIds: readonly string[];
}): Promise<MemberGitHubCredential[]> {
	if (input.userIds.length === 0) {
		return [];
	}
	const rows = await db.credential.findMany({
		where: {
			organizationId: input.organizationId,
			userId: { in: [...input.userIds] },
			provider: "GITHUB",
			kind: { not: "APP_INSTALLATION" },
			status: { not: "REVOKED" },
		},
		select: {
			id: true,
			userId: true,
			kind: true,
			origin: true,
			generation: true,
			externalAccountLogin: true,
		},
		orderBy: { updatedAt: "desc" },
	});
	return rows.flatMap((row) =>
		row.userId ? [{ ...row, userId: row.userId }] : [],
	);
}

/**
 * Records the provider account a credential acts as, read from the provider
 * after it was saved without one. Narrow and fenced: it writes only the
 * account fields (and scopes when given), never the secret or the
 * generation, and only while the row is still the generation the token was
 * read from and still names no account. Answers false when the row moved on,
 * or when the account already has a grant for this owner
 * (`credential_account_grant_key`), which the row then leaves as it was.
 */
export async function recordCredentialAccountIfGeneration(
	input: {
		id: string;
		organizationId: string;
		generation: number;
		externalAccountId: string;
		externalAccountLogin: string;
		scopes?: string[];
	},
	client: Client = db,
): Promise<boolean> {
	try {
		const { count } = await client.credential.updateMany({
			where: {
				id: input.id,
				organizationId: input.organizationId,
				generation: input.generation,
				externalAccountLogin: null,
				status: { not: "REVOKED" },
			},
			data: {
				externalAccountId: input.externalAccountId,
				externalAccountLogin: input.externalAccountLogin,
				...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
				lastCheckedAt: new Date(),
			},
		});
		return count > 0;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			(error as { code?: unknown }).code === "P2002"
		) {
			return false;
		}
		throw error;
	}
}

export async function getCredentialMetadata(input: {
	id: string;
	organizationId: string;
}): Promise<CredentialMetadata | null> {
	return db.credential.findFirst({
		where: { id: input.id, organizationId: input.organizationId },
		select: CREDENTIAL_METADATA_SELECT,
	});
}

export type CreateCredentialInput = {
	organizationId: string;
	/** null = owned by the organization. */
	userId: string | null;
	sharing: CredentialSharing;
	provider: CredentialProvider;
	kind: CredentialKind;
	principal?: CredentialPrincipal;
	label: string;
	origin: string;
	externalAccountId?: string | null;
	externalAccountLogin?: string | null;
	installationId?: string | null;
	installation?: Prisma.InputJsonValue | null;
	scopes?: string[];
	secret?: CredentialSecret | null;
	expiresAt?: Date | null;
	createdByUserId: string;
};

export async function createCredential(
	input: CreateCredentialInput,
	client: Client = db,
): Promise<CredentialMetadata> {
	return client.credential.create({
		data: {
			organizationId: input.organizationId,
			userId: input.userId,
			// Organization-owned rows are always shared (CHECK constraint).
			sharing: input.userId === null ? "ORGANIZATION" : input.sharing,
			provider: input.provider,
			kind: input.kind,
			principal: input.principal ?? "USER",
			label: input.label,
			origin: input.origin,
			externalAccountId: input.externalAccountId ?? null,
			externalAccountLogin: input.externalAccountLogin ?? null,
			installationId: input.installationId ?? null,
			installation: input.installation ?? undefined,
			scopes: input.scopes ?? [],
			encryptedSecret: encryptSecret(input.secret),
			expiresAt: input.expiresAt ?? null,
			createdByUserId: input.createdByUserId,
		},
		select: CREDENTIAL_METADATA_SELECT,
	});
}

export type UpdateCredentialInput = {
	id: string;
	organizationId: string;
	label?: string;
	sharing?: CredentialSharing;
	scopes?: string[];
	expiresAt?: Date | null;
	/** A new secret replaces the old one and bumps `generation`. */
	secret?: CredentialSecret;
	/**
	 * The provider account the new secret acts as; null when it could not be
	 * read (cleared, so a backfill reads it later). Omitted keeps the stored
	 * account.
	 */
	account?: {
		externalAccountId: string;
		externalAccountLogin: string;
	} | null;
};

export async function updateCredential(
	input: UpdateCredentialInput,
	client: Client = db,
): Promise<CredentialMetadata | null> {
	const { count } = await client.credential.updateMany({
		where: { id: input.id, organizationId: input.organizationId },
		data: {
			...(input.label !== undefined ? { label: input.label } : {}),
			...(input.sharing !== undefined ? { sharing: input.sharing } : {}),
			...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
			...(input.expiresAt !== undefined
				? { expiresAt: input.expiresAt }
				: {}),
			...(input.account !== undefined
				? {
						externalAccountId:
							input.account?.externalAccountId ?? null,
						externalAccountLogin:
							input.account?.externalAccountLogin ?? null,
					}
				: {}),
			...(input.secret !== undefined
				? {
						encryptedSecret: encryptSecret(input.secret),
						generation: { increment: 1 },
						// A fresh secret is a fresh start: clear the failure marks.
						status: "ACTIVE" as const,
						refreshRejectedAt: null,
						lastError: null,
					}
				: {}),
		},
	});
	if (count === 0) {
		return null;
	}
	return client.credential.findFirst({
		where: { id: input.id, organizationId: input.organizationId },
		select: CREDENTIAL_METADATA_SELECT,
	});
}

/** The kinds the `credential_account_grant_key` partial unique index covers. */
const ACCOUNT_GRANT_KINDS = ["OAUTH", "GITHUB_APP_USER"] as const;

export type UpsertAccountGrantInput = {
	organizationId: string;
	/** The member who granted it; account grants are always a person's. */
	userId: string;
	provider: CredentialProvider;
	kind: (typeof ACCOUNT_GRANT_KINDS)[number];
	origin: string;
	externalAccountId: string;
	externalAccountLogin: string | null;
	/** Used only when the row is created; a reconnect keeps the owner's label. */
	label: string;
	scopes: string[];
	secret: CredentialSecret;
	expiresAt: Date | null;
	createdByUserId: string;
};

/**
 * Save a provider grant (OAuth or GitHub App user token) as the member's
 * credential, keyed like `credential_account_grant_key`: one live row per
 * (organization, owner, provider, origin, provider account). A reconnect of
 * the same account replaces the secret in place: generation +1, status
 * ACTIVE, failure marks cleared, scopes, expiry, kind and login refreshed.
 * Label and sharing stay as the owner set them.
 *
 * A concurrent first connect can still lose the race to the index; the
 * caller sees the unique violation (P2002) and retries, which then updates.
 */
export async function upsertAccountGrantCredential(
	input: UpsertAccountGrantInput,
	client: Client = db,
): Promise<{ credential: CredentialMetadata; created: boolean }> {
	const existing = await client.credential.findFirst({
		where: {
			organizationId: input.organizationId,
			userId: input.userId,
			provider: input.provider,
			origin: input.origin,
			externalAccountId: input.externalAccountId,
			kind: { in: [...ACCOUNT_GRANT_KINDS] },
			status: { not: "REVOKED" },
		},
		select: { id: true },
	});

	if (!existing) {
		const credential = await createCredential(
			{
				organizationId: input.organizationId,
				userId: input.userId,
				sharing: "PRIVATE",
				provider: input.provider,
				kind: input.kind,
				principal: "USER",
				label: input.label,
				origin: input.origin,
				externalAccountId: input.externalAccountId,
				externalAccountLogin: input.externalAccountLogin,
				scopes: input.scopes,
				secret: input.secret,
				expiresAt: input.expiresAt,
				createdByUserId: input.createdByUserId,
			},
			client,
		);
		return { credential, created: true };
	}

	await client.credential.updateMany({
		where: { id: existing.id, organizationId: input.organizationId },
		data: {
			kind: input.kind,
			externalAccountLogin: input.externalAccountLogin,
			scopes: input.scopes,
			expiresAt: input.expiresAt,
			encryptedSecret: encryptSecret(input.secret),
			generation: { increment: 1 },
			status: "ACTIVE",
			refreshRejectedAt: null,
			lastError: null,
			lastCheckedAt: new Date(),
		},
	});
	const credential = await client.credential.findFirstOrThrow({
		where: { id: existing.id, organizationId: input.organizationId },
		select: CREDENTIAL_METADATA_SELECT,
	});
	return { credential, created: false };
}

export async function deleteCredential(
	input: { id: string; organizationId: string },
	client: Client = db,
): Promise<boolean> {
	const { count } = await client.credential.deleteMany({
		where: { id: input.id, organizationId: input.organizationId },
	});
	return count > 0;
}

/**
 * Server-only: the decrypted secret with the metadata it was read with. A
 * refresher passes `credential.generation` back to
 * `replaceCredentialSecretIfGeneration`, so a reconnect in between wins.
 */
export async function readCredentialSecret(
	input: { id: string; organizationId: string },
	client: Client = db,
): Promise<{
	credential: CredentialMetadata;
	secret: CredentialSecret | null;
} | null> {
	const row = await client.credential.findFirst({
		where: { id: input.id, organizationId: input.organizationId },
		select: { ...CREDENTIAL_METADATA_SELECT, encryptedSecret: true },
	});
	if (!row) {
		return null;
	}
	const { encryptedSecret, ...credential } = row;
	if (!encryptedSecret) {
		return { credential, secret: null };
	}
	return {
		credential,
		secret: JSON.parse(decryptApiKey(encryptedSecret)) as CredentialSecret,
	};
}

/**
 * Generation-fenced secret write for refreshers. Returns false when the row
 * moved on (reconnected, revoked or deleted) since the refresh began; the
 * caller then drops its result. A written secret is a new generation, as for
 * a reconnect, so a writer still holding the old one is fenced out.
 */
export async function replaceCredentialSecretIfGeneration(
	input: {
		id: string;
		organizationId: string;
		generation: number;
		secret: CredentialSecret;
		expiresAt?: Date | null;
		scopes?: string[];
	},
	client: Client = db,
): Promise<boolean> {
	const { count } = await client.credential.updateMany({
		where: {
			id: input.id,
			organizationId: input.organizationId,
			generation: input.generation,
			status: { not: "REVOKED" },
		},
		data: {
			encryptedSecret: encryptSecret(input.secret),
			generation: { increment: 1 },
			...(input.expiresAt !== undefined
				? { expiresAt: input.expiresAt }
				: {}),
			...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
			status: "ACTIVE",
			refreshRejectedAt: null,
			lastError: null,
			lastCheckedAt: new Date(),
		},
	});
	return count > 0;
}

/**
 * Generation-fenced failure mark. `lastError` is a classified code such as
 * `refresh-rejected`, never a provider response body.
 */
export async function markCredentialStatusIfGeneration(
	input: {
		id: string;
		organizationId: string;
		generation: number;
		status: Exclude<CredentialStatus, "ACTIVE">;
		lastError: string;
		refreshRejected?: boolean;
	},
	client: Client = db,
): Promise<boolean> {
	const { count } = await client.credential.updateMany({
		where: {
			id: input.id,
			organizationId: input.organizationId,
			generation: input.generation,
		},
		data: {
			status: input.status,
			lastError: input.lastError,
			lastCheckedAt: new Date(),
			...(input.refreshRejected ? { refreshRejectedAt: new Date() } : {}),
		},
	});
	return count > 0;
}

export async function touchCredentialUsed(input: {
	id: string;
	organizationId: string;
}): Promise<void> {
	await db.credential.updateMany({
		where: { id: input.id, organizationId: input.organizationId },
		data: { lastUsedAt: new Date() },
	});
}
