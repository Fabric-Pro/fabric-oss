/**
 * Generic synthetic probe activity.
 *
 * Replaces the five hand-coded `probeOpenAI` / `probeAnthropic` /
 * `probeStripe` / `probeResend` / `probeS3` activities with a single
 * data-driven implementation that reads its probe spec from the
 * integration-provider registry. Adding a new probed provider is now a
 * one-line registry change — no Temporal code edits required.
 *
 * Two execution paths are supported:
 *
 *   1. **Generic HTTP probe** — when the registry entry sets
 *      `syntheticProbe.url`. The runtime executes a single `fetch`
 *      wrapped in `withProviderBreaker` so probe failures count toward
 *      the same Cockatiel circuit as live traffic.
 *   2. **Client probe function** — when the registry entry sets
 *      `syntheticProbe.clientProbeFn`. Used for providers that don't
 *      have a clean HTTP-only liveness endpoint (currently only AWS S3
 *      via `s3-head-canary`). A small whitelist registry of probe
 *      bodies handles the SDK-level work.
 *
 * The activity NEVER throws — success/failure is returned as data so
 * the workflow's hysteresis logic stays a deterministic reducer over
 * counter state.
 */
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
	getRegistration,
	type SyntheticProbeConfig,
	withProviderBreaker,
} from "@repo/observability";
import {
	probeSecret,
	runProbe,
	type SyntheticProbeOutput,
} from "./synthetic-probe-shared";

/**
 * Required environment variables for each `clientProbeFn`. The runtime
 * checks these BEFORE the probe body executes — if any are unset we
 * return `{ notConfigured: true }` so the workflow records the provider
 * as `NOT_CONFIGURED` (gray badge) instead of `MAJOR_OUTAGE` (red).
 */
const CLIENT_PROBE_REQUIRED_ENV_VARS: Record<string, readonly string[]> = {
	"s3-head-canary": ["AWS_S3_BUCKET"],
};

/**
 * Whitelist of registered SDK probe functions. Keep this map small —
 * every entry is a hand-rolled path that must be kept in sync with the
 * relevant provider's SDK. Adding a new entry requires a code review.
 *
 * Required env-var checks happen in {@link CLIENT_PROBE_REQUIRED_ENV_VARS}
 * BEFORE we dispatch here, so probe bodies can assume their secrets are
 * present.
 */
const CLIENT_PROBE_FNS: Record<string, (providerKey: string) => Promise<void>> =
	{
		"s3-head-canary": async (providerKey: string) => {
			// Pre-flight env-var check has already validated AWS_S3_BUCKET.
			const bucket = probeSecret("AWS_S3_BUCKET");
			const region = probeSecret("AWS_S3_REGION") ?? "us-east-1";
			if (!bucket) {
				// Defensive: should never reach here because the
				// pre-flight returned NOT_CONFIGURED, but treat it as a
				// real probe failure if it somehow does.
				throw new Error("AWS_S3_BUCKET not configured");
			}
			const client = new S3Client({ region });
			await withProviderBreaker(providerKey, "head_bucket", async () => {
				await client.send(new HeadBucketCommand({ Bucket: bucket }));
			});
		},
	};

/**
 * Inspect the probe config and the environment to determine the list of
 * env vars whose absence should produce a `NOT_CONFIGURED` outcome (as
 * opposed to a real probe failure).
 *
 * For the generic HTTP path: `authHeaderEnvVar` (when set) plus any
 * `${ENV_VAR}` placeholders referenced from `headers`.
 *
 * For the client-probe path: the entries in
 * {@link CLIENT_PROBE_REQUIRED_ENV_VARS} for the chosen function.
 */
function findMissingRequiredEnvVars(probe: SyntheticProbeConfig): string[] {
	const required = new Set<string>();
	if (probe.clientProbeFn) {
		const vars = CLIENT_PROBE_REQUIRED_ENV_VARS[probe.clientProbeFn];
		if (vars) {
			for (const name of vars) {
				required.add(name);
			}
		}
	}
	if (probe.authHeaderEnvVar) {
		required.add(probe.authHeaderEnvVar);
	}
	if (probe.headers) {
		for (const value of Object.values(probe.headers)) {
			for (const match of value.matchAll(/\$\{([A-Z0-9_]+)\}/g)) {
				required.add(match[1]);
			}
		}
	}
	return [...required].filter((name) => !probeSecret(name));
}

/**
 * Substitute `${ENV_VAR}` placeholders in header values. Used so the
 * registry can carry header templates (e.g., the Anthropic
 * `x-api-key: ${ANTHROPIC_API_KEY}` convention) without literal secrets
 * in source. A placeholder whose env var is unset yields an empty
 * string — the probe's `expectedStatus` check will catch the resulting
 * 401/403 and the workflow will record a failure.
 */
