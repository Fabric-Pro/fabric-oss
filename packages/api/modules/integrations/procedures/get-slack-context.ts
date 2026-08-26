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
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

interface StoredSlackCredentials {
	access_token?: string;
	team_id?: string;
	team_name?: string;
	bot_user_id?: string;
	[key: string]: unknown;
}

async function fetchSlackAuthTest(accessToken: string): Promise<{
	teamId?: string;
	teamName?: string;
	botUserId?: string;
}> {
	const response = await fetch("https://slack.com/api/auth.test", {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!response.ok) {
		return {};
	}
	const data = (await response.json()) as {
		ok: boolean;
		team_id?: string;
		team?: string;
		bot_id?: string;
		user_id?: string;
	};
	if (!data.ok) {
		return {};
	}
	return {
		teamId: data.team_id,
		teamName: data.team,
		// auth.test returns user_id which IS the bot's user id when called with
		// a bot token (xoxb-). bot_id is a different identifier.
		botUserId: data.user_id,
	};
}

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

		let credentials: StoredSlackCredentials;
		try {
			let json: string;
			try {
				json = decryptApiKey(integration.credentials);
			} catch {
				json = integration.credentials;
			}
			credentials = JSON.parse(json) as StoredSlackCredentials;
		} catch {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Slack credentials are corrupted",
			});
		}

		// Happy path: fields were captured during OAuth.
		if (credentials.team_id) {
			return {
				teamId: credentials.team_id,
				teamName: credentials.team_name ?? null,
				botUserId: credentials.bot_user_id ?? null,
			};
		}

		// Legacy path: fall back to auth.test and backfill.
		if (!credentials.access_token) {
			return null;
		}

		const fetched = await fetchSlackAuthTest(credentials.access_token);
		if (!fetched.teamId) {
			return null;
		}

		const updated: StoredSlackCredentials = {
			...credentials,
			team_id: fetched.teamId,
			team_name: fetched.teamName,
			bot_user_id: fetched.botUserId,
		};
		try {
			await db.workflowIntegration.update({
				where: { id: integration.id },
				data: { credentials: encryptApiKey(JSON.stringify(updated)) },
			});
		} catch (error) {
			console.warn(
				"[getSlackContext] Failed to backfill credentials cache",
				error,
			);
		}

		return {
			teamId: fetched.teamId,
			teamName: fetched.teamName ?? null,
			botUserId: fetched.botUserId ?? null,
		};
	});
