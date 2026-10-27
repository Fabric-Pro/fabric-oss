import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	loadParlumeSettingsView,
	parlumeSettingsViewSchema,
	requireParlumeOrganization,
} from "../lib/settings-view";

/**
 * The organization's meeting-assistant settings. Never the key: only its last
 * four characters, and which Attendee project invitations use now.
 */
export const getParlumeSettings = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_INTEGRATIONS_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/parlume-settings",
		tags: ["Parlume"],
		summary: "Get the organization's meeting assistant settings",
	})
	.input(z.object({ organizationId: z.string() }))
	.output(parlumeSettingsViewSchema)
	.handler(async ({ input }) => {
		await requireParlumeOrganization(input.organizationId);
		return loadParlumeSettingsView(input.organizationId);
	});
