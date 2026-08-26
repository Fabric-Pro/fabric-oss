/**
 * Liveness check. Answers one question — "is this process up and routing?" — and
 * deliberately checks no dependency.
 *
 * **Do not make this dependency-aware.** This path is the Kubernetes liveness
 * probe AND readiness probe (`deploy/helm/fabric/templates/platform/web.yaml`),
 * the ALB `healthcheck-path`, the container `HEALTHCHECK`, the CI smoke gate, and
 * the external uptime monitor. If it failed when Postgres were unreachable, a
 * transient database blip would trip liveness three times in a minute and
 * Kubernetes would kill every web pod, while the ALB drained every target at the
 * same time — converting a degraded-but-serving app into a hard outage, caused by
 * the check meant to report on it.
 *
 * Dependency questions belong to `/api/health/ready`, which nothing probes.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return NextResponse.json(
		{
			status: "healthy",
			timestamp: new Date().toISOString(),
			service: "fabric-web",
		},
		{ status: 200 },
	);
}
