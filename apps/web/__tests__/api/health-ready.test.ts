/**
 * `/api/health/ready` — the dependency-aware health check.
 *
 * The important assertion here is the LAST one: that `/api/health` stays shallow.
 * That path is the Kubernetes liveness probe as well as the readiness probe, the
 * ALB healthcheck, the container HEALTHCHECK and the external uptime monitor, so
 * teaching it to fail on an unreachable database would let a transient blip trip
 * liveness three times in a minute and kill every web pod. The split between the
 * two routes is the safety property, and a future edit that "improves"
 * `/api/health` by adding a dependency check should fail this file.
 */

import { describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();

vi.mock("@repo/database", () => ({
	db: { $queryRaw: (...a: unknown[]) => queryRaw(...a) },
}));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { GET as readiness } from "../../app/api/health/ready/route";
import { GET as liveness } from "../../app/api/health/route";

describe("GET /api/health/ready", () => {
	it("returns 200 and names each passing check", async () => {
		queryRaw.mockResolvedValue([{ "1": 1 }]);

		const res = await readiness();
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.status).toBe("ready");
		expect(body.checks).toHaveLength(1);
		expect(body.checks[0]).toMatchObject({ name: "database", ok: true });
	});

	it("returns 503 with the failing check named, and no stack trace", async () => {
		queryRaw.mockRejectedValue(
			new Error("connect ECONNREFUSED 10.0.0.5:5432"),
		);

		const res = await readiness();
		const body = await res.json();

		expect(res.status).toBe(503);
		expect(body.status).toBe("degraded");
		expect(body.checks[0]).toMatchObject({ name: "database", ok: false });
		expect(body.checks[0].error).toBe("connect ECONNREFUSED 10.0.0.5:5432");
		// Message only. A stack on an unauthenticated endpoint would leak
		// internal paths, and the raw error object could carry a connection URL.
		expect(JSON.stringify(body)).not.toContain("at ");
	});

	// Longer than the route's own 3s cap: a health check that hangs is
	// indistinguishable from the outage it is trying to describe.
	it("answers rather than hanging when a check never settles", async () => {
		queryRaw.mockImplementation(() => new Promise(() => {}));

		const res = await readiness();
		const body = await res.json();

		expect(res.status).toBe(503);
		expect(body.checks[0].ok).toBe(false);
		expect(body.checks[0].error).toMatch(/timed out/);
	}, 15_000);
});

describe("GET /api/health stays shallow", () => {
	// Guards the probe-safety property, not a formatting preference.
	it("returns 200 healthy even when the database is unreachable", async () => {
		queryRaw.mockRejectedValue(new Error("connect ECONNREFUSED"));

		const res = await liveness();
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.status).toBe("healthy");
	});

	it("does not touch the database at all", async () => {
		queryRaw.mockClear();

		await liveness();

		expect(queryRaw).not.toHaveBeenCalled();
	});
});
