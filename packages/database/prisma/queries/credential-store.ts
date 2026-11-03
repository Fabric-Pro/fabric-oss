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
 * caller then drops its result.
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
