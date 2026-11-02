/**
 * Get Slack Context
 *
 * Returns the connected Slack workspace identity (team id, team name, bot user
 * id) for the current tenant. Used by the agent triggers UI to default the
 * Slack panel config without forcing the user to copy IDs.
 *
 * Reads the values from the stored credentials JSON. For OAuth connections
 * that pre-date the team/bot capture, falls back to Slack's auth.test API and
 * persists the result so subsequent calls are cheap.
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { readSlackConnectionIdentity } from "@repo/integrations/slack";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const getSlackContextProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.INTEGRATION_READ))
	.route({
		method: "GET",
		path: "/integrations/slack/context",
		tags: ["Integrations", "Slack"],
		summary: "Get connected Slack workspace identity",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z
			.object({
				teamId: z.string(),
				teamName: z.string().nullable(),
				botUserId: z.string().nullable(),
			})
			.nullable(),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId =
			input.organizationId !== undefined
				? input.organizationId
				: context.session.activeOrganizationId;

		const integration = await db.workflowIntegration.findFirst({
			where: {
				userId,
				provider: "SLACK",
				isActive: true,
				NOT: { name: "SLACK_OAUTH_APP" },
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
			},
		});

		if (!integration?.credentials) {
			return null;
		}

		let identity: Awaited<ReturnType<typeof readSlackConnectionIdentity>>;
		try {
			identity = await readSlackConnectionIdentity(integration);
		} catch (error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					error instanceof Error &&
					error.message.startsWith("Slack credentials are corrupted")
						? "Slack credentials are corrupted"
						: "Could not verify the connected Slack workspace",
			});
		}
		if (!identity.teamId) {
			return null;
		}
		return {
			teamId: identity.teamId,
			teamName: identity.teamName ?? null,
			botUserId: identity.botUserId ?? null,
		};
	});
