import { db } from "@repo/database";
import type { ParlumeTeamsLoginMode as StoredTeamsLoginMode } from "@repo/database/prisma/generated/enums";
import { PARLUME_REALTIME_MODEL } from "@repo/temporal/parlume-realtime-usage";
import { decryptApiKey } from "@repo/utils";
import {
	DEFAULT_ATTENDEE_BASE_URL,
	getEnvironmentAttendeeSettings,
	type ParlumeAttendeeSettings,
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
			attendeeBaseUrl: true,
			teamsLoginMode: true,
			realtimeDeployment: true,
			updatedAt: true,
		},
	});
}

/**
 * The Attendee project a bot is created, left and cleaned up on: the
 * organization's own when it has saved a key, else the operator's. The key,
 * base URL and Teams sign-in mode resolve as one unit, never field by field: an
 * organization's base URL must never receive the operator's key, and the Teams
 * sign-in mode describes the Microsoft 365 account set up on that one project.
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
			source: "organization",
		};
	}
	return getEnvironmentAttendeeSettings();
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
 * The Azure AI Foundry deployment that serves the realtime voice model: the
 * organization's own name, else one named after the model.
 */
export async function resolveParlumeRealtimeDeployment(
	organizationId: string | null,
): Promise<{ deployment: string; source: "organization" | "default" }> {
	const row = organizationId
		? await db.organizationParlumeSettings.findUnique({
				where: { organizationId },
				select: { realtimeDeployment: true },
			})
		: null;
	return row?.realtimeDeployment
		? { deployment: row.realtimeDeployment, source: "organization" }
		: { deployment: PARLUME_REALTIME_MODEL, source: "default" };
}
