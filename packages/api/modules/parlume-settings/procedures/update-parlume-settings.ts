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
	guestPolicySchema,
	listParlumeChannelConnections,
	loadParlumeSettingsView,
	parlumeSettingsViewSchema,
	requireParlumeOrganization,
	teamsLoginModeSchema,
} from "../lib/settings-view";

const ATTENDEE_KEY_PATTERN = /^\S{8,512}$/;
// A login group's name as the Attendee dashboard shows it.
const TEAMS_LOGIN_GROUP_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._@-]{0,119}$/u;
// Attendee shows the project's webhook secret as base64 (32 bytes).
const ATTENDEE_WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9+/]{22,510}={0,2}$/;

/** Blank means "not given", like an untouched password field. */
const blankToUndefined = (value: string | undefined) =>
	value?.trim() ? value.trim() : undefined;

/**
 * Saves the organization's meeting-assistant settings. Every field left out
 * keeps its stored value; `null` clears it. An empty key field keeps the
 * stored key unless the base URL changes, which needs the key typed again; an
 * empty webhook secret field keeps the stored secret.
 * `clearAttendeeApiKey` removes the key together with the base URL, Teams
 * sign-in mode and webhook secret it belongs to, so invitations fall back to
 * the operator's Attendee project as a whole.
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
			attendeeWebhookSecret: z.string().max(512).optional(),
			clearAttendeeApiKey: z.boolean().optional(),
			attendeeBaseUrl: z.string().max(2048).nullable().optional(),
			teamsLoginMode: teamsLoginModeSchema.nullable().optional(),
			teamsLoginGroup: z.string().max(120).nullable().optional(),
			realtimeDeployment: z.string().max(64).nullable().optional(),
			guestPolicy: guestPolicySchema.optional(),
			channelIntegrationId: z.string().max(128).nullable().optional(),
		}),
	)
	.output(parlumeSettingsViewSchema)
	.handler(async ({ input, context }) => {
		await requireParlumeOrganization(input.organizationId);
		const newKey = blankToUndefined(input.attendeeApiKey);
		const newWebhookSecret = blankToUndefined(input.attendeeWebhookSecret);
		if ((newKey || newWebhookSecret) && input.clearAttendeeApiKey) {
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
		if (
			newWebhookSecret &&
			!ATTENDEE_WEBHOOK_SECRET_PATTERN.test(newWebhookSecret)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"The Attendee webhook secret looks malformed. Copy it from Settings → Webhooks in the Attendee dashboard.",
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

		let group: string | null | undefined = input.teamsLoginGroup;
		if (typeof group === "string") {
			const trimmed = group.trim();
			if (!trimmed) {
				group = null;
			} else if (!TEAMS_LOGIN_GROUP_PATTERN.test(trimmed)) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"The Teams login group may use letters, digits, spaces, dots, hyphens, underscores and @, up to 120 characters.",
				});
			} else {
				group = trimmed;
			}
		}

		// Only one of the organization's own shared Microsoft connections:
		// Parlume posts in channels as that account.
		const channelIntegrationId = input.channelIntegrationId;
		if (
			typeof channelIntegrationId === "string" &&
			!(await listParlumeChannelConnections(input.organizationId)).some(
				(connection) => connection.id === channelIntegrationId,
			)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Choose one of the organization's shared Microsoft connections.",
			});
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
		// A login group is the account a signed-in bot uses, so it goes with
		// the sign-in mode: an anonymous bot has none.
		const groupAfter =
			clearsKey || teamsAfter === null
				? null
				: group === undefined
					? (stored?.teamsLoginGroup ?? null)
					: group;
		const webhookSecretAfter = clearsKey
			? null
			: newWebhookSecret
				? encryptApiKey(newWebhookSecret)
				: (stored?.encryptedAttendeeWebhookSecret ?? null);
		// The base URL, sign-in mode, login group and webhook secret describe
		// the organization's own Attendee project. Without its key they would
		// apply to the operator's project, which every organization without a
		// key shares, and a base URL would receive the operator's key.
		if (
			!keyAfter &&
			(baseUrlAfter || teamsAfter || group || webhookSecretAfter)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Add the organization's Attendee API key to use a custom Attendee URL, Teams sign-in or webhook secret.",
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
			encryptedAttendeeWebhookSecret: webhookSecretAfter,
			attendeeBaseUrl: baseUrlAfter,
			teamsLoginMode: teamsAfter,
			teamsLoginGroup: groupAfter,
			...(deployment === undefined
				? {}
				: { realtimeDeployment: deployment }),
			...(input.guestPolicy ? { guestPolicy: input.guestPolicy } : {}),
			...(channelIntegrationId === undefined
				? {}
				: { channelIntegrationId }),
			updatedById: context.user.id,
		};
		await db.organizationParlumeSettings.upsert({
			where: { organizationId: input.organizationId },
			create: { organizationId: input.organizationId, ...data },
			update: data,
		});

		// Non-secret facts only: never the key or the webhook secret, their
		// ciphertext or a mask, and no URL text (a path can carry a secret).
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
				// Named apart from "secret", which the audit redactor masks.
				webhookVerificationChanged: Boolean(newWebhookSecret),
				webhookVerificationSet: webhookSecretAfter !== null,
				customAttendeeUrl: baseUrlAfter !== null,
				teamsLoginMode: teamsAfter,
				teamsLoginGroupSet: groupAfter !== null,
				channelConnectionSet:
					channelIntegrationId === undefined
						? Boolean(stored?.channelIntegrationId)
						: channelIntegrationId !== null,
				realtimeDeploymentSet:
					deployment === undefined
						? Boolean(stored?.realtimeDeployment)
						: deployment !== null,
				guestPolicy:
					input.guestPolicy ?? stored?.guestPolicy ?? "NOTES_ONLY",
			},
		});

		return loadParlumeSettingsView(input.organizationId);
	});
