/**
 * Dependency-aware health check, for operators and uptime tooling that wants to
 * know whether the app can actually *serve* — not merely whether the process is
 * up.
 *
 * WHY THIS IS A SEPARATE ENDPOINT, AND WHY `/api/health` MUST STAY SHALLOW
 *
 * `/api/health` is wired to more than it looks: it is the Kubernetes **liveness**
 * probe AND the **readiness** probe (`deploy/helm/fabric/templates/platform/
 * web.yaml`), the ALB `healthcheck-path`, the container `HEALTHCHECK`, the CI
 * smoke gate, and the external uptime monitor. Teaching *that* endpoint to fail
 * when Postgres is unreachable would mean a transient database blip trips the
 * liveness probe three times in a minute and Kubernetes **kills every web pod**,
 * while the ALB simultaneously drains every target. A degraded-but-serving app
 * would be converted into a hard outage by the very check meant to report on it.
 * So the shallow endpoint is correct for its job — "this process is alive and
 * routing" — and this one carries the dependency questions instead.
 *
 * Nothing probes this route. It is deliberately not referenced by any manifest;
 * pointing a *readiness* probe here would be defensible (readiness only removes a
 * pod from the load balancer, it does not restart it), but that is an
 * infrastructure decision with a blast radius, not a code change to make in
 * passing.
 *
 * Always returns a body describing every check. HTTP status is 200 when
 * everything passed and 503 when anything failed, so a dumb checker can use the
 * status and a human can read the detail.
 */

import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Cap on each check. Kept below the probe timeouts on `/api/health` (5s) so this
 * endpoint answers rather than hanging — a health check that hangs is
 * indistinguishable from the outage it is trying to describe.
 */
const CHECK_TIMEOUT_MS = 3_000;

type CheckResult = {
	name: string;
	ok: boolean;
	durationMs: number;
	error?: string;
};

async function runCheck(
	name: string,
	check: () => Promise<unknown>,
): Promise<CheckResult> {
	const startedAt = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			check(),
			new Promise((_resolve, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`),
						),
					CHECK_TIMEOUT_MS,
				);
			}),
		]);
		return { name, ok: true, durationMs: Date.now() - startedAt };
	} catch (error) {
		return {
			name,
			ok: false,
			durationMs: Date.now() - startedAt,
			// The message only — a stack trace on an unauthenticated endpoint
			// would leak connection strings and internal hostnames.
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function GET() {
	const checks = await Promise.all([
		runCheck("database", () => db.$queryRaw`SELECT 1`),
	]);

	const ok = checks.every((check) => check.ok);

	if (!ok) {
		logger.warn(
			{
				event: "health.ready.degraded",
				failed: checks.filter((c) => !c.ok).map((c) => c.name),
			},
			"Dependency health check failed",
		);
	}

	return NextResponse.json(
		{
			status: ok ? "ready" : "degraded",
			timestamp: new Date().toISOString(),
			service: "fabric-web",
			checks,
		},
		{ status: ok ? 200 : 503 },
	);
}
