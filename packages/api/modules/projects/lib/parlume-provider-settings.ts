import { db } from "@repo/database";
import type {
	ParlumeAttendeeSource,
	ParlumeGuestPolicy,
	ParlumeTeamsLoginMode as StoredTeamsLoginMode,
} from "@repo/database/prisma/generated/enums";
import { decryptApiKey } from "@repo/utils";
import {
	DEFAULT_ATTENDEE_BASE_URL,
	getEnvironmentAttendeeSettings,
	getEnvironmentAttendeeWebhookSecret,
	type ParlumeAttendeeSettings,
	type ParlumeSettingSource,
	type ParlumeTeamsLoginMode,
} from "./parlume-attendee";

/**
 * Azure names a deployment freely, but the bridge opens the realtime socket
 * with it as `?model=` and accepts only this shape, so a name outside it would
 * mint a secret no socket can use.
 */
export const PARLUME_REALTIME_DEPLOYMENT_PATTERN = /^[a-z0-9.-]{1,64}$/;

export function teamsLoginModeFromStored(
	mode: StoredTeamsLoginMode | null,
): ParlumeTeamsLoginMode | null {
	switch (mode) {
		case null:
			return null;
		case "ALWAYS":
			return "always";
		case "ONLY_IF_REQUIRED":
			return "only_if_required";
		default: {
			const unknown: never = mode;
			throw new Error(`Unsupported Teams sign-in mode: ${unknown}`);
		}
	}
}

export function teamsLoginModeToStored(
	mode: ParlumeTeamsLoginMode | null,
): StoredTeamsLoginMode | null {
	switch (mode) {
		case null:
			return null;
		case "always":
			return "ALWAYS";
		case "only_if_required":
			return "ONLY_IF_REQUIRED";
		default: {
			const unknown: never = mode;
			throw new Error(`Unsupported Teams sign-in mode: ${unknown}`);
		}
	}
}

export async function getOrganizationParlumeSettings(organizationId: string) {
	return db.organizationParlumeSettings.findUnique({
		where: { organizationId },
		select: {
			encryptedAttendeeApiKey: true,
			encryptedAttendeeWebhookSecret: true,
			attendeeBaseUrl: true,
			teamsLoginMode: true,
			teamsLoginGroup: true,
			realtimeDeployment: true,
			guestPolicy: true,
			channelIntegrationId: true,
			updatedAt: true,
		},
	});
}

/**
 * The Attendee project a bot is created, left and cleaned up on: the
 * organization's own when it has saved a key, else the operator's. The key,
 * base URL, Teams sign-in mode and login group, and webhook secret resolve as
 * one unit, never
 * field by field: an organization's base URL must never receive the operator's
 * key, and the Teams sign-in mode and the webhook secret belong to that one
 * project.
 */
export async function resolveParlumeAttendeeSettings(
	organizationId: string,
): Promise<ParlumeAttendeeSettings | null> {
	const row = await getOrganizationParlumeSettings(organizationId);
	if (row?.encryptedAttendeeApiKey) {
		return {
			apiKey: decryptApiKey(row.encryptedAttendeeApiKey),
			baseUrl: row.attendeeBaseUrl ?? DEFAULT_ATTENDEE_BASE_URL,
			teamsLoginMode: teamsLoginModeFromStored(row.teamsLoginMode),
			teamsLoginGroup: row.teamsLoginGroup,
			webhookSecret: row.encryptedAttendeeWebhookSecret
				? decryptApiKey(row.encryptedAttendeeWebhookSecret)
				: null,
			source: "organization",
		};
	}
	return getEnvironmentAttendeeSettings();
}

export function attendeeSourceToStored(
	source: ParlumeSettingSource,
): ParlumeAttendeeSource {
	switch (source) {
		case "environment":
			return "ENVIRONMENT";
		case "organization":
			return "ORGANIZATION";
		default: {
			const unknown: never = source;
			throw new Error(`Unsupported Attendee source: ${unknown}`);
		}
	}
}

/**
 * The webhook secret of the Attendee project a session's bot was created on,
 * or null when that project has none. It does not follow the organization's
 * settings: a key saved or removed mid-meeting neither breaks nor relaxes the
 * check for a bot already running. A session from before the source was
 * recorded resolves the organization's current settings.
 */
export async function resolveParlumeWebhookSecret(session: {
	organizationId: string;
	attendeeSource: ParlumeAttendeeSource | null;
}): Promise<string | null> {
	switch (session.attendeeSource) {
		case null:
			return (
				(await resolveParlumeAttendeeSettings(session.organizationId))
					?.webhookSecret ?? null
			);
		case "ENVIRONMENT":
			return getEnvironmentAttendeeWebhookSecret();
		case "ORGANIZATION": {
			const row = await getOrganizationParlumeSettings(
				session.organizationId,
			);
			return row?.encryptedAttendeeWebhookSecret
				? decryptApiKey(row.encryptedAttendeeWebhookSecret)
				: null;
		}
		default: {
			const unknown: never = session.attendeeSource;
			throw new Error(`Unsupported Attendee source: ${unknown}`);
		}
	}
}

/** The Attendee settings of the organization a session belongs to. */
export async function resolveParlumeAttendeeSettingsForSession(
	sessionId: string,
): Promise<ParlumeAttendeeSettings | null> {
	const session = await db.parlumeMeetingSession.findUnique({
		where: { id: sessionId },
		select: { organizationId: true },
	});
	return session
		? resolveParlumeAttendeeSettings(session.organizationId)
		: null;
}

/**
 * The Azure AI Foundry deployment the organization named for the realtime
 * voice, or null. Without one, its meetings use the classic voice and no
 * meeting audio goes to a realtime model.
 */
export async function resolveParlumeRealtimeDeployment(
	organizationId: string | null,
): Promise<string | null> {
	const row = organizationId
		? await db.organizationParlumeSettings.findUnique({
				where: { organizationId },
				select: { realtimeDeployment: true },
			})
		: null;
	return row?.realtimeDeployment ?? null;
}

/** What Parlume does while an external guest is in the meeting. */
export async function resolveParlumeGuestPolicy(
	organizationId: string,
): Promise<ParlumeGuestPolicy> {
	const row = await db.organizationParlumeSettings.findUnique({
		where: { organizationId },
		select: { guestPolicy: true },
	});
	return row?.guestPolicy ?? "NOTES_ONLY";
}
