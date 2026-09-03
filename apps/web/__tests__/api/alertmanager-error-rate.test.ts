/**
 * Burn-rate alerts must actually create an incident.
 *
 * The route discriminates on `kind` and used to drop everything that was not
 * `component`, with a comment claiming the Temporal poller owned `errorRate` and
 * `integration`. That was true for `integration` — `upsert-integration-incident`
 * and `close-integration-incident` own those rows — and **false** for `errorRate`:
 * Temporal only ever PRUNES that table. Nothing created a row.
 *
 * So every burn-rate alert was accepted, acknowledged with `handled: false`, and
 * discarded, while `ErrorRateIncident` stayed permanently empty — even though the
 * admin dashboard, the weekly digest and the incident-event bridge all read it.
 * A webhook returning 200 and doing nothing is the quietest possible failure.
 *
 * `upsertAlertmanagerIncident` already implemented the whole behaviour and was
 * only ever called from a test. These assertions are about the WRITE happening,
 * which is the thing that was missing — asserting the HTTP status alone passed
 * throughout.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertAlertmanagerIncident = vi.fn();
const upsertComponentIncident = vi.fn();
const closeComponentIncident = vi.fn();

vi.mock("@repo/database", () => ({
	upsertAlertmanagerIncident: (...a: unknown[]) =>
		upsertAlertmanagerIncident(...a),
	upsertComponentIncident: (...a: unknown[]) => upsertComponentIncident(...a),
	closeComponentIncident: (...a: unknown[]) => closeComponentIncident(...a),
}));
vi.mock("@repo/logs", () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { POST } = await import("../../app/api/incidents/alertmanager/route");

function request(alerts: unknown[]) {
	return {
		headers: new Headers({ authorization: "Bearer test-secret" }),
		json: async () => ({ alerts }),
	} as never;
}

const FIRING = {
	kind: "errorRate" as const,
	status: "firing" as const,
	fingerprint: "fp_burn_1",
	startsAt: "2026-08-07T00:00:00.000Z",
	labels: { alertname: "HighErrorRateBurn", severity: "critical" },
	annotations: { summary: "5xx burn rate over budget" },
};

beforeEach(() => {
	vi.clearAllMocks();
	process.env.ALERTMANAGER_WEBHOOK_SECRET = "test-secret";
	upsertAlertmanagerIncident.mockResolvedValue({
		kind: "errorRate",
		incidentId: "eri_1",
		created: true,
	});
});

describe("errorRate alerts reach the incident writer", () => {
	it("creates an incident and reports handled", async () => {
		const res = await POST(request([FIRING]));
		const body = await res.json();

		expect(upsertAlertmanagerIncident).toHaveBeenCalledTimes(1);
		expect(body.results[0]).toMatchObject({
			kind: "errorRate",
			accepted: true,
			handled: true,
			incidentId: "eri_1",
			action: "firing",
		});
	});

	it("maps the Alertmanager wire fields the writer needs", async () => {
		await POST(request([FIRING]));

		expect(upsertAlertmanagerIncident.mock.calls[0]?.[0]).toMatchObject({
			fingerprint: "fp_burn_1",
			alertName: "HighErrorRateBurn",
			startsAt: new Date("2026-08-07T00:00:00.000Z"),
			endsAt: null,
			labels: { alertname: "HighErrorRateBurn", severity: "critical" },
			annotations: { summary: "5xx burn rate over budget" },
		});
	});

	it("passes endsAt when the alert resolved", async () => {
		await POST(
			request([
				{
					...FIRING,
					status: "resolved",
					endsAt: "2026-08-07T00:10:00.000Z",
				},
			]),
		);

		const arg = upsertAlertmanagerIncident.mock.calls[0]?.[0] as {
			endsAt: Date | null;
		};
		expect(arg.endsAt).toEqual(new Date("2026-08-07T00:10:00.000Z"));
	});

	it("treats Alertmanager's zero-time endsAt as not-ended", async () => {
		// Alertmanager sends 0001-01-01T00:00:00Z for "still firing". Passing that
		// through as a real date would resolve the incident the moment it fired.
		await POST(request([{ ...FIRING, endsAt: "0001-01-01T00:00:00Z" }]));

		const arg = upsertAlertmanagerIncident.mock.calls[0]?.[0] as {
			endsAt: Date | null;
		};
		expect(arg.endsAt).toBeNull();
	});

	it("refuses an errorRate alert with no fingerprint rather than duplicating", async () => {
		// The fingerprint is the dedupe key; without it a refire opens a second
		// incident for the same alert.
		const res = await POST(
			request([{ ...FIRING, fingerprint: undefined }]),
		);
		const body = await res.json();

		expect(upsertAlertmanagerIncident).not.toHaveBeenCalled();
		expect(body.results[0]).toMatchObject({
			kind: "errorRate",
			accepted: false,
		});
	});

	it("keeps a wire-supplied `__proto__` label off the prototype chain", async () => {
		// Label names arrive over the webhook, so copying them with
		// `out[key] = value` would run `__proto__` through Object.prototype's
		// setter. The record is built with Object.fromEntries instead, which
		// defines an own data property. js/remote-property-injection
		// A computed key, so the literal creates an own `__proto__` property
		// instead of using the object-literal prototype-setter syntax.
		const hostileLabels: Record<string, string> = {
			...FIRING.labels,
			["__proto__"]: "polluted",
		};

		await POST(request([{ ...FIRING, labels: hostileLabels }]));

		const arg = upsertAlertmanagerIncident.mock.calls[0]?.[0] as {
			labels: Record<string, string>;
		};
		expect(Object.getPrototypeOf(arg.labels)).toBe(Object.prototype);
		expect(Object.hasOwn(arg.labels, "__proto__")).toBe(true);
		expect(arg.labels.severity).toBe("critical");
	});

	it("does not fail the whole request when the write throws", async () => {
		upsertAlertmanagerIncident.mockRejectedValue(new Error("db down"));

		const res = await POST(request([FIRING]));
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.results[0]).toMatchObject({
			kind: "errorRate",
			accepted: false,
			error: "upsert-failed",
		});
	});
});

describe("integration alerts stay with the Temporal poller", () => {
	it("is acknowledged but not written here, so the alert is not double-handled", async () => {
		const res = await POST(request([{ ...FIRING, kind: "integration" }]));
		const body = await res.json();

		expect(upsertAlertmanagerIncident).not.toHaveBeenCalled();
		expect(body.results[0]).toMatchObject({
			kind: "integration",
			accepted: true,
			handled: false,
			reason: "owned-by-temporal-poller",
		});
	});
});

describe("the component path is unchanged", () => {
	it("still routes component alerts to upsertComponentIncident", async () => {
		upsertComponentIncident.mockResolvedValue({
			incidentId: "ci_1",
			wasNew: true,
		});

		await POST(
			request([
				{
					kind: "component",
					status: "firing",
					fingerprint: "fp_c",
					labels: { component_key: "core-api", severity: "critical" },
					annotations: { summary: "down" },
				},
			]),
		);

		expect(upsertComponentIncident).toHaveBeenCalledTimes(1);
		expect(upsertAlertmanagerIncident).not.toHaveBeenCalled();
	});
});
