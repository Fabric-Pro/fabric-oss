import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	checkAttendeeConnection,
	DEFAULT_ATTENDEE_BASE_URL,
	getAttendeeBaseUrlBlockReason,
	normalizeAttendeeBaseUrl,
} from "../../projects/lib/parlume-attendee";
import { resolveParlumeAttendeeSettings } from "../../projects/lib/parlume-provider-settings";
import { checkParlumeRealtimeHosts } from "../../projects/lib/parlume-realtime-session";
import {
	ATTENDEE_URL_NEEDS_KEY,
	requireParlumeOrganization,
} from "../lib/settings-view";

/**
 * The key and URL to check, as the form shows them: the URL field as typed
 * (empty is Attendee's hosted service), and the typed key or else the
 * organization's saved one. A saved key is only sent to the URL it was saved
 * with; any other URL is tested only with a key typed in the same request.
 * With neither and no URL typed, the operator's Attendee project is checked
 * as it is configured, so the operator's key never reaches a typed URL.
 */
async function connectionUnderTest(input: {
	organizationId: string;
	attendeeApiKey?: string;
	attendeeBaseUrl?: string | null;
}): Promise<{ apiKey: string; baseUrl: string }> {
	const typedKey = input.attendeeApiKey?.trim() || null;
	const typedUrl = input.attendeeBaseUrl?.trim() || null;
	let baseUrl = DEFAULT_ATTENDEE_BASE_URL;
	if (typedUrl) {
		const blockReason = getAttendeeBaseUrlBlockReason(typedUrl);
		if (blockReason) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Attendee URL rejected: ${blockReason}`,
			});
		}
		baseUrl = normalizeAttendeeBaseUrl(typedUrl) ?? baseUrl;
	}
	if (typedKey) {
		return { apiKey: typedKey, baseUrl };
	}
	const saved = await resolveParlumeAttendeeSettings(input.organizationId);
	if (saved?.source === "organization") {
		if (baseUrl !== saved.baseUrl) {
			throw new ORPCError("BAD_REQUEST", {
				message: ATTENDEE_URL_NEEDS_KEY,
			});
		}
		return { apiKey: saved.apiKey, baseUrl: saved.baseUrl };
	}
	if (saved && !typedUrl) {
		return { apiKey: saved.apiKey, baseUrl: saved.baseUrl };
	}
	throw new ORPCError("BAD_REQUEST", {
		message: "Enter an Attendee API key to test.",
	});
}

/**
 * Checks an Attendee key with its read-only bot list: no bot is created and
 * nothing is billed. Reports a rejected key apart from an unreachable or
 * failing instance.
 */
export const testParlumeAttendeeConnection = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_INTEGRATIONS_MANAGE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/parlume-settings/test-attendee",
		tags: ["Parlume"],
		summary: "Test the meeting bot's Attendee connection",
	})
	.input(
		z.object({
			organizationId: z.string(),
			attendeeApiKey: z.string().max(512).optional(),
			attendeeBaseUrl: z.string().max(2048).nullable().optional(),
		}),
	)
	.output(
		z.discriminatedUnion("status", [
			z.object({ status: z.literal("ok") }),
			z.object({
				status: z.literal("invalid_key"),
				httpStatus: z.number(),
			}),
			z.object({
				status: z.literal("error"),
				httpStatus: z.number().nullable(),
				detail: z.string().nullable(),
			}),
		]),
	)
	.handler(async ({ input }) => {
		await requireParlumeOrganization(input.organizationId);
		return checkAttendeeConnection(await connectionUnderTest(input));
	});

/**
 * Mints a realtime client secret on each of the organization's voice hosts,
 * the way a meeting does, but opens no session: proves the key, the Azure
 * resource and its deployment without billing anything.
 */
export const testParlumeRealtimeVoice = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_INTEGRATIONS_MANAGE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/parlume-settings/test-realtime",
		tags: ["Parlume"],
		summary: "Test the meeting assistant's realtime voice",
	})
	.input(z.object({ organizationId: z.string() }))
	.output(
		z.object({
			hosts: z.array(
				z.object({
					provider: z.enum(["AZURE_AI_FOUNDRY", "OPENAI_DIRECT"]),
					model: z.string(),
					ok: z.boolean(),
					status: z.number().nullable(),
					message: z.string().nullable(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		await requireParlumeOrganization(input.organizationId);
		const checks = await checkParlumeRealtimeHosts({
			userId: context.user.id,
			organizationId: input.organizationId,
		});
		return { hosts: checks };
	});
