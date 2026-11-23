import { ORPCError } from "@orpc/server";
import {
	db,
	isFeatureEnabled,
	listOrganizationSharedIntegrations,
} from "@repo/database";
import { PARLUME_REALTIME_MODEL } from "@repo/temporal/parlume-realtime-usage";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	DEFAULT_ATTENDEE_BASE_URL,
	getEnvironmentAttendeeSettings,
	PARLUME_TEAMS_LOGIN_MODES,
	type ParlumeSettingSource,
} from "../../projects/lib/parlume-attendee";
import {
	getOrganizationParlumeSettings,
	teamsLoginModeFromStored,
} from "../../projects/lib/parlume-provider-settings";

export const teamsLoginModeSchema = z.enum(PARLUME_TEAMS_LOGIN_MODES);

/**
 * With an external guest in the meeting: keep notes and stay quiet, or
 * leave, for an organization that keeps Parlume to internal meetings.
 */
export const guestPolicySchema = z.enum(["NOTES_ONLY", "INTERNAL_ONLY"]);

export const parlumeSettingsViewSchema = z.object({
	attendee: z.object({
		/** The organization's own key, masked to its last four characters. */
		maskedApiKey: z.string().nullable(),
		/** Whether the organization saved its Attendee project's webhook secret. */
		hasWebhookSecret: z.boolean(),
		baseUrl: z.string().nullable(),
		teamsLoginMode: teamsLoginModeSchema.nullable(),
		/** The Attendee Teams login group the bot signs in with; null is the oldest. */
		teamsLoginGroup: z.string().nullable(),
		/** Which Attendee project invitations use now; null when none. */
		effectiveSource: z.enum(["organization", "environment"]).nullable(),
	}),
	voice: z.object({
		realtimeDeployment: z.string().nullable(),
	}),
	guests: z.object({
		policy: guestPolicySchema,
	}),
	channel: z.object({
		/** The shared Microsoft connection Parlume replies in channels with. */
		integrationId: z.string().nullable(),
		/** The organization's shared Microsoft connections it may choose. */
		connections: z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				connectedBy: z.string().nullable(),
			}),
		),
	}),
	defaults: z.object({
		attendeeBaseUrl: z.string(),
		realtimeDeployment: z.string(),
	}),
	updatedAt: z.date().nullable(),
});

export type ParlumeSettingsView = z.infer<typeof parlumeSettingsViewSchema>;

/**
 * The stored key only ever goes to the URL it was saved with. Pointing it at
 * another host would let an admin who cannot read the key send it there, so a
 * URL change needs the key typed again.
 */
export const ATTENDEE_URL_NEEDS_KEY =
	"Enter the Attendee API key again to change the Attendee URL.";

/**
 * The last four characters only: an Attendee key is an opaque token, and its
 * leading characters narrow it as much as its trailing ones.
 */
function maskAttendeeKey(key: string): string {
	return key.length < 12 ? "••••" : `••••${key.slice(-4)}`;
}

function maskStoredKey(encrypted: string | null): string | null {
	if (!encrypted) {
		return null;
	}
	try {
		return maskAttendeeKey(decryptApiKey(encrypted));
	} catch {
		return "••••";
	}
}

function environmentSource(): ParlumeSettingSource | null {
	try {
		return getEnvironmentAttendeeSettings() ? "environment" : null;
	} catch {
		return null;
	}
}

/** Parlume settings exist only where its rollout gate is on. */
export async function requireParlumeOrganization(organizationId: string) {
	if (!(await isFeatureEnabled("PARLUME_MEETINGS", organizationId))) {
		throw new ORPCError("NOT_FOUND", {
			message: "Parlume meeting invitations are not enabled.",
		});
	}
}

/**
 * The organization's shared Microsoft connections, which Parlume may reply in
 * a Teams channel meeting with, each named with the member who connected it.
 */
export async function listParlumeChannelConnections(organizationId: string) {
	const connections = await listOrganizationSharedIntegrations(
		"MICROSOFT_GRAPH",
		organizationId,
	);
	const owners = connections.length
		? await db.user.findMany({
				where: {
					id: {
						in: [
							...new Set(
								connections.map(
									(connection) => connection.userId,
								),
							),
						],
					},
				},
				select: { id: true, name: true },
			})
		: [];
	const ownerNames = new Map(owners.map((owner) => [owner.id, owner.name]));
	return connections.map((connection) => ({
		id: connection.id,
		name: connection.name,
		connectedBy: ownerNames.get(connection.userId) ?? null,
	}));
}

export async function loadParlumeSettingsView(
	organizationId: string,
): Promise<ParlumeSettingsView> {
	const [row, connections] = await Promise.all([
		getOrganizationParlumeSettings(organizationId),
		listParlumeChannelConnections(organizationId),
	]);
	const maskedApiKey = maskStoredKey(row?.encryptedAttendeeApiKey ?? null);
	const channelIntegrationId = row?.channelIntegrationId ?? null;
	return {
		attendee: {
			maskedApiKey,
			hasWebhookSecret: Boolean(row?.encryptedAttendeeWebhookSecret),
			baseUrl: row?.attendeeBaseUrl ?? null,
			teamsLoginMode: teamsLoginModeFromStored(
				row?.teamsLoginMode ?? null,
			),
			teamsLoginGroup: row?.teamsLoginGroup ?? null,
			effectiveSource: maskedApiKey
				? "organization"
				: environmentSource(),
		},
		voice: { realtimeDeployment: row?.realtimeDeployment ?? null },
		guests: { policy: row?.guestPolicy ?? "NOTES_ONLY" },
		// A chosen connection that is no longer shared or active is not used,
		// so it shows as no choice.
		channel: {
			integrationId: connections.some(
				(connection) => connection.id === channelIntegrationId,
			)
				? channelIntegrationId
				: null,
			connections,
		},
		defaults: {
			attendeeBaseUrl: DEFAULT_ATTENDEE_BASE_URL,
			realtimeDeployment: PARLUME_REALTIME_MODEL,
		},
		updatedAt: row?.updatedAt ?? null,
	};
}
