import { ORPCError } from "@orpc/server";
import { isFeatureEnabled } from "@repo/database";
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

export const parlumeSettingsViewSchema = z.object({
	attendee: z.object({
		/** The organization's own key, masked to its last four characters. */
		maskedApiKey: z.string().nullable(),
		baseUrl: z.string().nullable(),
		teamsLoginMode: teamsLoginModeSchema.nullable(),
		/** Which Attendee project invitations use now; null when none. */
		effectiveSource: z.enum(["organization", "environment"]).nullable(),
	}),
	voice: z.object({
		realtimeDeployment: z.string().nullable(),
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

export async function loadParlumeSettingsView(
	organizationId: string,
): Promise<ParlumeSettingsView> {
	const row = await getOrganizationParlumeSettings(organizationId);
	const maskedApiKey = maskStoredKey(row?.encryptedAttendeeApiKey ?? null);
	return {
		attendee: {
			maskedApiKey,
			baseUrl: row?.attendeeBaseUrl ?? null,
			teamsLoginMode: teamsLoginModeFromStored(
				row?.teamsLoginMode ?? null,
			),
			effectiveSource: maskedApiKey
				? "organization"
				: environmentSource(),
		},
		voice: { realtimeDeployment: row?.realtimeDeployment ?? null },
		defaults: {
			attendeeBaseUrl: DEFAULT_ATTENDEE_BASE_URL,
			realtimeDeployment: PARLUME_REALTIME_MODEL,
		},
		updatedAt: row?.updatedAt ?? null,
	};
}