function substituteEnvPlaceholders(
	headers: Record<string, string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		out[name] = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, varName) => {
			return process.env[varName] ?? "";
		});
	}
	return out;
}

/**
 * Build a `fetch` Headers object from the registry probe config.
 * Combines:
 *   - `headers` from the registry (with `${ENV_VAR}` substitution)
 *   - `Authorization: Bearer <env value>` when `authHeaderEnvVar` set
 *   - `Accept: application/json` as a sane default for JSON APIs
 */
function buildProbeHeaders(
	probe: SyntheticProbeConfig,
): { ok: true; headers: HeadersInit } | { ok: false; error: string } {
	const headers: Record<string, string> = {
		Accept: "application/json",
		...(probe.headers ? substituteEnvPlaceholders(probe.headers) : {}),
	};

	if (probe.authHeaderEnvVar) {
		const token = probeSecret(probe.authHeaderEnvVar);
		if (!token) {
			return {
				ok: false,
				error: `${probe.authHeaderEnvVar} not configured`,
			};
		}
		headers.Authorization = `Bearer ${token}`;
	}

	return { ok: true, headers };
}

/**
 * Execute the generic HTTP path of the probe.
 *
 * Wrapped in `withProviderBreaker` so probe failures count toward the
 * same Cockatiel circuit as live traffic — a synthetic probe tripping
 * the breaker is precisely the signal we want.
 */
async function executeHttpProbe(
	providerKey: string,
	probe: SyntheticProbeConfig,
): Promise<void> {
	if (!probe.url) {
		throw new Error("generic HTTP probe requires `url`");
	}
	const headersResult = buildProbeHeaders(probe);
	if (!headersResult.ok) {
		throw new Error(headersResult.error);
	}

	const method = probe.method ?? "GET";
	const expected = probe.expectedStatus ?? [200];

	await withProviderBreaker(providerKey, "synthetic_probe", async () => {
		const response = await fetch(probe.url!, {
			method,
			headers: headersResult.headers,
		});
		if (!expected.includes(response.status)) {
			throw new Error(
				`probe ${method} ${probe.url} returned HTTP ${response.status} ${response.statusText}; expected one of [${expected.join(", ")}]`,
			);
		}
	});
}

/**
 * Generic synthetic probe activity.
 *
 * Reads the probe spec from the integration-provider registry, runs
 * either the HTTP path or the client-probe path, and returns a
 * normalized {@link SyntheticProbeOutput}. NEVER throws.
 *
 * Unknown provider keys and missing probe config collapse to a
 * `failure` outcome with a descriptive `error` string so the workflow
 * can pass them through to `upsertIntegrationIncident` for the audit
 * log.
 *
 * **Missing required env vars** (e.g., `STRIPE_SECRET_KEY` unset on a
 * staging environment with no real Stripe credentials) are handled
 * separately: the activity returns `{ success: false, notConfigured:
 * true }` so the workflow records the provider as `NOT_CONFIGURED`
 * (neutral gray badge, no incident, no SEV-1 page). The provider
 * itself is not necessarily down — we just can't probe it from here.
 */
export async function runSyntheticProbe(
	providerKey: string,
): Promise<SyntheticProbeOutput> {
	const registration = getRegistration(providerKey);
	if (!registration) {
		return {
			success: false,
			latencyMs: 0,
			error: `provider "${providerKey}" not registered`,
		};
	}
	const probe = registration.syntheticProbe;
	if (!probe) {
		return {
			success: false,
			latencyMs: 0,
			error: `provider "${providerKey}" has no syntheticProbe config`,
		};
	}

	// Pre-flight: bail out cleanly when required env vars are missing.
	// This is the difference between "the provider is broken" (real
	// failure → incident) and "we have no creds to probe with in this
	// environment" (NOT_CONFIGURED → gray badge, no incident).
	const missingEnvVars = findMissingRequiredEnvVars(probe);
	if (missingEnvVars.length > 0) {
		return {
			success: false,
			latencyMs: 0,
			notConfigured: true,
			error: `Synthetic probe disabled — ${missingEnvVars.join(", ")} not set in this environment`,
		};
	}

	return runProbe(
		providerKey,
		async () => {
			// Client probe wins over generic HTTP when both are set —
			// the SDK path is the more accurate liveness check.
			if (probe.clientProbeFn) {
				const fn = CLIENT_PROBE_FNS[probe.clientProbeFn];
				if (!fn) {
					throw new Error(
						`unknown clientProbeFn: ${probe.clientProbeFn}`,
					);
				}
				await fn(providerKey);
				return;
			}
			await executeHttpProbe(providerKey, probe);
		},
		{ timeoutMs: probe.timeoutMs ?? 15_000 },
	);
}
