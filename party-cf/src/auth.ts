import type { Env } from "./env";

// The expected secret is constant for the life of an isolate, but publish —
// the hottest path here, one HTTP call per broadcast event from Temporal —
// would otherwise re-hash it on every request. Memoized on the secret string
// so a changed env (tests, dev reloads) recomputes instead of comparing
// against a stale digest.
let cachedSecret: string | undefined;
let cachedSecretDigest: Uint8Array | undefined;

async function sha256(value: string): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return new Uint8Array(digest);
}

async function expectedDigest(expected: string): Promise<Uint8Array> {
	if (cachedSecretDigest && cachedSecret === expected) {
		return cachedSecretDigest;
	}

	const digest = await sha256(expected);
	cachedSecret = expected;
	cachedSecretDigest = digest;
	return digest;
}

/**
 * Timing-independent comparison of a caller-supplied secret against the
 * expected one.
 *
 * Comparing raw strings byte-by-byte still leaks their length, and an early
 * length check leaks it outright. Hashing both sides first means the comparison
 * always runs over 32 fixed-length bytes whatever the inputs were, so neither
 * length nor content is observable in the timing. Caching the expected side's
 * digest does not weaken that — the loop still walks both digests in full.
 */
async function secretsMatch(
	candidate: string,
	expected: string,
): Promise<boolean> {
	const [candidateDigest, knownDigest] = await Promise.all([
		sha256(candidate),
		expectedDigest(expected),
	]);

	let mismatch = candidateDigest.length ^ knownDigest.length;
	for (let i = 0; i < candidateDigest.length; i++) {
		mismatch |= (candidateDigest[i] ?? 0) ^ (knownDigest[i] ?? 0);
	}

	return mismatch === 0;
}

/**
 * Authorizes the service-to-service surface of the orchestrator/task-agent
 * rooms: publish (Temporal activities), room cleanup, and room status.
 *
 * An unset AGENT_SERVICE_SECRET is a misconfiguration, not an open door — in
 * production it denies. The previous inline check interpolated an unset secret
 * into the expected header, so a caller sending literally `Bearer undefined`
 * was accepted by an unconfigured worker. Dev stays permissive only while no
 * secret is configured at all.
 */
async function isServiceRequestAuthorized(
	env: Env,
	authHeader: string | null,
): Promise<boolean> {
	const isDev = env.PARTYKIT_ENV !== "production";
	const expectedSecret = env.AGENT_SERVICE_SECRET;

	if (!expectedSecret) {
		return isDev;
	}

	return secretsMatch(authHeader ?? "", `Bearer ${expectedSecret}`);
}

/**
 * Gate for the service-to-service surface: returns the 401 to send back when
 * the caller is not authorized, or null when the request may proceed.
 */
export async function requireServiceAuth(
	env: Env,
	authHeader: string | null,
): Promise<Response | null> {
	if (await isServiceRequestAuthorized(env, authHeader)) {
		return null;
	}

	return Response.json({ error: "Unauthorized" }, { status: 401 });
}

export type VerifiedPayload = Record<string, unknown> & { userId: string };

/**
 * Verifies a client's scoped JWT against a Fabric verify route, returning the
 * verified payload or null if the room must stay closed.
 *
 * Every failure mode — no FABRIC_API_URL, a non-2xx, an unparseable body, a
 * network error — collapses to null, because the only safe answer to "I could
 * not establish who this is" is to deny. Only an explicit
 * `{ valid: true, userId }` is accepted: a 2xx with any other shape (a proxy's
 * HTML error page, a partial payload) must not open the room.
 */
export async function verifyWithFabric(
	env: Env,
	{
		token,
		path,
		body,
		logTag,
	}: {
		token: string;
		path: string;
		body: Record<string, unknown>;
		logTag: string;
	},
): Promise<VerifiedPayload | null> {
	const apiUrl = env.FABRIC_API_URL;
	if (!apiUrl) {
		console.error(`${logTag} FABRIC_API_URL not configured`);
		return null;
	}

	try {
		const response = await fetch(`${apiUrl}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			console.warn(
				`${logTag} Token verification failed:`,
				response.status,
			);
			return null;
		}

		const data = (await response.json()) as Record<string, unknown>;
		if (
			data.valid !== true ||
			typeof data.userId !== "string" ||
			data.userId.length === 0
		) {
			console.warn(
				`${logTag} Token verification returned an unusable payload`,
			);
			return null;
		}

		return { ...data, userId: data.userId };
	} catch (error) {
		console.error(`${logTag} Token verification error:`, error);
		return null;
	}
}
