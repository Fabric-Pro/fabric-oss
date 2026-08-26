/**
 * Shared primitives for the room-scoped "live" JWTs behind
 * /api/orchestrator/{token,verify} and /api/task-agent/{token,verify}.
 *
 * Each pair has to agree on three things — the audience, the signing secret and
 * the lifetime. While those were declared once per route, a one-sided edit to
 * either half would have 401'd every token in flight, so they live here now.
 *
 * Deliberately free of `@repo/temporal` and `@repo/database` imports: the
 * task-agent routes never touch Temporal, and this module sits on their hot
 * path. Orchestrator-specific ownership logic lives in ./orchestrator-access.
 */

import { checkRateLimit } from "@repo/api/lib/rate-limit";
import { type JWTPayload, jwtVerify, SignJWT } from "jose";

/**
 * Token lifetime. Both advertised to the client as `expiresIn` and signed into
 * `exp` from this one constant, so the two can never drift apart.
 */
const LIVE_TOKEN_TTL_SECONDS = 600;

/**
 * Audience pins a token to one subscribe path: an orchestrator, task-agent or
 * collab token can never be replayed against a sibling surface.
 */
export const ORCHESTRATOR_TOKEN_AUDIENCE = "orchestrator-live";
export const TASK_AGENT_TOKEN_AUDIENCE = "task-agent-live";

/** Orchestrator execution IDs, as minted by the workflow start path. */
export const EXECUTION_ID_PATTERN = /^orch-[a-f0-9-]{36}$/;

/**
 * Every reconnect fetches a fresh token, so the budget is well above the
 * bounded retry schedules in useOrchestratorPartyKit / useTaskAgentPartyKit.
 */
const LIVE_RATE_LIMIT = { limit: 60, windowMs: 60_000 };

let cachedKey: { secret: string; key: Uint8Array } | null = null;

/**
 * The HMAC key for live tokens, encoded once per distinct secret value.
 *
 * Keyed by the current env value rather than memoised outright: a rotated
 * COLLAB_JWT_SECRET takes effect on the next request, and per-test env stubs
 * are not leaked between suites.
 *
 * Returns null when the secret is unset — callers own that 500 so each route
 * keeps its own log tag.
 */
export function getLiveTokenSecretKey(): Uint8Array | null {
	const secret = process.env.COLLAB_JWT_SECRET;
	if (!secret) {
		return null;
	}

	if (cachedKey?.secret !== secret) {
		cachedKey = { secret, key: new TextEncoder().encode(secret) };
	}

	return cachedKey.key;
}

/**
 * Applies the shared live-room rate limit. Returns the 429 to send back, or
 * null when the caller is within budget.
 *
 * `requestLabel` names the thing being limited ("token", "verification") and
 * only reaches the human-readable message.
 */
export async function checkLiveRateLimit(
	key: string,
	requestLabel: string,
): Promise<Response | null> {
	const result = await checkRateLimit(
		key,
		LIVE_RATE_LIMIT.limit,
		LIVE_RATE_LIMIT.windowMs,
	);

	if (result.allowed) {
		return null;
	}

	return Response.json(
		{
			error: "Rate limit exceeded",
			message: `Too many ${requestLabel} requests. Please try again in ${result.resetInSeconds} seconds.`,
			retryAfter: result.resetInSeconds,
		},
		{
			status: 429,
			headers: {
				"Retry-After": result.resetInSeconds.toString(),
			},
		},
	);
}

/**
 * Signs a room-scoped token and returns the `{ token, expiresIn }` body both
 * client hooks expect.
 */
export async function mintLiveToken(
	claims: JWTPayload,
	options: { audience: string; secretKey: Uint8Array },
): Promise<Response> {
	const token = await new SignJWT(claims)
		.setProtectedHeader({ alg: "HS256" })
		.setAudience(options.audience)
		.setIssuedAt()
		.setExpirationTime(`${LIVE_TOKEN_TTL_SECONDS}s`)
		.sign(options.secretKey);

	return Response.json({
		token,
		expiresIn: LIVE_TOKEN_TTL_SECONDS,
	});
}

export type LiveBearerResult =
	| { ok: true; userId: string; resourceId: string }
	| { ok: false; response: Response };

/**
 * The shared front half of both verify routes: pull the bearer token, verify it
 * against the pinned algorithm and audience, then confirm the claim shape.
 *
 * There is no session on this path — the bearer token *is* the credential — so
 * it is checked before the request body is read and before any database or
 * Temporal work happens.
 *
 * `resourceClaim` names the claim carrying the room this token authorizes; the
 * caller binds it to the request body afterwards.
 */
export async function verifyLiveBearerToken(
	req: Request,
	options: {
		audience: string;
		resourceClaim: "executionId" | "planId";
		logPrefix: string;
	},
): Promise<LiveBearerResult> {
	const authHeader = req.headers.get("authorization");
	const token = authHeader?.replace("Bearer ", "");

	if (!token) {
		return {
			ok: false,
			response: Response.json(
				{ error: "No token provided" },
				{ status: 401 },
			),
		};
	}

	const secretKey = getLiveTokenSecretKey();
	if (!secretKey) {
		console.error(`${options.logPrefix} COLLAB_JWT_SECRET not configured`);
		return {
			ok: false,
			response: Response.json(
				{ error: "Server configuration error" },
				{ status: 500 },
			),
		};
	}

	let payload: JWTPayload;
	try {
		// Pinning the algorithm and the audience is what keeps a collab or
		// sibling live token from being replayed against this surface.
		({ payload } = await jwtVerify(token, secretKey, {
			algorithms: ["HS256"],
			audience: options.audience,
		}));
	} catch (jwtError) {
		console.error(
			`${options.logPrefix} JWT verification failed:`,
			jwtError,
		);
		return {
			ok: false,
			response: Response.json(
				{ error: "Invalid token" },
				{ status: 401 },
			),
		};
	}

	const userId = payload.userId;
	const resourceId = payload[options.resourceClaim];

	if (
		typeof userId !== "string" ||
		userId.length === 0 ||
		typeof resourceId !== "string" ||
		resourceId.length === 0
	) {
		return {
			ok: false,
			response: Response.json(
				{ error: "Invalid token payload" },
				{ status: 401 },
			),
		};
	}

	return { ok: true, userId, resourceId };
}
