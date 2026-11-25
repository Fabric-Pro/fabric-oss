import {
	type DataConnectionProvider,
	db,
	getDataConnectionSyncMetadata,
	isOrganizationMember,
} from "@repo/database";
import { decryptApiKey, isEncryptedApiKey } from "@repo/utils";
import { ApplicationFailure } from "@temporalio/common";
import {
	CONNECTOR_SYNC_CONNECTION_NOT_AUTHORIZED,
	CONNECTOR_SYNC_CREDENTIAL_UNREADABLE,
	CONNECTOR_SYNC_ORGANIZATION_REQUIRED,
	CONNECTOR_SYNC_PROVIDER_MISMATCH,
} from "../../../workflows/connector-sync/connection-failures";
import { assertGitLabSyncActor } from "../providers/gitlab-credential";
import type { ConnectorCredentials } from "../providers/types";

export type ConnectorSyncConnectionRef = {
	connectorId: string;
	provider: string;
	userId?: string;
	organizationId?: string;
	/** Accepted from histories scheduled by older workers. */
	credentials?: ConnectorCredentials;
	providerConfig?: Record<string, unknown>;
};

export type ResolvedConnectorSyncConnection = {
	provider: DataConnectionProvider;
	providerConfig: Record<string, unknown>;
	credentials: ConnectorCredentials;
};

function connectionNotAuthorized(): ApplicationFailure {
	return ApplicationFailure.nonRetryable(
		"The connector sync cannot access this data connection in its organization.",
		CONNECTOR_SYNC_CONNECTION_NOT_AUTHORIZED,
	);
}

function assertProvider(expected: string, actual: string): void {
	if (expected !== actual) {
		throw ApplicationFailure.nonRetryable(
			"The data connection provider does not match the connector sync.",
			CONNECTOR_SYNC_PROVIDER_MISMATCH,
		);
	}
}

function decryptStoredToken<T extends string | null>(value: T): T | string {
	return isEncryptedApiKey(value) ? decryptApiKey(value) : value;
}

function credentialObject(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected a stored credential object");
	}
	return value as Record<string, unknown>;
}

/** Resolve the authorized row immediately before a provider call. */
export async function resolveConnectorSyncConnection({
	connectorId,
	organizationId,
	userId,
	provider,
}: ConnectorSyncConnectionRef): Promise<ResolvedConnectorSyncConnection> {
	if (provider === "GITLAB") {
		assertGitLabSyncActor(userId);
	}
	if (!organizationId) {
		throw ApplicationFailure.nonRetryable(
			"An organization is required to sync a data connection.",
			CONNECTOR_SYNC_ORGANIZATION_REQUIRED,
		);
	}

	if (!(await isOrganizationMember(userId ?? "", organizationId))) {
		throw connectionNotAuthorized();
	}

	if (provider === "GITLAB") {
		// GitLab obtains the actor's live credential separately.
		const metadata = await getDataConnectionSyncMetadata({
			id: connectorId,
			userId: userId ?? "",
			organizationId,
		});
		if (!metadata) {
			throw connectionNotAuthorized();
		}
		assertProvider(provider, metadata.provider);
		return {
			provider: metadata.provider,
			providerConfig:
				(metadata.config as Record<string, unknown> | null) ?? {},
			credentials: {},
		};
	}

	// Read ciphertext directly. The shared legacy decrypting query can return
	// ciphertext unchanged on decryption failure.
	const row = await db.dataConnection.findFirst({
		where: { id: connectorId, organizationId },
		select: {
			provider: true,
			config: true,
			accessToken: true,
			refreshToken: true,
			credentials: true,
			credentialId: true,
			credential: {
				select: { organizationId: true, encryptedPayload: true },
			},
		},
	});
	if (!row) {
		throw connectionNotAuthorized();
	}
	assertProvider(provider, row.provider);
	if (row.credentialId && row.credential?.organizationId !== organizationId) {
		throw connectionNotAuthorized();
	}

	try {
		const credentials: ConnectorCredentials = {
			accessToken: decryptStoredToken(row.accessToken),
			refreshToken: decryptStoredToken(row.refreshToken),
			...(row.credential &&
				credentialObject(
					JSON.parse(decryptApiKey(row.credential.encryptedPayload)),
				)),
			...credentialObject(
				typeof row.credentials === "string"
					? JSON.parse(decryptStoredToken(row.credentials))
					: (row.credentials ?? {}),
			),
		};
		return {
			provider: row.provider,
			providerConfig:
				(row.config as Record<string, unknown> | null) ?? {},
			credentials,
		};
	} catch {
		throw ApplicationFailure.nonRetryable(
			"The saved data connection credentials could not be read.",
			CONNECTOR_SYNC_CREDENTIAL_UNREADABLE,
		);
	}
}
