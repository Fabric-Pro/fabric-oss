/**
 * Integration tests for the customer status overview.
 *
 * `resolve-component-health.test.ts` covers the pure per-component rules. These
 * cover what only the assembler decides: how the seven signal reads are folded
 * together, and — the reason this file exists — what happens when one of them
 * fails.
 *
 * That last part is the behaviour most worth a test on this surface. The reads
 * originally ran under a bare `Promise.all`, so ONE failing read rejected the
 * whole call and the status page rendered blank. The likeliest cause of a failing
 * read is the datastore, which is exactly what the page is supposed to report on
 * — so the one dependency the page exists to cover could black it out. Each read
 * now settles independently and degrades its own component.
 *
 * The registries are the REAL ones, deliberately: a test that mocked
 * `listCustomerVisibleComponents` would pass while the shipped registry drifted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const countTenantServerFaults = vi.fn();
const getLastBackgroundWorkAt = vi.fn();
const getProviderHealthByKeys = vi.fn();
const getTenantConnectionSummary = vi.fn();
const listOpenComponentIncidents = vi.fn();
const listOpenProviderIncidents = vi.fn();
const listActiveStatusUpdates = vi.fn();
const loggerWarn = vi.fn();

vi.mock("@repo/database", () => ({
	countTenantServerFaults: (...a: unknown[]) => countTenantServerFaults(...a),
	getLastBackgroundWorkAt: (...a: unknown[]) => getLastBackgroundWorkAt(...a),
	getProviderHealthByKeys: (...a: unknown[]) => getProviderHealthByKeys(...a),
	getTenantConnectionSummary: (...a: unknown[]) =>
		getTenantConnectionSummary(...a),
	listOpenComponentIncidents: (...a: unknown[]) =>
		listOpenComponentIncidents(...a),
	listOpenProviderIncidents: (...a: unknown[]) =>
		listOpenProviderIncidents(...a),
	listActiveStatusUpdates: (...a: unknown[]) => listActiveStatusUpdates(...a),
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: (...a: unknown[]) => loggerWarn(...a), error: vi.fn() },
}));

import { buildSystemHealthOverview } from "../build-overview";

const NOW = new Date("2026-08-06T12:00:00.000Z");
const SCOPE = { organizationId: null, userId: "user-1" };

/** Everything healthy. Each test spoils exactly one signal. */
function allHealthy() {
	countTenantServerFaults.mockResolvedValue(0);
	getLastBackgroundWorkAt.mockResolvedValue(new Date(NOW.getTime() - 60_000));
	getProviderHealthByKeys.mockResolvedValue(
		new Map([
			["openai", "OPERATIONAL"],
			["anthropic", "OPERATIONAL"],
			["aws_s3", "OPERATIONAL"],
			["resend", "OPERATIONAL"],
		]),
	);
	getTenantConnectionSummary.mockResolvedValue({
		connectedProviders: [],
		unhealthyCount: 0,
		totalCount: 0,
	});
	listOpenComponentIncidents.mockResolvedValue([]);
	listOpenProviderIncidents.mockResolvedValue([]);
	listActiveStatusUpdates.mockResolvedValue([]);
}

function statusOf(
	overview: Awaited<ReturnType<typeof buildSystemHealthOverview>>,
	key: string,
) {
	const component = overview.components.find((c) => c.key === key);
	if (!component) throw new Error(`no component ${key} in overview`);
	return component;
}

beforeEach(() => {
	vi.clearAllMocks();
	allHealthy();
});

describe("all signals healthy", () => {
	it("reports every component operational", async () => {
		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		expect(overview.overallStatus).toBe("OPERATIONAL");
		expect(overview.components.length).toBeGreaterThan(0);
		for (const component of overview.components) {
			expect(component.status).toBe("OPERATIONAL");
		}
		expect(overview.generatedAt).toBe(NOW);
	});
});

