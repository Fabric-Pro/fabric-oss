/**
 * Tests for the incident-history query helpers in
 * `prisma/queries/incidents.ts`:
 *   - listIncidentHistory: SERVER-SIDE filtered + paginated. Queries the
 *     relevant streams (selected by `source`), applies the `status` facet to
 *     each stream's `where`, windows on firedAt/startedAt, filters
 *     NOT_CONFIGURED integration rows, merges newest-first, and slices the
 *     requested page. `total` is the summed per-stream `count()`.
 *   - listComponentIncidentEvents: filters by componentIncidentId, ascending
 *     createdAt, joins the actor.
 *
 * The Prisma client is mocked so these stay pure unit tests (no DB).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const errorRateFindManyMock = vi.fn();
const errorRateCountMock = vi.fn();
const integrationFindManyMock = vi.fn();
const integrationCountMock = vi.fn();
const componentFindManyMock = vi.fn();
const componentCountMock = vi.fn();
const eventFindManyMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		errorRateIncident: {
			findMany: (args: unknown) => errorRateFindManyMock(args),
			count: (args: unknown) => errorRateCountMock(args),
		},
		integrationIncident: {
			findMany: (args: unknown) => integrationFindManyMock(args),
			count: (args: unknown) => integrationCountMock(args),
		},
		componentIncident: {
			findMany: (args: unknown) => componentFindManyMock(args),
			count: (args: unknown) => componentCountMock(args),
		},
		incidentEvent: {
			findMany: (args: unknown) => eventFindManyMock(args),
		},
	},
	// `Prisma` is imported as a type-only `type Prisma` in incidents.ts, but
	// the audit-bridge code path also imports the runtime; provide a stub so
	// the module loads.
	Prisma: {},
}));

// The module under test also pulls in the audit-log + correlation-id helpers
// via the IncidentEvent→audit bridge. Stub them so importing incidents.ts
// doesn't drag the whole audit stack into a pure query test.
vi.mock("@repo/utils/correlation-id", () => ({
	getCorrelationIdFromContext: () => null,
}));
vi.mock("../prisma/queries/audit-log", () => ({
	recordAudit: vi.fn(),
}));

import {
	listComponentIncidentEvents,
	listIncidentHistory,
} from "../prisma/queries/incidents";

/** Build an ErrorRateIncident-shaped row with a deterministic firedAt. */
function erRow(
	id: string,
	firedAt: string,
	over: Record<string, unknown> = {},
) {
	return {
		id,
		alertName: `alert_${id}`,
		severity: "SEV1",
		status: "FIRING",
		service: "api",
		feature: "ai_generation",
		errorClass: null,
		firedAt: new Date(firedAt),
		resolvedAt: null,
		...over,
	};
}

function intRow(
	id: string,
	startedAt: string,
	over: Record<string, unknown> = {},
) {
	return {
		id,
		providerKey: "openai",
		providerName: "OpenAI",
		severity: "SEV2",
		status: "RESOLVED",
		detectionMethod: "STATUSPAGE_POLL",
		summary: "Provider incident",
		startedAt: new Date(startedAt),
		resolvedAt: new Date(startedAt),
		...over,
	};
}

function compRow(
	id: string,
	firedAt: string,
	over: Record<string, unknown> = {},
) {
	return {
		id,
		componentKey: "temporal-worker",
		componentName: "Temporal Worker",
		severity: "SEV3",
		status: "RESOLVED",
		summary: "Subsystem incident",
		firedAt: new Date(firedAt),
		resolvedAt: new Date(firedAt),
		...over,
	};
}

beforeEach(() => {
	errorRateFindManyMock.mockReset();
	errorRateCountMock.mockReset();
	integrationFindManyMock.mockReset();
	integrationCountMock.mockReset();
	componentFindManyMock.mockReset();
	componentCountMock.mockReset();
	eventFindManyMock.mockReset();
	errorRateFindManyMock.mockResolvedValue([]);
	integrationFindManyMock.mockResolvedValue([]);
	componentFindManyMock.mockResolvedValue([]);
	errorRateCountMock.mockResolvedValue(0);
	integrationCountMock.mockResolvedValue(0);
	componentCountMock.mockResolvedValue(0);
	eventFindManyMock.mockResolvedValue([]);
});

