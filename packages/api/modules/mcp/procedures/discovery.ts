import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

// Simple in-memory rate limit: per-user, per 5 seconds.
// This is intentionally lightweight and best-effort; production deployments
// should use a shared rate limiter (Redis, etc.).
const lastDiscoveryCallByUser = new Map<string, number>();

const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_MIN_INTERVAL_MS = 5_000;

export const discoveryProcedures = {
	fetchOpenIdConfiguration: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_READ))
		.route({
			method: "POST",
			path: "/mcp/discovery/openid-configuration",
			tags: ["MCP"],
			summary:
				"Fetch OpenID Connect discovery document and key endpoints",
		})
		.input(
			z.object({
				discoveryUrl: z.string().url(),
			}),
		)
		.output(
			z.object({
				issuer: z.string(),
				authorizationEndpoint: z.string().url().optional(),
				tokenEndpoint: z.string().url().optional(),
				registrationEndpoint: z.string().url().optional(),
				// Raw metadata for debugging\/advanced usage
				metadata: z.record(z.string(), z.unknown()).optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const now = Date.now();

			const url = new URL(input.discoveryUrl);
			if (url.protocol !== "https:") {
				throw new ORPCError("BAD_REQUEST", {
					message: "Discovery URL must use HTTPS",
				});
			}

			const lastCall = lastDiscoveryCallByUser.get(userId) ?? 0;
			if (now - lastCall < DISCOVERY_MIN_INTERVAL_MS) {
				throw new ORPCError("TOO_MANY_REQUESTS", {
					message: "Please wait before calling discovery again",
				});
			}
			lastDiscoveryCallByUser.set(userId, now);

			const controller = new AbortController();
			const timeoutId = setTimeout(
				() => controller.abort(),
				DISCOVERY_TIMEOUT_MS,
			);

			try {
				const res = await fetch(input.discoveryUrl, {
					method: "GET",
					headers: {
						accept: "application/json",
					},
					signal: controller.signal,
				});

				if (!res.ok) {
					throw new ORPCError("BAD_REQUEST", {
						message: `Discovery endpoint returned HTTP ${res.status}`,
					});
				}

				const json = (await res.json().catch(() => null as any)) as any;
				if (!json || typeof json !== "object") {
					throw new ORPCError("BAD_REQUEST", {
						message: "Discovery document is not valid JSON",
					});
				}

				const issuer =
					(json.issuer as string | undefined) ?? input.discoveryUrl;
				const authorizationEndpoint = json.authorization_endpoint as
					| string
					| undefined;
				const tokenEndpoint = json.token_endpoint as string | undefined;
				const registrationEndpoint = json.registration_endpoint as
					| string
					| undefined;

				return {
					issuer,
					authorizationEndpoint,
					tokenEndpoint,
					registrationEndpoint,
					metadata: json,
				};
			} catch (err: any) {
				if (err?.name === "AbortError") {
					throw new ORPCError("BAD_REQUEST", {
						message: "Discovery request timed out",
					});
				}

				if (err instanceof ORPCError) {
					throw err;
				}

				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message:
						err?.message ||
						"Unexpected error while fetching OpenID Connect discovery document",
				});
			} finally {
				clearTimeout(timeoutId);
			}
		}),
};
