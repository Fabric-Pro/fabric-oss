import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
	listProjectShortcuts: vi.fn(),
	hasProjectAccess: vi.fn(),
	setProjectFavorite: vi.fn(),
	recordProjectVisit: vi.fn(),
}));
const checkRateLimit = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", () => dbMock);
vi.mock("../../../../lib/rate-limit", () => ({
	checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
	RATE_LIMIT_PRESETS: { standard: { limit: 100, windowMs: 60_000 } },
}));

// The procedure builder is a fluent chain; unwrap it so the handler can be
// called directly, matching the sibling procedure tests.
vi.mock("../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: () => () => chain,
		requireInputOrgPermission: () => () => chain,
		resolveOrganizationId: (input: string | null | undefined) =>
			input ?? undefined,
		Permissions: { PROJECT_READ: "project:read" },
	};
});

import { setProjectFavoriteProcedure } from "../project-favorite";
import { listProjectShortcutsProcedure } from "../project-shortcuts";
import { recordProjectVisitProcedure } from "../record-project-visit";

// biome-ignore lint/complexity/noBannedTypes: matches the sibling procedure tests.
const unwrap = (p: unknown) => (p as { handler: Function }).handler;

const shortcuts = unwrap(listProjectShortcutsProcedure);
const favorite = unwrap(setProjectFavoriteProcedure);
const visit = unwrap(recordProjectVisitProcedure);

const ctx = { user: { id: "u1" }, session: {} };

beforeEach(() => {
	vi.clearAllMocks();
	checkRateLimit.mockResolvedValue({ allowed: true, resetInSeconds: 0 });
	dbMock.hasProjectAccess.mockResolvedValue(true);
	dbMock.listProjectShortcuts.mockResolvedValue([]);
});

describe("projects.shortcuts", () => {
	it("resolves personal context from an explicit null rather than the session", async () => {
		await shortcuts({ input: { organizationId: null }, context: ctx });

		expect(dbMock.listProjectShortcuts).toHaveBeenCalledWith({
			userId: "u1",
			organizationId: null,
			limit: 3,
		});
	});

	it("passes the caller-named organization through", async () => {
		await shortcuts({ input: { organizationId: "org-1" }, context: ctx });

		expect(
			dbMock.listProjectShortcuts.mock.calls[0][0].organizationId,
		).toBe("org-1");
	});

	it("caps the list at the product-fixed three", async () => {
		await shortcuts({ input: { organizationId: null }, context: ctx });

		expect(dbMock.listProjectShortcuts.mock.calls[0][0].limit).toBe(3);
	});

	it("returns an empty list for a caller who can reach nothing", async () => {
		await expect(
			shortcuts({ input: { organizationId: null }, context: ctx }),
		).resolves.toEqual({ shortcuts: [] });
	});
});

describe("projects.setFavorite", () => {
	it("writes the favorite for a reachable project", async () => {
		await favorite({
			input: { projectId: "p1", favorited: true },
			context: ctx,
		});

		expect(dbMock.setProjectFavorite).toHaveBeenCalledWith({
			projectId: "p1",
			userId: "u1",
			favorited: true,
		});
	});

	// KTD13: the object-level decorator falls back to organization role, which
	// admits any member to any project in that org. The read admits only owners
	// and accepted project members, so without this re-check a user could star a
	// project that never appears in their sub-nav.
	it("denies a caller the decorator admits but the read would not", async () => {
		dbMock.hasProjectAccess.mockResolvedValue(false);

		await expect(
			favorite({
				input: { projectId: "p1", favorited: true },
				context: ctx,
			}),
		).rejects.toMatchObject({ message: "Project not found" });
		expect(dbMock.setProjectFavorite).not.toHaveBeenCalled();
	});

	it("reports a rate-limit rejection as too many requests", async () => {
		checkRateLimit.mockResolvedValue({
			allowed: false,
			resetInSeconds: 30,
		});

		await expect(
			favorite({
				input: { projectId: "p1", favorited: true },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
	});

	// A Redis outage fails closed; "wait 30 seconds" would misstate why.
	it("reports a rate-limiter outage as service unavailable", async () => {
		checkRateLimit.mockResolvedValue({
			allowed: false,
			resetInSeconds: 0,
			statusCode: 503,
		});

		await expect(
			favorite({
				input: { projectId: "p1", favorited: true },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	});
});

describe("projects.recordVisit", () => {
	it("records a visit for a reachable project", async () => {
		await visit({ input: { projectId: "p1" }, context: ctx });

		expect(dbMock.recordProjectVisit).toHaveBeenCalledWith({
			projectId: "p1",
			userId: "u1",
		});
	});

	it("writes nothing for a project the caller cannot read", async () => {
		dbMock.hasProjectAccess.mockResolvedValue(false);

		await expect(
			visit({ input: { projectId: "p1" }, context: ctx }),
		).rejects.toMatchObject({ message: "Project not found" });
		expect(dbMock.recordProjectVisit).not.toHaveBeenCalled();
	});

	it("reports a rate-limiter outage as service unavailable", async () => {
		checkRateLimit.mockResolvedValue({
			allowed: false,
			resetInSeconds: 0,
			statusCode: 503,
		});

		await expect(
			visit({ input: { projectId: "p1" }, context: ctx }),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	});
});

// R27 / AE16: the two mutations must not be usable to learn which project ids
// exist. Both denial paths are normalized to one identical response.
describe("denial normalization", () => {
	it("returns the same shape for a missing project and an unreachable one", async () => {
		dbMock.hasProjectAccess.mockResolvedValue(false);

		const missing = await favorite({
			input: { projectId: "does-not-exist", favorited: true },
			context: ctx,
		}).catch((e) => e);
		const unreachable = await favorite({
			input: { projectId: "someone-elses", favorited: true },
			context: ctx,
		}).catch((e) => e);

		expect(missing.code).toBe(unreachable.code);
		expect(missing.message).toBe(unreachable.message);
		expect(missing.data).toEqual(unreachable.data);
	});
});
