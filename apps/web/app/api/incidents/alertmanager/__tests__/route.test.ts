/**
 * Tests for the alertmanager webhook receiver at /api/incidents/alertmanager.
 *
 * Coverage:
 *   - Auth: rejects requests without a valid Bearer secret when the env var
 *     is set; accepts unauthenticated POSTs in dev (no env var).
 *   - kind="component", status="firing" → calls upsertComponentIncident
 *     with the expected payload + returns 200.
 *   - kind="component", status="resolved" → calls closeComponentIncident.
 *   - kind="component" with missing labels.component_key → 200 with
 *     accepted: false + error message (per-alert, doesn't fail the batch).
 *   - kind="integration" → 200, accepted but not handled: the Temporal poller
 *     genuinely owns those rows (upsert-/close-integration-incident), so writing
 *     them here too would double-handle the same alert.
 *   - kind="errorRate" → 200, HANDLED. Nothing owned this: Temporal only prunes
 *     ErrorRateIncident, so every burn-rate alert used to be acknowledged and
 *     discarded while the table stayed permanently empty.
 *   - Alertmanager batch shape ({ alerts: [...] }) is unwrapped correctly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { upsertMock, closeMock, alertmanagerUpsertMock } = vi.hoisted(() => ({
	upsertMock: vi.fn(),
	closeMock: vi.fn(),
	alertmanagerUpsertMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	upsertComponentIncident: (...args: unknown[]) => upsertMock(...args),
	closeComponentIncident: (...args: unknown[]) => closeMock(...args),
	upsertAlertmanagerIncident: (...args: unknown[]) =>
		alertmanagerUpsertMock(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

import { POST } from "../route";

function makeRequest(body: unknown, options?: { secret?: string }): Request {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (options?.secret) {
		headers.authorization = `Bearer ${options.secret}`;
	}
	return new Request("http://localhost/api/incidents/alertmanager", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	}) as unknown as Request;
}

const originalSecret = process.env.ALERTMANAGER_WEBHOOK_SECRET;

beforeEach(() => {
	upsertMock.mockReset();
	closeMock.mockReset();
	// Reset alongside the others — the file's convention is per-test isolation,
	// and a retained call made the no-fingerprint refusal test read as a pass
	// through the previous test's write.
	alertmanagerUpsertMock.mockReset();
	upsertMock.mockResolvedValue({
		incidentId: "ci-1",
		wasNew: true,
	});
	closeMock.mockResolvedValue({
		id: "ci-1",
		status: "RESOLVED",
	});
});

afterEach(() => {
	// Restore env between tests.
	if (originalSecret === undefined) {
		delete process.env.ALERTMANAGER_WEBHOOK_SECRET;
	} else {
		process.env.ALERTMANAGER_WEBHOOK_SECRET = originalSecret;
	}
});

describe("POST /api/incidents/alertmanager — auth", () => {
	it("accepts unauthenticated POSTs when ALERTMANAGER_WEBHOOK_SECRET is unset (dev bypass)", async () => {
		delete process.env.ALERTMANAGER_WEBHOOK_SECRET;
		const res = await POST(
			makeRequest({
				kind: "component",
				status: "firing",
				labels: {
					component_key: "temporal-worker",
					component_name: "Temporal Worker",
					severity: "sev1",
				},
				annotations: { summary: "worker stalled" },
			}) as never,
		);
		expect(res.status).toBe(200);
	});

	it("rejects unauthenticated POSTs when the secret is unset in production (fail-closed)", async () => {
		delete process.env.ALERTMANAGER_WEBHOOK_SECRET;
		vi.stubEnv("NODE_ENV", "production");
		try {
			const res = await POST(
				makeRequest({
					kind: "component",
					status: "firing",
					labels: { component_key: "x" },
					annotations: {},
				}) as never,
			);
			expect(res.status).toBe(401);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("rejects unauthenticated POSTs when the env var is set", async () => {
		process.env.ALERTMANAGER_WEBHOOK_SECRET = "expected-secret";
		const res = await POST(
			makeRequest({
				kind: "component",
				status: "firing",
				labels: { component_key: "x" },
				annotations: {},
			}) as never,
		);
		expect(res.status).toBe(401);
	});

	it("rejects POSTs with the wrong bearer secret", async () => {
		process.env.ALERTMANAGER_WEBHOOK_SECRET = "expected-secret";
		const res = await POST(
			makeRequest(
				{
					kind: "component",
					status: "firing",
					labels: { component_key: "x" },
					annotations: {},
				},
				{ secret: "wrong-secret" },
			) as never,
		);
		expect(res.status).toBe(401);
	});

	it("accepts POSTs with the correct bearer secret", async () => {
		process.env.ALERTMANAGER_WEBHOOK_SECRET = "expected-secret";
		const res = await POST(
			makeRequest(
				{
					kind: "component",
					status: "firing",
					labels: {
						component_key: "temporal-worker",
						component_name: "Temporal Worker",
						severity: "sev1",
					},
					annotations: { summary: "stall" },
				},
				{ secret: "expected-secret" },
			) as never,
		);
		expect(res.status).toBe(200);
	});
});

describe("POST /api/incidents/alertmanager — component kind", () => {
	beforeEach(() => {
		delete process.env.ALERTMANAGER_WEBHOOK_SECRET;
	});

	it("upserts a component incident on status=firing", async () => {
		const res = await POST(
			makeRequest({
				kind: "component",
				status: "firing",
				fingerprint: "fp-1",
				labels: {
					component_key: "temporal-worker",
					component_name: "Temporal Worker",
					severity: "sev1",
				},
				annotations: { summary: "Worker stalled" },
			}) as never,
		);
		expect(res.status).toBe(200);
		expect(upsertMock).toHaveBeenCalledWith({
			componentKey: "temporal-worker",
			componentName: "Temporal Worker",
			severity: "SEV1",
			summary: "Worker stalled",
			alertmanagerFingerprint: "fp-1",
		});
	});

	it("closes a component incident on status=resolved", async () => {
		const res = await POST(
			makeRequest({
				kind: "component",
				status: "resolved",
				fingerprint: "fp-2",
				labels: {
					component_key: "temporal-worker",
					component_name: "Temporal Worker",
					severity: "sev1",
				},
				annotations: { summary: "Recovered" },
			}) as never,
		);
		expect(res.status).toBe(200);
		// upsert is called first to resolve the incidentId, then close.
		expect(upsertMock).toHaveBeenCalledTimes(1);
		expect(closeMock).toHaveBeenCalledWith({
			incidentId: "ci-1",
			autoResolved: true,
		});
	});

	it("rejects a component alert with no component_key label (per-alert error, batch still 200)", async () => {
		const res = await POST(
			makeRequest({
				kind: "component",
				status: "firing",
				labels: { severity: "sev2" },
				annotations: { summary: "missing key" },
			}) as never,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			results: Array<{ error?: string }>;
		};
		expect(body.results[0]?.error).toMatch(/component_key/);
	});
});

describe("POST /api/incidents/alertmanager — kind discriminator", () => {
	beforeEach(() => {
		delete process.env.ALERTMANAGER_WEBHOOK_SECRET;
	});

	it("acknowledges integration alerts without handling them (Temporal owns those rows)", async () => {
		const res = await POST(
			makeRequest({
				alerts: [
					{
						kind: "integration",
						status: "firing",
						labels: { provider_key: "openai" },
						annotations: {},
					},
				],
			}) as never,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			results: Array<{ kind: string; handled: boolean; reason?: string }>;
		};
		expect(body.results[0]).toMatchObject({
			kind: "integration",
			handled: false,
			reason: "owned-by-temporal-poller",
		});
		expect(upsertMock).not.toHaveBeenCalled();
		expect(closeMock).not.toHaveBeenCalled();
		expect(alertmanagerUpsertMock).not.toHaveBeenCalled();
	});

	it("HANDLES errorRate alerts — nothing else creates those rows", async () => {
		// This assertion is inverted from the one it replaces, deliberately. The
		// old expectation (`handled: false`) encoded the same wrong belief as the
		// route's comment: that a Temporal poller owned errorRate. Temporal only
		// PRUNES ErrorRateIncident — nothing ever created a row, so every
		// burn-rate alert was accepted and discarded while the admin dashboard,
		// the weekly digest and the audit bridge all read an empty table.
		alertmanagerUpsertMock.mockResolvedValue({
			kind: "errorRate",
			incidentId: "eri_1",
			created: true,
		});

		const res = await POST(
			makeRequest({
				alerts: [
					{
						kind: "errorRate",
						status: "firing",
						fingerprint: "fp_burn_1",
						startsAt: "2026-08-07T00:00:00.000Z",
						labels: {
							alertname: "HighErrorRateBurn",
							severity: "critical",
						},
						annotations: { summary: "5xx burn rate over budget" },
					},
				],
			}) as never,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			results: Array<{
				kind: string;
				handled: boolean;
				incidentId?: string;
			}>;
		};
		expect(body.results[0]).toMatchObject({
			kind: "errorRate",
			handled: true,
			incidentId: "eri_1",
		});
		expect(alertmanagerUpsertMock).toHaveBeenCalledTimes(1);
		// The component writers stay out of it.
		expect(upsertMock).not.toHaveBeenCalled();
	});

	it("refuses an errorRate alert with no fingerprint rather than duplicating", async () => {
		// The fingerprint is the dedupe key; without it a refire would open a
		// second incident for the same alert.
		const res = await POST(
			makeRequest({
				alerts: [
					{
						kind: "errorRate",
						status: "firing",
						labels: { service: "api" },
						annotations: {},
					},
				],
			}) as never,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			results: Array<{ kind: string; accepted: boolean }>;
		};
		expect(body.results[0]).toMatchObject({
			kind: "errorRate",
			accepted: false,
		});
		expect(alertmanagerUpsertMock).not.toHaveBeenCalled();
	});

	it("unwraps Alertmanager batch shape ({ alerts: [...] })", async () => {
		const res = await POST(
			makeRequest({
				alerts: [
					{
						kind: "component",
						status: "firing",
						labels: {
							component_key: "rag-indexer",
							component_name: "RAG Indexer",
							severity: "sev2",
						},
						annotations: { summary: "queue backed up" },
					},
				],
			}) as never,
		);
		expect(res.status).toBe(200);
		expect(upsertMock).toHaveBeenCalledTimes(1);
	});
});