describe("one failing signal degrades one component, never the page", () => {
	it("still returns an overview when the background-work read throws", async () => {
		getLastBackgroundWorkAt.mockRejectedValue(new Error("db down"));

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		expect(statusOf(overview, "background-jobs").status).toBe("UNKNOWN");
		// The page is the point: every other component still answered.
		expect(statusOf(overview, "core-api").status).toBe("OPERATIONAL");
		expect(statusOf(overview, "email-delivery").status).toBe("OPERATIONAL");
		expect(loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "system_health.signal_read_failed",
				signal: "background-work-freshness",
			}),
			expect.any(String),
		);
	});

	it("does not invent a problem when the fault-count read throws", async () => {
		countTenantServerFaults.mockRejectedValue(new Error("db down"));

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		// The fault count only ever moves this component AWAY from operational,
		// so a failed read must fall back to zero rather than to a red badge the
		// deployment has no evidence for.
		expect(statusOf(overview, "core-api").status).toBe("OPERATIONAL");
	});

	it("resolves rolled-up providers to UNKNOWN, not green, when their read throws", async () => {
		getProviderHealthByKeys.mockRejectedValue(new Error("db down"));

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		// Falling back to an empty map must NOT read as "all providers fine".
		expect(statusOf(overview, "ai-generation").status).toBe("UNKNOWN");
		expect(statusOf(overview, "file-storage").status).toBe("UNKNOWN");
		expect(statusOf(overview, "email-delivery").status).toBe("UNKNOWN");
	});

	it("survives every signal failing at once", async () => {
		const boom = () => Promise.reject(new Error("everything is down"));
		countTenantServerFaults.mockImplementation(boom);
		getLastBackgroundWorkAt.mockImplementation(boom);
		getProviderHealthByKeys.mockImplementation(boom);
		getTenantConnectionSummary.mockImplementation(boom);
		listOpenComponentIncidents.mockImplementation(boom);
		listOpenProviderIncidents.mockImplementation(boom);
		listActiveStatusUpdates.mockImplementation(boom);

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		expect(overview.components.length).toBeGreaterThan(0);
		expect(overview.announcements).toEqual([]);
		expect(overview.providerIssues).toEqual([]);
	});
});

describe("precedence: announcement > incident > inferred signal", () => {
	it("lets an announcement override a healthy signal", async () => {
		listActiveStatusUpdates.mockResolvedValue([
			{
				id: "a1",
				impact: "MAJOR",
				affectedComponentKeys: ["ai-generation"],
				affectedProviderKeys: [],
			},
		]);

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		const component = statusOf(overview, "ai-generation");
		expect(component.status).toBe("PARTIAL_OUTAGE");
		expect(component.source).toBe("announcement");
	});

	it("lets an announcement outrank an incident on the same component", async () => {
		listOpenComponentIncidents.mockResolvedValue([
			{ componentKey: "temporal-worker", severity: "SEV3" },
		]);
		listActiveStatusUpdates.mockResolvedValue([
			{
				id: "a1",
				impact: "CRITICAL",
				affectedComponentKeys: ["background-jobs"],
				affectedProviderKeys: [],
			},
		]);

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		const component = statusOf(overview, "background-jobs");
		expect(component.status).toBe("MAJOR_OUTAGE");
		expect(component.source).toBe("announcement");
	});

	it("treats an impact-NONE announcement as informational", async () => {
		listActiveStatusUpdates.mockResolvedValue([
			{
				id: "a1",
				impact: "NONE",
				affectedComponentKeys: ["core-api"],
				affectedProviderKeys: [],
			},
		]);

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		// Listed, but it must not repaint the component.
		expect(overview.announcements).toHaveLength(1);
		expect(statusOf(overview, "core-api").status).toBe("OPERATIONAL");
		expect(statusOf(overview, "core-api").source).toBe("signal");
	});

	it("lets an incident override a healthy signal", async () => {
		listOpenComponentIncidents.mockResolvedValue([
			{ componentKey: "temporal-worker", severity: "SEV1" },
		]);

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		const component = statusOf(overview, "background-jobs");
		expect(component.status).toBe("MAJOR_OUTAGE");
		expect(component.source).toBe("incident");
	});

	it("drops an incident whose componentKey no component claims", async () => {
		listOpenComponentIncidents.mockResolvedValue([
			{ componentKey: "not-a-registered-key", severity: "SEV1" },
		]);

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		// No phantom component, and nothing turns red on an unmapped key.
		expect(
			overview.components.some((c) => c.key === "not-a-registered-key"),
		).toBe(false);
		expect(overview.overallStatus).toBe("OPERATIONAL");
	});
});

