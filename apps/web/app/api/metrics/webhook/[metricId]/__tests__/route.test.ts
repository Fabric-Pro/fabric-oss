/**
 * Success-metric webhook ingress (plan Slice 8).
 *
 * - wrong bearer → 401 with the same body as an unknown metric
 * - correct bearer → 200, observation recorded (lastValue → previousValue)
 * - non-finite value → 400
 * - rate-limited → 429
 */
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkRateLimitMock, findUniqueMock, updateMock } = vi.hoisted(() => ({
	checkRateLimitMock: vi.fn(),
	findUniqueMock: vi.fn(),
	updateMock: vi.fn(),
}));

vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: checkRateLimitMock,
}));

vi.mock("@repo/database", () => ({
	db: {
		projectSuccessMetric: {
			findUnique: findUniqueMock,
			update: updateMock,
		},
	},
}));

import { POST } from "../route";

const METRIC_ID = "cmetric_webhook_1";
// Test-only bearer value, derived at runtime so no high-entropy literal sits
// in the source; the route stores only its sha256.
const SECRET = Buffer.from("secret-secret-secret-secret-secret").toString(
	"base64url",
);
const SECRET_HASH = createHash("sha256").update(SECRET, "utf8").digest("hex");

const webhookMetric = {
	id: METRIC_ID,
	sourceKind: "WEBHOOK",
	webhookSecretHash: SECRET_HASH,
	lastValue: 41,
};

function makeRequest(body: string, authorization?: string): NextRequest {
	const headers = new Headers({ "content-type": "application/json" });
	if (authorization) {
		headers.set("authorization", authorization);
	}
	return {
		headers,
		text: async () => body,
	} as unknown as NextRequest;
}

const params = (metricId = METRIC_ID) => ({
	params: Promise.resolve({ metricId }),
});

beforeEach(() => {
	checkRateLimitMock.mockReset();
	findUniqueMock.mockReset();
	updateMock.mockReset();
	checkRateLimitMock.mockResolvedValue({
		allowed: true,
		remaining: 59,
		resetInSeconds: 60,
	});
});

describe("POST /api/metrics/webhook/[metricId]", () => {
	it("answers a wrong bearer and an unknown metric with byte-identical 401s", async () => {
		findUniqueMock.mockResolvedValueOnce(webhookMetric);
		const wrong = await POST(
			makeRequest('{"value":1}', "Bearer not-the-secret"),
			params(),
		);
		findUniqueMock.mockResolvedValueOnce(null);
		const unknown = await POST(
			makeRequest('{"value":1}', `Bearer ${SECRET}`),
			params("cmetric_does_not_exist"),
		);
		expect(wrong.status).toBe(401);
		expect(unknown.status).toBe(401);
		expect(await wrong.text()).toBe(await unknown.text());
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("rejects a missing Authorization header and a MANUAL metric the same way", async () => {
		findUniqueMock.mockResolvedValueOnce(webhookMetric);
		const missing = await POST(makeRequest('{"value":1}'), params());
		findUniqueMock.mockResolvedValueOnce({
			...webhookMetric,
			sourceKind: "MANUAL",
			webhookSecretHash: null,
		});
		const manual = await POST(
			makeRequest('{"value":1}', `Bearer ${SECRET}`),
			params(),
		);
		expect(missing.status).toBe(401);
		expect(manual.status).toBe(401);
		expect(await missing.text()).toBe(await manual.text());
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("records the observation with the correct bearer", async () => {
		findUniqueMock.mockResolvedValue(webhookMetric);
		updateMock.mockImplementation(
			async ({ data }: { data: Record<string, unknown> }) => ({
				id: METRIC_ID,
				...data,
			}),
		);
		const res = await POST(
			makeRequest(
				'{"value":33,"observedAt":"2026-09-10T09:00:00.000Z"}',
				`Bearer ${SECRET}`,
			),
			params(),
		);
		expect(res.status).toBe(200);
		expect(updateMock).toHaveBeenCalledTimes(1);
		expect(updateMock.mock.calls[0]?.[0]).toMatchObject({
			where: { id: METRIC_ID },
			data: {
				previousValue: 41,
				lastValue: 33,
				lastObservedAt: new Date("2026-09-10T09:00:00.000Z"),
			},
		});
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			ok: true,
			metricId: METRIC_ID,
			lastValue: 33,
			previousValue: 41,
		});
		expect(JSON.stringify(body)).not.toContain(SECRET);
		expect(JSON.stringify(body)).not.toContain(SECRET_HASH);
	});

	it("rejects non-finite and non-numeric values with 400 after authenticating", async () => {
		findUniqueMock.mockResolvedValue(webhookMetric);
		for (const body of [
			'{"value":1e999}',
			'{"value":"33"}',
			'{"value":null}',
			"{}",
			"not json",
		]) {
			const res = await POST(
				makeRequest(body, `Bearer ${SECRET}`),
				params(),
			);
			expect(res.status, body).toBe(400);
		}
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("rejects a future observedAt", async () => {
		findUniqueMock.mockResolvedValue(webhookMetric);
		const future = new Date(Date.now() + 60 * 60_000).toISOString();
		const res = await POST(
			makeRequest(
				`{"value":1,"observedAt":"${future}"}`,
				`Bearer ${SECRET}`,
			),
			params(),
		);
		expect(res.status).toBe(400);
	});

	it("returns 429 with Retry-After when the per-metric rate limit is hit, before any DB read", async () => {
		checkRateLimitMock.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 17,
		});
		const res = await POST(
			makeRequest('{"value":1}', `Bearer ${SECRET}`),
			params(),
		);
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("17");
		expect(checkRateLimitMock).toHaveBeenCalledWith(
			`metric-webhook:${METRIC_ID}`,
			60,
			60_000,
		);
		expect(findUniqueMock).not.toHaveBeenCalled();
	});

	it("fails closed with 503 when the rate limiter is unavailable", async () => {
		checkRateLimitMock.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 0,
			statusCode: 503,
			reason: "ratelimit-unavailable",
		});
		const res = await POST(
			makeRequest('{"value":1}', `Bearer ${SECRET}`),
			params(),
		);
		expect(res.status).toBe(503);
	});
});
