import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	cycleFindFirst: vi.fn(),
}));
const temporalMocks = vi.hoisted(() => ({
	isTemporalAvailable: vi.fn(async () => true),
	dispatch: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { publishingSuggestionCycle: { findFirst: dbMocks.cycleFindFirst } },
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(),
	isTemporalAvailable: temporalMocks.isTemporalAvailable,
}));
// Mock exactly the specifier the helper imports (the narrow activities
// subpath) — a rename or a missing package.json export entry then fails
// this test instead of passing over a phantom module.
vi.mock("@repo/temporal/activities/publishing-suggestion", () => ({
	runPublishingSuggestionDispatch: temporalMocks.dispatch,
}));

import { requestPublishingGeneration } from "../modules/projects/lib/request-publishing-generation";

const NOW = new Date("2026-08-11T12:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	dbMocks.cycleFindFirst.mockResolvedValue(null);
	temporalMocks.isTemporalAvailable.mockResolvedValue(true);
});

describe("requestPublishingGeneration", () => {
	it("reports in_flight when a cycle is already GENERATING", async () => {
		dbMocks.cycleFindFirst.mockImplementation(
			async (args: { where: { status?: unknown } }) =>
				args.where.status === "GENERATING"
					? { id: "cycle-live", startedAt: NOW }
					: null,
		);

		const res = await requestPublishingGeneration({
			projectId: "p1",
			triggeredByUserId: "u1",
		});

		expect(res.status).toBe("in_flight");
	});

	it("enforces a ONE HOUR cooldown, not the five-minute daily-brief floor", async () => {
		// 30 minutes ago: inside a one-hour cooldown, well outside five minutes.
		dbMocks.cycleFindFirst.mockImplementation(
			async (args: { where: { status?: unknown } }) =>
				args.where.status === "GENERATING"
					? null
					: {
							id: "cycle-recent",
							startedAt: new Date(NOW.getTime() - 30 * 60 * 1000),
						},
		);

		const res = await requestPublishingGeneration({
			projectId: "p1",
			triggeredByUserId: "u1",
		});

		expect(res.status).toBe("rate_limited");
	});

	it("allows a run once the cooldown has passed", async () => {
		dbMocks.cycleFindFirst.mockImplementation(
			async (args: { where: { status?: unknown } }) =>
				args.where.status === "GENERATING"
					? null
					: {
							id: "cycle-old",
							startedAt: new Date(NOW.getTime() - 61 * 60 * 1000),
						},
		);

		const res = await requestPublishingGeneration({
			projectId: "p1",
			triggeredByUserId: "u1",
		});

		expect(res.status).toBe("started");
		expect(temporalMocks.dispatch).toHaveBeenCalledWith({
			projectId: "p1",
			force: true,
			triggeredByUserId: "u1",
		});
	});

	it("passes the acting user id through to the dispatch call as triggeredByUserId — a durable audit breadcrumb, not just the log line", async () => {
		// Non-vacuous: a regression that drops `triggeredByUserId` from the
		// dispatch call (e.g. reverting to `{ projectId, force: true }`) fails
		// this assertion even though the log-line breadcrumb above still passes.
		dbMocks.cycleFindFirst.mockImplementation(
			async (args: { where: { status?: unknown } }) =>
				args.where.status === "GENERATING"
					? null
					: {
							id: "cycle-old",
							startedAt: new Date(NOW.getTime() - 61 * 60 * 1000),
						},
		);

		await requestPublishingGeneration({
			projectId: "p1",
			triggeredByUserId: "acting-user-77",
		});

		expect(temporalMocks.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ triggeredByUserId: "acting-user-77" }),
		);
	});

	it("reports unavailable rather than throwing when Temporal is down", async () => {
		temporalMocks.isTemporalAvailable.mockResolvedValue(false);

		const res = await requestPublishingGeneration({
			projectId: "p1",
			triggeredByUserId: "u1",
		});

		expect(res.status).toBe("unavailable");
	});

	it("starts on a project's first-ever run — no prior cycle at all", async () => {
		// beforeEach's default `dbMocks.cycleFindFirst.mockResolvedValue(null)`
		// answers both the in-flight check and the cooldown lookup with null —
		// the state of a brand-new project that has never had a cycle row.
		// Neither guard may block it.
		const consoleInfoSpy = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);

		const res = await requestPublishingGeneration({
			projectId: "p1",
			triggeredByUserId: "u1",
		});

		expect(res.status).toBe("started");
		expect(temporalMocks.dispatch).toHaveBeenCalledWith({
			projectId: "p1",
			force: true,
			triggeredByUserId: "u1",
		});
		// The breadcrumb: a manual run has no occurrenceKey, so this log is the
		// only trace of who triggered it.
		expect(consoleInfoSpy).toHaveBeenCalledWith(
			expect.stringContaining("manual run initiated"),
			expect.objectContaining({
				projectId: "p1",
				triggeredByUserId: "u1",
			}),
		);
		consoleInfoSpy.mockRestore();
	});

	it("reports unavailable rather than throwing when the dispatch call rejects after the GENERATING cycle is already created", async () => {
		// runPublishingSuggestionDispatch re-throws a non-already-started
		// workflow-start failure (correct for the Temporal Worker, which
		// retries the activity). Nothing retries an HTTP handler, so this must
		// not propagate as an unhandled 500.
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		temporalMocks.dispatch.mockRejectedValue(
			new Error("workflow start failed"),
		);

		const res = await requestPublishingGeneration({
			projectId: "p1",
			triggeredByUserId: "u1",
		});

		expect(res.status).toBe("unavailable");
		// Logged, not swallowed — a failure nobody can see is its own defect.
		expect(consoleErrorSpy).toHaveBeenCalled();
		consoleErrorSpy.mockRestore();
	});
});
