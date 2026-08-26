/**
 * v1 Channels routes (Slice 5a).
 *
 *   GET  /channels                    List channel adapters + connection status
 *   POST /channels/:channel/send      Send an outbound message via the adapter
 *
 * Slack continues to use its bespoke send path in this slice. Once Slice 5b
 * migrates Slack onto ChannelAdapter, the same SDK call site
 * (`fabric.channels.send`) starts dispatching Slack through this route too —
 * SDK consumers see no change.
 */

import { db } from "@repo/database";
import { channelRegistry } from "@repo/integrations";
import { decryptApiKey } from "@repo/utils";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { badRequest, notFound, ok, resolveV1Context } from "./helpers";

async function resolveCredentialsFor(
	tenantUserId: string,
	tenantOrgId: string | null,
	providerKey: string,
): Promise<Record<string, unknown> | undefined> {
	type ProviderEnum = NonNullable<
		Parameters<typeof db.workflowIntegration.findFirst>[0]
	>["where"] extends infer W
		? W extends { provider?: infer P }
			? P
			: never
		: never;

	const where = tenantOrgId
		? { organizationId: tenantOrgId, isActive: true }
		: { userId: tenantUserId, organizationId: null, isActive: true };

	const integration = await db.workflowIntegration.findFirst({
		where: { ...where, provider: providerKey as unknown as ProviderEnum },
		orderBy: { lastUsedAt: "desc" },
	});
	if (!integration) {
		return undefined;
	}
	try {
		return JSON.parse(decryptApiKey(integration.credentials)) as Record<
			string,
			unknown
		>;
	} catch {
		return undefined;
	}
}

export function registerChannelRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.get("/channels", requireScope("channels:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const adapters = channelRegistry.list();
		const results = await Promise.all(
			adapters.map(async (a) => {
				const creds = await resolveCredentialsFor(
					ctx.userId,
					ctx.organizationId,
					a.providerKey,
				);
				return {
					channel: a.channel,
					name: a.name,
					providerKey: a.providerKey,
					connected: !!creds,
				};
			}),
		);
		return c.json(ok(results));
	});

	app.post(
		"/channels/:channel/send",
		requireScope("channels:write"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			const channel = c.req.param("channel");
			if (!channel) {
				return c.json(badRequest("channel is required"), 400);
			}
			const adapter = channelRegistry.get(channel);
			if (!adapter) {
				return c.json(notFound(`Channel adapter "${channel}"`), 404);
			}

			let body: { channelId?: string; threadId?: string; text?: string };
			try {
				body = await c.req.json();
			} catch {
				return c.json(badRequest("Invalid JSON body"), 400);
			}
			if (!body.channelId || !body.text) {
				return c.json(
					badRequest("channelId and text are required"),
					400,
				);
			}

			const credentials = await resolveCredentialsFor(
				ctx.userId,
				ctx.organizationId,
				adapter.providerKey,
			);
			if (!credentials) {
				return c.json(
					{
						error: {
							message: `No active ${adapter.name} integration is connected for this tenant.`,
						},
					},
					400,
				);
			}

			const result = await adapter.send(
				{
					channelId: body.channelId,
					threadId: body.threadId,
					text: body.text,
				},
				{
					credentials,
					tenantId: ctx.organizationId
						? `org:${ctx.organizationId}`
						: `user:${ctx.userId}`,
				},
			);
			return c.json(ok(result));
		},
	);
}
