/** Server-only credential seam shared by source commands and capture activities. */
import { createHash } from "node:crypto";
import {
	normalizeDeliverySignalCaptureRevision,
	qualifySlackDeliverySource,
	type SlackDeliveryMessage,
	type SlackDeliveryPageInput,
	type SlackDeliverySourceProof,
} from "@repo/connectors";
import {
	getOwnedDeliverySlackIntegration,
	loadDeliverySourceCaptureContext,
} from "@repo/database";
import {
	DELIVERY_SOURCE_ADAPTER_VERSION,
	DELIVERY_SOURCE_CAPTURE_MAX_SNAPSHOT_BYTES,
	DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES,
} from "@repo/temporal/delivery-source-capture-contracts";
import { decryptApiKey, isEncryptedApiKey } from "@repo/utils";

export { DELIVERY_SOURCE_ADAPTER_VERSION } from "@repo/temporal/delivery-source-capture-contracts";

export interface DeliverySourceAccessScope {
	organizationId: string;
	projectId: string;
	userId: string;
}
export class DeliverySourceAccessError extends Error {
	readonly code = "DELIVERY_SOURCE_CREDENTIAL_UNAVAILABLE";
	constructor() {
		super("Your saved source credentials could not be verified.");
		this.name = "DeliverySourceAccessError";
	}
}
function unavailable(): never {
	throw new DeliverySourceAccessError();
}

/** Stable selected evidence bytes shared by capture and current-source revalidation. */
export function encodeDeliverySourceSnapshot(message: SlackDeliveryMessage) {
	if (
		typeof message.text !== "string" ||
		message.text.length > DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES ||
		Buffer.byteLength(message.text, "utf8") >
			DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES ||
		typeof message.hasReplies !== "boolean"
	) {
		unavailable();
	}
	let revision: SlackDeliveryMessage["revision"];
	try {
		// Reuse the exact decimal validator, without rewriting the source item ID.
		normalizeDeliverySignalCaptureRevision({
			kind: "DECIMAL",
			value: message.externalItemId,
		});
		revision = normalizeDeliverySignalCaptureRevision(message.revision);
		if (revision.kind !== "DECIMAL") {
			unavailable();
		}
	} catch {
		unavailable();
	}
	const payload = JSON.stringify({
		version: 1,
		provider: "SLACK",
		externalItemId: message.externalItemId,
		revision,
		text: message.text,
		hasReplies: message.hasReplies,
	});
	if (
		Buffer.byteLength(payload, "utf8") >
		DELIVERY_SOURCE_CAPTURE_MAX_SNAPSHOT_BYTES
	) {
		unavailable();
	}
	return {
		payload,
		digest: createHash("sha256").update(payload).digest("hex"),
	};
}

/** Strict encrypted JSON only. No legacy plaintext, bot-only or substitute connection. */
function pairedCredentials(encrypted: unknown) {
	if (!isEncryptedApiKey(encrypted) || encrypted.length > 100_000) {
		unavailable();
	}
	try {
		const value: unknown = JSON.parse(decryptApiKey(encrypted));
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			unavailable();
		}
		const row = value as Record<string, unknown>;
		if (
			![row.access_token, row.user_access_token, row.team_id].every(
				(value) =>
					typeof value === "string" &&
					value.length > 0 &&
					value.length <= 4096 &&
					!/[\s\p{Cc}]/u.test(value),
			)
		) {
			unavailable();
		}
		if (
			row.access_token === row.user_access_token ||
			!/^T[A-Z0-9]{2,63}$/.test(row.team_id as string)
		) {
			unavailable();
		}
		return {
			botToken: row.access_token as string,
			userToken: row.user_access_token as string,
			teamId: row.team_id as string,
		};
	} catch {
		return unavailable();
	}
}

/** Local credential-shape capability only; this is not a successful provider access check. */
export function savedSlackDeliveryCredentialPairAvailable(
	encrypted: unknown,
): boolean {
	try {
		pairedCredentials(encrypted);
		return true;
	} catch {
		return false;
	}
}

export async function inspectOwnedSlackDeliveryIntegration(
	scope: DeliverySourceAccessScope,
	integrationId: string,
	channelId: string,
): Promise<{
	proof: SlackDeliverySourceProof;
	label: string;
	checkedAt: Date;
}> {
	const integration = await getOwnedDeliverySlackIntegration(
		scope,
		integrationId,
	);
	if (!integration) {
		unavailable();
	}
	const credentials = pairedCredentials(integration.credentials);
	const proof = await qualifySlackDeliverySource({
		botToken: credentials.botToken,
		userToken: credentials.userToken,
		expectedTeamId: credentials.teamId,
		channelId,
	});
	const label = proof.channelName
		? `#${proof.channelName}`
		: `Slack channel ${channelId}`;
	return { proof, label: label.slice(0, 200), checkedAt: new Date() };
}

/** Returns secrets only to server code; never serialize this return value to a transport. */
export async function loadPinnedSlackDeliveryCredentials(
	scope: DeliverySourceAccessScope,
	watchId: string,
	write = false,
) {
	const context = await loadDeliverySourceCaptureContext(
		scope,
		watchId,
		write,
	);
	if (!context || !context.integration || !context.grant) {
		unavailable();
	}
	const { watch, grant, integration } = context;
	const credentials = pairedCredentials(integration.credentials);
	if (
		credentials.teamId !== watch.installationId ||
		grant.revokedAt !== null ||
		grant.revision !== watch.grantRevision ||
		grant.adapterVersion !== DELIVERY_SOURCE_ADAPTER_VERSION ||
		integration.id !== watch.integrationId ||
		integration.provider !== "SLACK" ||
		integration.userId !== scope.userId ||
		integration.organizationId !== scope.organizationId ||
		!integration.isActive
	) {
		unavailable();
	}
	const adapterInput: Omit<
		SlackDeliveryPageInput,
		"oldest" | "latest" | "cursor"
	> = {
		botToken: credentials.botToken,
		userToken: credentials.userToken,
		expectedTeamId: watch.installationId,
		channelId: watch.containerId,
		expectedHumanUserId: grant.humanUserId,
		expectedBotId: grant.botId,
	};
	return { context, adapterInput };
}
