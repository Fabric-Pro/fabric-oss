import { createHmac } from "node:crypto";
import { logger } from "@repo/logs";
import { z } from "zod";

export type DecisionReplayEmbedResult =
	| { available: false; reason: "not_configured" | "unavailable" }
	| {
			available: true;
			token: string;
			expiresAt: string;
			instanceUrl: string;
			workspaceId: string;
			dashboardId: string;
	  };

const tokenSchema = z.object({
	access_token: z.string().min(1),
	expires_in: z.number().finite().positive().max(86400),
});
const infoSchema = z
	.object({
		authorization_details: z.union([
			z.array(z.unknown()),
			z.record(z.string(), z.unknown()),
		]),
	})
	.catchall(z.union([z.string(), z.number().finite(), z.boolean()]));
const configSchema = z.object({
	host: z.url(),
	workspaceId: z.string().trim().min(1),
	dashboardId: z.string().trim().min(1),
	clientId: z.string().trim().min(1),
	clientSecret: z
		.string()
		.min(1)
		.refine((v) => v.trim().length > 0),
});
let warnedNotConfigured = false;
let cached: { key: string; token: string; expiresAt: number } | undefined;
let inflight: { key: string; promise: Promise<string> } | undefined;

class EmbedFailure extends Error {
	constructor(readonly status: number) {
		super("Decision Replay embed unavailable");
	}
}

/** Response bodies and exceptions can contain credentials; log only status. */
async function request(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, {
		...init,
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new EmbedFailure(response.status);
	}
	try {
		return await response.json();
	} catch {
		throw new EmbedFailure(response.status);
	}
}

/** Process-local service token; scoped viewer tokens are minted per request. */
export async function getDecisionReplayEmbedToken(input: {
	projectId: string;
	userId: string;
}): Promise<DecisionReplayEmbedResult> {
	const parsed = configSchema.safeParse({
		host: process.env.DECISION_REPLAY_DATABRICKS_HOST,
		workspaceId: process.env.DECISION_REPLAY_DATABRICKS_WORKSPACE_ID,
		dashboardId: process.env.DECISION_REPLAY_DASHBOARD_ID,
		clientId: process.env.DECISION_REPLAY_EMBED_CLIENT_ID,
		clientSecret: process.env.DECISION_REPLAY_EMBED_CLIENT_SECRET,
	});
	let config = parsed.success ? parsed.data : undefined;
	if (config) {
		const url = new URL(config.host);
		if (
			url.protocol !== "https:" ||
			url.pathname !== "/" ||
			url.search ||
			url.hash ||
			url.username ||
			url.password
		) {
			config = undefined;
		} else {
			config.host = url.origin;
		}
	}
	if (!config) {
		if (!warnedNotConfigured) {
			warnedNotConfigured = true;
			logger.warn("Decision Replay embed not configured");
		}
		return { available: false, reason: "not_configured" };
	}
	const { host, workspaceId, dashboardId, clientId, clientSecret } = config;
	try {
		const viewerId = createHmac("sha256", clientSecret)
			.update(input.userId)
			.digest("hex")
			.slice(0, 32);
		if (
			!input.projectId ||
			Buffer.byteLength(input.projectId + viewerId, "utf8") >= 1024
		) {
			throw new EmbedFailure(0);
		}
		const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
		const tokenUrl = new URL("/oidc/v1/token", host);
		tokenUrl.searchParams.set("o", workspaceId);
		const exchange = async (params: URLSearchParams) =>
			tokenSchema.parse(
				await request(tokenUrl.toString(), {
					method: "POST",
					headers: {
						Authorization: basic,
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: params,
				}),
			);
		// Hash the credential identity so rotation cannot reuse another principal's cache.
		const key = createHmac("sha256", clientSecret)
			.update(JSON.stringify([host, workspaceId, clientId]))
			.digest("hex");
		let serviceToken: string;
		if (cached?.key === key && Date.now() < cached.expiresAt - 300_000) {
			serviceToken = cached.token;
		} else {
			if (inflight?.key !== key) {
				const promise = (async () => {
					const startedAt = Date.now();
					const token = await exchange(
						new URLSearchParams({
							grant_type: "client_credentials",
							scope: "all-apis",
						}),
					);
					cached = {
						key,
						token: token.access_token,
						expiresAt: startedAt + token.expires_in * 1000,
					};
					return token.access_token;
				})();
				inflight = { key, promise };
				void promise
					.finally(() => {
						if (inflight?.promise === promise) {
							inflight = undefined;
						}
					})
					.catch(() => {});
			}
			serviceToken = await inflight.promise;
		}
		const infoUrl = new URL(
			`/api/2.0/lakeview/dashboards/${encodeURIComponent(dashboardId)}/published/tokeninfo`,
			host,
		);
		infoUrl.search = new URLSearchParams({
			o: workspaceId,
			external_viewer_id: viewerId,
			external_value: input.projectId,
		}).toString();
		const { authorization_details, ...params } = infoSchema.parse(
			await request(infoUrl.toString(), {
				method: "GET",
				headers: { Authorization: `Bearer ${serviceToken}` },
			}),
		);
		const form = new URLSearchParams(
			Object.entries(params).map(([key, value]) => [key, String(value)]),
		);
		form.set("grant_type", "client_credentials");
		form.set(
			"authorization_details",
			JSON.stringify(authorization_details),
		);
		const startedAt = Date.now();
		const scoped = await exchange(form);
		return {
			available: true,
			token: scoped.access_token,
			expiresAt: new Date(
				startedAt + scoped.expires_in * 1000,
			).toISOString(),
			instanceUrl: host,
			workspaceId,
			dashboardId,
		};
	} catch (error) {
		logger.warn("Decision Replay embed unavailable", {
			status: error instanceof EmbedFailure ? error.status : 0,
		});
		return { available: false, reason: "unavailable" };
	}
}