describe("listIncidentHistory — streams + window + NOT_CONFIGURED", () => {
	it("queries all three streams with NO status/severity filter under default (status=all)", async () => {
		await listIncidentHistory({ sinceDays: 90, pageSize: 50, page: 1 });

		const erWhere = errorRateFindManyMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
			take: number;
			orderBy: unknown;
		};
		const compWhere = componentFindManyMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
		};

		// No status / severity keys anywhere — that is what makes this the
		// "history" query rather than the active-banner query.
		expect(erWhere.where).not.toHaveProperty("status");
		expect(erWhere.where).not.toHaveProperty("severity");
		expect(compWhere.where).not.toHaveProperty("status");
		expect(compWhere.where).not.toHaveProperty("severity");
		// take = page * pageSize on page 1.
		expect(erWhere.take).toBe(50);
		expect(erWhere.orderBy).toEqual({ firedAt: "desc" });
	});

	it("filters NOT_CONFIGURED integration rows and windows on startedAt", async () => {
		await listIncidentHistory({ sinceDays: 30, pageSize: 25, page: 1 });
		const intArgs = integrationFindManyMock.mock.calls[0]?.[0] as {
			where: { health?: { notIn?: string[] }; startedAt?: unknown };
		};
		expect(intArgs.where.health).toEqual({ notIn: ["NOT_CONFIGURED"] });
		expect(intArgs.where.startedAt).toHaveProperty("gte");
	});

	it("windows each stream on its own time column (firedAt vs startedAt)", async () => {
		await listIncidentHistory({ sinceDays: 30, pageSize: 25, page: 1 });
		const erArgs = errorRateFindManyMock.mock.calls[0]?.[0] as {
			where: { firedAt?: { gte: Date } };
		};
		const intArgs = integrationFindManyMock.mock.calls[0]?.[0] as {
			where: { startedAt?: { gte: Date } };
		};
		const compArgs = componentFindManyMock.mock.calls[0]?.[0] as {
			where: { firedAt?: { gte: Date } };
		};
		expect(erArgs.where.firedAt?.gte).toBeInstanceOf(Date);
		expect(intArgs.where.startedAt?.gte).toBeInstanceOf(Date);
		expect(compArgs.where.firedAt?.gte).toBeInstanceOf(Date);
	});

	it("clamps sinceDays to 1..365 (the retention window)", async () => {
		const now = Date.now();

		await listIncidentHistory({ sinceDays: 9999, pageSize: 25, page: 1 });
		const tooBig = errorRateFindManyMock.mock.calls[0]?.[0] as {
			where: { firedAt: { gte: Date } };
		};
		const bigDays =
			(now - tooBig.where.firedAt.gte.getTime()) / (24 * 60 * 60 * 1000);
		// Clamped to 365, not 9999.
		expect(Math.round(bigDays)).toBe(365);

		errorRateFindManyMock.mockClear();
		await listIncidentHistory({ sinceDays: 0, pageSize: 25, page: 1 });
		const tooSmall = errorRateFindManyMock.mock.calls[0]?.[0] as {
			where: { firedAt: { gte: Date } };
		};
		const smallDays =
			(now - tooSmall.where.firedAt.gte.getTime()) /
			(24 * 60 * 60 * 1000);
		// Clamped up to 1, not 0.
		expect(Math.round(smallDays)).toBe(1);
	});

	it("defaults to sinceDays=30 / pageSize=25 / page=1 when omitted", async () => {
		const now = Date.now();
		await listIncidentHistory({});
		const args = errorRateFindManyMock.mock.calls[0]?.[0] as {
			where: { firedAt: { gte: Date } };
			take: number;
		};
		const days =
			(now - args.where.firedAt.gte.getTime()) / (24 * 60 * 60 * 1000);
		expect(Math.round(days)).toBe(30);
		// page(1) * pageSize(25) = 25.
		expect(args.take).toBe(25);
	});

	it("clamps an out-of-set pageSize to 25", async () => {
		await listIncidentHistory({
			sinceDays: 30,
			// @ts-expect-error — exercising the runtime clamp with an illegal size
			pageSize: 37,
			page: 1,
		});
		const args = errorRateFindManyMock.mock.calls[0]?.[0] as {
			take: number;
		};
		expect(args.take).toBe(25);
	});
});