describe("provider issues are derived from the tenant's own connections", () => {
	// No incident table carries an organizationId — they are all global. Relevance
	// is computed at read time by joining the tenant's DataConnection providers
	// against the registry, which is what keeps one tenant's status page from
	// showing an outage in a provider they do not use.
	const S3_INCIDENT = {
		providerKey: "s3",
		providerName: "S3 (Generic)",
		health: "MAJOR_OUTAGE",
		startedAt: new Date(NOW.getTime() - 600_000),
		statusPageUrl: undefined,
	};

	it("includes an incident for a provider the tenant is connected to", async () => {
		listOpenProviderIncidents.mockResolvedValue([S3_INCIDENT]);
		getTenantConnectionSummary.mockResolvedValue({
			connectedProviders: ["S3"],
			unhealthyCount: 0,
			totalCount: 1,
		});

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		expect(overview.providerIssues).toHaveLength(1);
		expect(overview.providerIssues[0]?.providerKey).toBe("s3");
	});

	it("hides the same incident from a tenant with no such connection", async () => {
		listOpenProviderIncidents.mockResolvedValue([S3_INCIDENT]);

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		expect(overview.providerIssues).toEqual([]);
	});
});

describe("announcements are scoped to providers the tenant actually uses", () => {
	// `StatusUpdate.affectedProviderKeys` exists for this and its schema comment
	// promises it — "an announcement about a provider the tenant never connected
	// is not shown to them" — but nothing implemented the filter, so every tenant
	// saw every provider announcement.
	const S3_ANNOUNCEMENT = {
		id: "a-s3",
		impact: "MAJOR",
		affectedComponentKeys: ["file-storage"],
		affectedProviderKeys: ["s3"],
	};

	it("hides a provider announcement from a tenant with no such connection", async () => {
		listActiveStatusUpdates.mockResolvedValue([S3_ANNOUNCEMENT]);

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		expect(overview.announcements).toEqual([]);
	});

	it("does NOT paint the component either, so there is no unexplained status", async () => {
		// The subtle half. Filtering only the list would leave `file-storage`
		// showing PARTIAL_OUTAGE with nothing on the page explaining why.
		listActiveStatusUpdates.mockResolvedValue([S3_ANNOUNCEMENT]);

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		expect(statusOf(overview, "file-storage").status).toBe("OPERATIONAL");
		expect(statusOf(overview, "file-storage").source).toBe("signal");
	});

	it("shows it to a tenant that connected that provider, and paints the component", async () => {
		listActiveStatusUpdates.mockResolvedValue([S3_ANNOUNCEMENT]);
		getTenantConnectionSummary.mockResolvedValue({
			connectedProviders: ["S3"],
			unhealthyCount: 0,
			totalCount: 1,
		});

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		expect(overview.announcements).toHaveLength(1);
		const component = statusOf(overview, "file-storage");
		expect(component.status).toBe("PARTIAL_OUTAGE");
		expect(component.source).toBe("announcement");
	});

	it("always shows a platform-wide announcement (empty provider list)", async () => {
		// A core-api outage is not provider scoped. An empty list must never be
		// read as "matches nothing".
		listActiveStatusUpdates.mockResolvedValue([
			{
				id: "a-platform",
				impact: "CRITICAL",
				affectedComponentKeys: ["core-api"],
				affectedProviderKeys: [],
			},
		]);

		const overview = await buildSystemHealthOverview(SCOPE, NOW);

		expect(overview.announcements).toHaveLength(1);
		expect(statusOf(overview, "core-api").status).toBe("MAJOR_OUTAGE");
	});
});
