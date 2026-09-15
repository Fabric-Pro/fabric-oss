/**
 * Success-metric webhook ingress (plan Slice 8).
 *
 * POST /api/metrics/webhook/:metricId
 *   Authorization: Bearer <secret>
 *   { "value": number, "observedAt"?: ISO-8601 string }
 *
 * AUTHENTICATION — bearer token, not HMAC. The database keeps only
 * `sha256(secret)` (`ProjectSuccessMetric.webhookSecretHash`), so the server
 * cannot recompute an HMAC over the body; instead the caller presents the
 * secret itself and the route compares `sha256(presented)` with the stored
 * hash in constant time (see packages/api/lib/metric-secrets.ts). TLS
 * protects the token in flight, as it does for any API key.
 *
 * Properties:
 *   - Public (no session). Tenant-safe by construction: the row is addressed
 *     by metricId and unlocked only by its own secret; nothing else is read.
 *   - Uniform 401 — the response for an unknown metricId, a MANUAL metric, a
 *     missing header and a wrong secret is byte-identical, and the hash is
 *     computed on every attempt so timing does not reveal existence.
 *   - Rate-limited per metricId (Redis in production, in-memory fallback).
 *   - `value` must be a finite number; `observedAt` may not be in the future.
 *   - The secret is never logged.
 */
import {
	extractBearerToken,
	hashMetricWebhookSecret,
	verifyMetricWebhookSecret,
} from "@repo/api/lib/metric-secrets";
import { checkRateLimit } from "@repo/api/lib/rate-limit";
import { db } from "@repo/database";
import type { NextRequest } from "next/server";
import { z } from "zod";

export const METRIC_WEBHOOK_RATE_LIMIT = {
	limit: 60,
	windowMs: 60_000,
} as const;

/** Compared against when no real hash exists, so the work done is constant. */
const DUMMY_HASH = hashMetricWebhookSecret("fabric-metric-webhook-dummy");

const bodySchema = z.object({
	value: z.number().finite(),
	observedAt: z.string().datetime({ offset: true }).optional(),
});

function json(
	status: number,
	body: Record<string, unknown>,
	headers?: Record<string, string>,
) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

const UNAUTHORIZED = () => json(401, { error: "Unauthorized" });

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ metricId: string }> },
) {
	const { metricId } = await params;
	if (!metricId || metricId.length > 64) {
		return UNAUTHORIZED();
	}

	const rate = await checkRateLimit(
		`metric-webhook:${metricId}`,
		METRIC_WEBHOOK_RATE_LIMIT.limit,
		METRIC_WEBHOOK_RATE_LIMIT.windowMs,
	);
	if (!rate.allowed) {
		if (rate.statusCode === 503) {
			return json(503, { error: "Rate limit service unavailable" });
		}
		return json(
			429,
			{ error: "Too many requests", retryAfter: rate.resetInSeconds },
			{ "Retry-After": String(rate.resetInSeconds) },
		);
	}

	const presented = extractBearerToken(request.headers.get("authorization"));

	const metric = await db.projectSuccessMetric.findUnique({
		where: { id: metricId },
		select: {
			id: true,
			sourceKind: true,
			webhookSecretHash: true,
			lastValue: true,
		},
	});
	const storedHash =
		metric?.sourceKind === "WEBHOOK" ? metric.webhookSecretHash : null;
	// Always run the comparison so the response time is the same whether or
	// not the metric exists; the result is only trusted when a real hash was used.
	const matches = verifyMetricWebhookSecret(
		presented,
		storedHash ?? DUMMY_HASH,
	);
	if (!metric || !storedHash || !matches) {
		return UNAUTHORIZED();
	}

	let parsedBody: z.infer<typeof bodySchema>;
	try {
		const raw: unknown = JSON.parse(await request.text());
		const result = bodySchema.safeParse(raw);
		if (!result.success) {
			return json(400, {
				error: "Invalid body",
				message:
					"Expected { value: finite number, observedAt?: ISO-8601 }",
			});
		}
		parsedBody = result.data;
	} catch {
		return json(400, {
			error: "Invalid body",
			message: "Body must be JSON",
		});
	}

	const observedAt = parsedBody.observedAt
		? new Date(parsedBody.observedAt)
		: new Date();
	if (observedAt.getTime() > Date.now() + 5 * 60_000) {
		return json(400, {
			error: "Invalid body",
			message: "observedAt cannot be in the future",
		});
	}

	const updated = await db.projectSuccessMetric.update({
		where: { id: metric.id },
		data: {
			previousValue: metric.lastValue,
			lastValue: parsedBody.value,
			lastObservedAt: observedAt,
		},
		select: {
			id: true,
			lastValue: true,
			previousValue: true,
			lastObservedAt: true,
		},
	});

	return json(200, {
		ok: true,
		metricId: updated.id,
		lastValue: updated.lastValue,
		previousValue: updated.previousValue,
		lastObservedAt: updated.lastObservedAt?.toISOString() ?? null,
	});
}