describe("listIncidentHistory — server-side status filter", () => {
	it("status=active applies status in [FIRING, ACKNOWLEDGED] to every stream", async () => {
		await listIncidentHistory({
			sinceDays: 30,
			status: "active",
			pageSize: 25,
			page: 1,
		});
		const er = errorRateFindManyMock.mock.calls[0]?.[0] as {
			where: { status?: { in: string[] } };
		};
		const int = integrationFindManyMock.mock.calls[0]?.[0] as {
			where: { status?: { in: string[] } };
		};
		const comp = componentFindManyMock.mock.calls[0]?.[0] as {
			where: { status?: { in: string[] } };
		};
		expect(er.where.status).toEqual({ in: ["FIRING", "ACKNOWLEDGED"] });
		expect(int.where.status).toEqual({ in: ["FIRING", "ACKNOWLEDGED"] });
		expect(comp.where.status).toEqual({ in: ["FIRING", "ACKNOWLEDGED"] });
	});

	it("status=hidden applies status in [RESOLVED]", async () => {
		await listIncidentHistory({
			sinceDays: 30,
			status: "hidden",
			pageSize: 25,
			page: 1,
		});
		const er = errorRateFindManyMock.mock.calls[0]?.[0] as {
			where: { status?: { in: string[] } };
		};
		expect(er.where.status).toEqual({ in: ["RESOLVED"] });
	});

	it("status=all leaves status unset", async () => {
		await listIncidentHistory({
			sinceDays: 30,
			status: "all",
			pageSize: 25,
			page: 1,
		});
		const er = errorRateFindManyMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
		};
		expect(er.where).not.toHaveProperty("status");
	});
});

describe("listIncidentHistory — server-side source filter", () => {
	it("source=error-rate queries ONLY the error-rate stream", async () => {
		await listIncidentHistory({
			sinceDays: 30,
			source: "error-rate",
			pageSize: 25,
			page: 1,
		});
		expect(errorRateFindManyMock).toHaveBeenCalledTimes(1);
		expect(integrationFindManyMock).not.toHaveBeenCalled();
		expect(componentFindManyMock).not.toHaveBeenCalled();
		// Totals only count the queried stream.
		expect(errorRateCountMock).toHaveBeenCalledTimes(1);
		expect(integrationCountMock).not.toHaveBeenCalled();
		expect(componentCountMock).not.toHaveBeenCalled();
	});

	it("source=component queries ONLY the component stream", async () => {
		await listIncidentHistory({
			sinceDays: 30,
			source: "component",
			pageSize: 25,
			page: 1,
		});
		expect(componentFindManyMock).toHaveBeenCalledTimes(1);
		expect(errorRateFindManyMock).not.toHaveBeenCalled();
		expect(integrationFindManyMock).not.toHaveBeenCalled();
	});

	it("source=synthetic queries ONLY the integration stream filtered by detectionMethod", async () => {
		await listIncidentHistory({
			sinceDays: 30,
			source: "synthetic",
			pageSize: 25,
			page: 1,
		});
		expect(integrationFindManyMock).toHaveBeenCalledTimes(1);
		expect(errorRateFindManyMock).not.toHaveBeenCalled();
		expect(componentFindManyMock).not.toHaveBeenCalled();
		const int = integrationFindManyMock.mock.calls[0]?.[0] as {
			where: { detectionMethod?: string };
		};
		expect(int.where.detectionMethod).toBe("SYNTHETIC_PROBE");
	});

	it("maps each integration source to its detectionMethod enum value", async () => {
		const cases: Array<[string, string]> = [
			["statuspage", "STATUSPAGE_POLL"],
			["synthetic", "SYNTHETIC_PROBE"],
			["breaker", "BREAKER_OPEN"],
			["alertmanager", "ALERT_MANAGER"],
		];
		for (const [source, method] of cases) {
			integrationFindManyMock.mockClear();
			await listIncidentHistory({
				sinceDays: 30,
				source: source as "statuspage",
				pageSize: 25,
				page: 1,
			});
			const int = integrationFindManyMock.mock.calls[0]?.[0] as {
				where: { detectionMethod?: string };
			};
			expect(int.where.detectionMethod).toBe(method);
		}
	});
});

