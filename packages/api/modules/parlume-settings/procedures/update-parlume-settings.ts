import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { encryptApiKey } from "@repo/utils";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	DEFAULT_ATTENDEE_BASE_URL,
	getAttendeeBaseUrlBlockReason,
	normalizeAttendeeBaseUrl,
} from "../../projects/lib/parlume-attendee";
import {
	getOrganizationParlumeSettings,
	PARLUME_REALTIME_DEPLOYMENT_PATTERN,
	teamsLoginModeToStored,
} from "../../projects/lib/parlume-provider-settings";
import {
	ATTENDEE_URL_NEEDS_KEY,
	loadParlumeSettingsView,
	parlumeSettingsViewSchema,
	requireParlumeOrganization,
	teamsLoginModeSchema,
} from "../lib/settings-view";

const ATTENDEE_KEY_PATTERN = /^\S{8,512}$/;

/** Blank means "not given", like an untouched password field. */
const blankToUndefined = (value: string | undefined) =>
	value?.trim() ? value.trim() : undefined;

/**
 * Saves the organization's meeting-assistant settings. Every field left out
 * keeps its stored value; `null` clears it. An empty key field keeps the
 * stored key unless the base URL changes, which needs the key typed again.
 * `clearAttendeeApiKey` removes the key together with the base
 * URL and Teams sign-in mode it belongs to, so invitations fall back to the
 * operator's Attendee project as a whole.
 */
export const updateParlumeSettings = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_INTEGRATIONS_MANAGE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "PUT",
		path: "/organizations/{organizationId}/parlume-settings",
		tags: ["Parlume"],
		summary: "Update the organization's meeting assistant settings",
	})
	.input(
		z.object({
			organizationId: z.string(),
			attendeeApiKey: z.string().max(512).optional(),
			clearAttendeeApiKey: z.boolean().optional(),
			attendeeBaseUrl: z.string().max(2048).nullable().optional(),
			teamsLoginMode: teamsLoginModeSchema.nullable().optional(),
			realtimeDeployment: z.string().max(64).nullable().optional(),
		}),
	)
	.output(parlumeSettingsViewSchema)
	.handler(async ({ input, context }) => {
		await requireParlumeOrganization(input.organizationId);
		const newKey = blankToUndefined(input.attendeeApiKey);
		if (newKey && input.clearAttendeeApiKey) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Either enter a new Attendee API key or remove it, not both.",
			});
		}
		if (newKey && !ATTENDEE_KEY_PATTERN.test(newKey)) {
			throw new ORPCError("BAD_REQUEST", {
				message: "The Attendee API key looks malformed.",
			});
		}

		let baseUrl: string | null | undefined = input.attendeeBaseUrl;
		if (typeof baseUrl === "string") {
			const trimmed = baseUrl.trim();
			if (!trimmed) {
				baseUrl = null;
			} else {
				// A saved base URL is fetched later with the key and no caller
				// present to refuse it: check it at the write as well as on every
				// request.
				const blockReason = getAttendeeBaseUrlBlockReason(trimmed);
				if (blockReason) {
					throw new ORPCError("BAD_REQUEST", {
						message: `Attendee URL rejected: ${blockReason}`,
					});
				}
				baseUrl = normalizeAttendeeBaseUrl(trimmed);
			}
		}

		let deployment: string | null | undefined = input.realtimeDeployment;
		if (typeof deployment === "string") {
			const trimmed = deployment.trim();
			if (!trimmed) {
				deployment = null;
			} else if (!PARLUME_REALTIME_DEPLOYMENT_PATTERN.test(trimmed)) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"The deployment name may use lowercase letters, digits, dots and hyphens, up to 64 characters.",
				});
			} else {
				deployment = trimmed;
			}
		}

		const stored = await getOrganizationParlumeSettings(
			input.organizationId,
		);
		const clearsKey = input.clearAttendeeApiKey === true;
		const keyAfter = clearsKey
			? null
			: (newKey ?? stored?.encryptedAttendeeApiKey ?? null);
		const baseUrlAfter = clearsKey
			? null
			: baseUrl === undefined
				? (stored?.attendeeBaseUrl ?? null)
				: baseUrl;
		const teamsAfter = clearsKey
			? null
			: input.teamsLoginMode === undefined
				? (stored?.teamsLoginMode ?? null)
				: teamsLoginModeToStored(input.teamsLoginMode);
		// The base URL and sign-in mode describe the organization's own
		// Attendee project. Without its key they would apply to the operator's
		// project, and a base URL would receive the operator's key.
		if (!keyAfter && (baseUrlAfter || teamsAfter)) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Add the organization's Attendee API key to use a custom Attendee URL or Teams sign-in.",
			});
		}
		// Clearing back to the default counts as a change too: the default is
		// also a host the stored key was not saved for.
		const urlChanged =
			(baseUrlAfter ?? DEFAULT_ATTENDEE_BASE_URL) !==
			(stored?.attendeeBaseUrl ?? DEFAULT_ATTENDEE_BASE_URL);
		if (urlChanged && keyAfter && !newKey) {
			throw new ORPCError("BAD_REQUEST", {
				message: ATTENDEE_URL_NEEDS_KEY,
			});
		}

		const data = {
			...(newKey
				? { encryptedAttendeeApiKey: encryptApiKey(newKey) }
				: {}),
			...(clearsKey ? { encryptedAttendeeApiKey: null } : {}),
			attendeeBaseUrl: baseUrlAfter,
			teamsLoginMode: teamsAfter,
			...(deployment === undefined
				? {}
				: { realtimeDeployment: deployment }),
			updatedById: context.user.id,
		};
		await db.organizationParlumeSettings.upsert({
			where: { organizationId: input.organizationId },
			create: { organizationId: input.organizationId, ...data },
			update: data,
		});

		// Non-secret facts only: never the key, its ciphertext or its mask, and
		// no URL text (a path can carry a secret).
		recordAuditFromRequest(context, {
			action: "org.integration.config_updated",
			category: "org",
			organizationId: input.organizationId,
			resource: {
				type: "integration",
				id: "parlume",
				name: "Meeting assistant",
			},
			metadata: {
				keyChanged: Boolean(newKey),
				keyCleared: clearsKey,
				customAttendeeUrl: baseUrlAfter !== null,
				teamsLoginMode: teamsAfter,
				realtimeDeploymentSet:
					deployment === undefined
						? Boolean(stored?.realtimeDeployment)
						: deployment !== null,
			},
		});

		return loadParlumeSettingsView(input.organizationId);
	});
