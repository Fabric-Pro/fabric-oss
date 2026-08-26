import { NextResponse } from "next/server";

/**
 * Prometheus Metrics Endpoint
 * Exposes metrics in Prometheus text format for the Prometheus scraper.
 *
 * Auth model (SOC 2 CC6.1):
 * - When `METRICS_SECRET` is set, a matching `Authorization: Bearer <secret>`
 *   header is required.
 * - When `METRICS_SECRET` is unset, the endpoint FAILS CLOSED in production —
 *   it returns 404 (so it isn't advertised) rather than serving metrics to the
 *   internet. Network-layer restrictions (Bicep ingress) only protect the Azure
 *   Container App, NOT the internet-facing Vercel route, so the code must gate
 *   it. Set `METRICS_SECRET` (and provide it to the scraper) to expose metrics
 *   in production. Development leaves it open for convenience.
 */
export async function GET(request: Request) {
	const metricsSecret = process.env.METRICS_SECRET;
	if (metricsSecret) {
		const authHeader = request.headers.get("authorization");
		if (authHeader !== `Bearer ${metricsSecret}`) {
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		}
	} else if (process.env.NODE_ENV === "production") {
		// Fail closed: no secret configured in production → do not expose
		// metrics publicly. 404 avoids advertising that the endpoint exists.
		return new NextResponse(null, { status: 404 });
	}

	try {
		// Dynamic import to avoid Turbopack bundling issues with OpenTelemetry
		const { register } = await import("@repo/observability");
		const metrics = await register.metrics();

		return new NextResponse(metrics, {
			headers: {
				"Content-Type": register.contentType,
			},
		});
	} catch (error) {
		console.error("Error collecting metrics:", error);
		return NextResponse.json(
			{
				error: "Failed to collect metrics",
			},
			{ status: 500 },
		);
	}
}