describe("listIncidentHistory — pagination + total + ordering", () => {
	it("slices the requested page out of the merged newest-first set (pageSize=25)", async () => {
		// 30 error-rate rows, newest first by construction. The mock ignores
		// `take`, so the helper receives all 30 and must slice the page itself.
		const rows = Array.from({ length: 30 }, (_, i) =>
			// i=0 is newest; decreasing timestamps as i grows.
			erRow(
				`e-${String(i).padStart(2, "0")}`,
				new Date(Date.UTC(2026, 4, 30) - i * 60_000).toISOString(),
			),
		);
		errorRateFindManyMock.mockResolvedValue(rows);
		errorRateCountMock.mockResolvedValue(30);

		// Page 1 of pageSize 25 → the newest 25 (e-00..e-24).
		const page1 = await listIncidentHistory({
			sinceDays: 365,
			source: "error-rate",
			pageSize: 25,
			page: 1,
		});
		expect(page1.items).toHaveLength(25);
		expect(page1.items[0]?.id).toBe("e-00");
		expect(page1.items[24]?.id).toBe("e-24");
		expect(page1.total).toBe(30);

		// Page 2 → the remaining 5 (e-25..e-29).
		const page2 = await listIncidentHistory({
			sinceDays: 365,
			source: "error-rate",
			pageSize: 25,
			page: 2,
		});
		expect(page2.items.map((i) => i.id)).toEqual([
			"e-25",
			"e-26",
			"e-27",
			"e-28",
			"e-29",
		]);
		expect(page2.total).toBe(30);
	});

	it("interleaves rows from multiple streams strictly by start time DESC", async () => {
		errorRateFindManyMock.mockResolvedValue([
			erRow("e1", "2026-05-18T00:00:00Z"),
		]);
		integrationFindManyMock.mockResolvedValue([
			intRow("i1", "2026-05-19T00:00:00Z"),
		]);
		componentFindManyMock.mockResolvedValue([
			compRow("c1", "2026-05-17T00:00:00Z"),
		]);
		errorRateCountMock.mockResolvedValue(1);
		integrationCountMock.mockResolvedValue(1);
		componentCountMock.mockResolvedValue(1);

		const res = await listIncidentHistory({
			sinceDays: 365,
			source: "all",
			pageSize: 25,
			page: 1,
		});
		// i1 (19th) > e1 (18th) > c1 (17th).
		expect(res.items.map((i) => i.id)).toEqual(["i1", "e1", "c1"]);
		expect(res.items.map((i) => i.kind)).toEqual([
			"integration",
			"errorRate",
			"component",
		]);
		// total is the SUM of every queried stream's count.
		expect(res.total).toBe(3);
	});

	it("take grows with page so the slice has enough rows to reach page N", async () => {
		await listIncidentHistory({
			sinceDays: 30,
			source: "error-rate",
			pageSize: 25,
			page: 3,
		});
		const args = errorRateFindManyMock.mock.calls[0]?.[0] as {
			take: number;
		};
		// page(3) * pageSize(25) = 75.
		expect(args.take).toBe(75);
	});

	it("normalizes rows to ISO strings tagged by kind", async () => {
		errorRateFindManyMock.mockResolvedValue([
			erRow("e1", "2026-05-18T00:00:00Z", { errorClass: "5xx" }),
		]);
		errorRateCountMock.mockResolvedValue(1);
		const res = await listIncidentHistory({
			sinceDays: 365,
			source: "error-rate",
			pageSize: 25,
			page: 1,
		});
		expect(res.items[0]).toMatchObject({
			id: "e1",
			kind: "errorRate",
			severity: "SEV1",
			status: "FIRING",
			alertName: "alert_e1",
			service: "api",
			feature: "ai_generation",
			errorClass: "5xx",
		});
		// Dates are serialized as ISO strings, not Date instances.
		expect(typeof res.items[0]?.startedAt).toBe("string");
	});
});

describe("listComponentIncidentEvents", () => {
	it("filters by componentIncidentId, ascending createdAt, with actor joined", async () => {
		eventFindManyMock.mockResolvedValue([
			{ id: "ev-1", eventType: "FIRED" },
		]);
		const events = await listComponentIncidentEvents("ci-42");
		const args = eventFindManyMock.mock.calls[0]?.[0] as {
			where: { componentIncidentId: string };
			orderBy: { createdAt: string };
			include: { actor: unknown };
		};
		expect(args.where).toEqual({ componentIncidentId: "ci-42" });
		expect(args.orderBy).toEqual({ createdAt: "asc" });
		expect(args.include.actor).toBeDefined();
		expect(events).toHaveLength(1);
	});
});
