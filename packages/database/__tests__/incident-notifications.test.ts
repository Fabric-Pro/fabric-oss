/**
 * Tests for `createIncidentNotification`.
 *
 * Coverage (v3 admin-incidents pass):
 *   - Severity routing: SEV-1 / SEV-2 / SEV-3 → admin rows only.
 *     The previous per-org INTEGRATION_INCIDENT branch was dropped because
 *     platform-wide incident triage is admin-only; org owners no longer
 *     receive incident inbox rows. The legacy `target = "orgs"` override
 *     path is still exercised because tests / migrations may explicitly
 *     opt-in (e.g., to back-fill historical rows during the cutover).
 *   - NotificationType selection: SYSTEM_INCIDENT for admin rows;
 *     INTEGRATION_INCIDENT only when the explicit `target` override
 *     forces the per-org path (legacy).
 *   - Payload shape conforms to the Zod schema documented in
 *     packages/api/modules/notifications/lib/payloads.ts.
 *   - Legacy per-org routing (only via explicit target override):
 *       * uses IntegrationProviderRegistry.dataConnectionProvider to map
 *         registry key → DataConnection.provider enum value;
 *       * only org owners receive org-scoped rows;
 *       * personal-scope DataConnections (no organizationId) emit a
 *         personal-scope Notification (organizationId: null);
 *       * paused / expired DataConnections are excluded.
 *   - Dedupe collision (P2002) is swallowed.
 *   - Self-skip is not relevant here (no actor user).
 *   - XOR invariant: each Notification has organizationId XOR userId
 *     scope per the existing notification model.
 *
 * Run with: pnpm --filter @repo/database test __tests__/incident-notifications.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindManyMock = vi.fn();
const memberFindManyMock = vi.fn();
const dataConnectionFindManyMock = vi.fn();
const integrationProviderRegistryFindUniqueMock = vi.fn();
const notificationCreateMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		user: {
			findMany: (args: unknown) => userFindManyMock(args),
		},
		member: {
			findMany: (args: unknown) => memberFindManyMock(args),
		},
		dataConnection: {
			findMany: (args: unknown) => dataConnectionFindManyMock(args),
		},
		integrationProviderRegistry: {
			findUnique: (args: unknown) =>
				integrationProviderRegistryFindUniqueMock(args),
		},
		notification: {
			create: (args: unknown) => notificationCreateMock(args),
		},
	},
	Prisma: {},
}));

import { createIncidentNotification } from "../prisma/queries/incident-notifications";

const FIRED_AT = new Date("2026-05-16T12:34:56.000Z");

function makeP2002(): Error & { code: string } {
	const err = new Error("unique violation") as Error & { code: string };
	err.code = "P2002";
	return err;
}

beforeEach(() => {
	userFindManyMock.mockReset();
	memberFindManyMock.mockReset();
	dataConnectionFindManyMock.mockReset();
	integrationProviderRegistryFindUniqueMock.mockReset();
	notificationCreateMock.mockReset();

	// Sensible defaults: no admins, no orgs, no data connections.
	userFindManyMock.mockResolvedValue([]);
	memberFindManyMock.mockResolvedValue([]);
	dataConnectionFindManyMock.mockResolvedValue([]);
	integrationProviderRegistryFindUniqueMock.mockResolvedValue(null);
	notificationCreateMock.mockResolvedValue({ id: "n-stub" });
});

describe("createIncidentNotification — admin routing (SEV-3)", () => {
	it("inserts a SYSTEM_INCIDENT row per admin only", async () => {
		userFindManyMock.mockResolvedValue([
			{ id: "admin-1" },
			{ id: "admin-2" },
		]);

		const result = await createIncidentNotification({
			source: "errorRate",
			incidentId: "inc-1",
			severity: "sev3",
			title: "SEV-3: api/pm_sync error budget burn",
			summary: "1x burn rate for 6h",
			link: "/app/admin/monitoring?incident=inc-1",
			startedAt: FIRED_AT,
		});

		expect(result.adminRowsWritten).toBe(2);
		expect(result.perOrgRowsWritten).toBe(0);
		expect(result.skipped).toBe(false);

		// User lookup filters for system admins.
		const userArgs = userFindManyMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
		};
		expect(userArgs.where).toMatchObject({ role: "admin" });

		// One create per admin, all SYSTEM_INCIDENT, organizationId: null.
		expect(notificationCreateMock).toHaveBeenCalledTimes(2);
		for (const call of notificationCreateMock.mock.calls) {
			const data = (call[0] as { data: Record<string, unknown> }).data;
			expect(data.type).toBe("SYSTEM_INCIDENT");
			expect(data.category).toBe("SYSTEM");
			expect(data.organizationId).toBeNull();
			expect(data.link).toBe("/app/admin/monitoring?incident=inc-1");
		}

		// Per-org paths must not have been queried for SEV-3 routing.
		expect(dataConnectionFindManyMock).not.toHaveBeenCalled();
		expect(memberFindManyMock).not.toHaveBeenCalled();
	});

	it("emits payload with the documented incident shape", async () => {
		userFindManyMock.mockResolvedValue([{ id: "admin-1" }]);

		await createIncidentNotification({
			source: "errorRate",
			incidentId: "inc-1",
			severity: "sev3",
			title: "SEV-3",
			summary: "burn",
			link: "/app/admin/monitoring?incident=inc-1",
			startedAt: FIRED_AT,
		});

		const data = (
			notificationCreateMock.mock.calls[0]?.[0] as {
				data: { payload: Record<string, unknown>; dedupeKey: string };
			}
		).data;

		// Payload fields match the Zod schema.
		expect(data.payload).toMatchObject({
			incidentId: "inc-1",
			severity: "sev3",
			summary: "burn",
			link: "/app/admin/monitoring?incident=inc-1",
			startedAt: FIRED_AT.toISOString(),
		});
		// providerKey is intentionally absent for an errorRate-source row.
		expect(data.payload.providerKey).toBeUndefined();

		// Dedupe key is per (incidentId, recipient userId).
		expect(data.dedupeKey).toBe("system-incident-inc-1:admin-1");
	});

	it("returns { skipped: true } when no admins are configured", async () => {
		userFindManyMock.mockResolvedValue([]);

		const result = await createIncidentNotification({
			source: "errorRate",
			incidentId: "inc-1",
			severity: "sev3",
			title: "SEV-3",
			summary: "burn",
			link: "/app/admin/monitoring?incident=inc-1",
			startedAt: FIRED_AT,
		});

		expect(result.adminRowsWritten).toBe(0);
		expect(result.perOrgRowsWritten).toBe(0);
		// `skipped` here means severity-target-mapped-to-none; an empty admin
		// table is a normal `adminRowsWritten: 0` outcome, not a routing skip.
		expect(result.skipped).toBe(false);
	});
});

describe("createIncidentNotification — integration routing (SEV-2)", () => {
	it("emits admin-only rows by default; per-org fan-out is suppressed (v3 admin-only)", async () => {
		userFindManyMock.mockResolvedValue([{ id: "admin-1" }]);
		integrationProviderRegistryFindUniqueMock.mockResolvedValue({
			dataConnectionProvider: "NOTION",
		});
		dataConnectionFindManyMock.mockResolvedValue([
			{ organizationId: "org-A", userId: null },
			{ organizationId: "org-B", userId: null },
		]);
		memberFindManyMock.mockResolvedValue([
			{ userId: "owner-A", organizationId: "org-A" },
			{ userId: "owner-B", organizationId: "org-B" },
		]);

		const result = await createIncidentNotification({
			source: "integration",
			incidentId: "inc-42",
			severity: "sev2",
			providerKey: "notion",
			title: "Notion may be affected",
			summary: "Notion reports a partial outage",
			link: "/app/admin/monitoring?incident=inc-42",
			startedAt: FIRED_AT,
		});

		// 1 admin row, 0 org-owner rows by default.
		expect(result.adminRowsWritten).toBe(1);
		expect(result.perOrgRowsWritten).toBe(0);

		// Per-org branch must not be exercised.
		expect(dataConnectionFindManyMock).not.toHaveBeenCalled();
		expect(memberFindManyMock).not.toHaveBeenCalled();

		// Only SYSTEM_INCIDENT rows hit the create call.
		for (const call of notificationCreateMock.mock.calls) {
			const data = (call[0] as { data: { type: string } }).data;
			expect(data.type).toBe("SYSTEM_INCIDENT");
		}
	});

	it("legacy per-org fan-out is reachable via explicit `target: 'orgs'` override (regression: opt-in only)", async () => {
		userFindManyMock.mockResolvedValue([{ id: "admin-1" }]);
		integrationProviderRegistryFindUniqueMock.mockResolvedValue({
			dataConnectionProvider: "NOTION",
		});
		dataConnectionFindManyMock.mockResolvedValue([
			{ organizationId: "org-A", userId: null },
		]);
		memberFindManyMock.mockResolvedValue([
			{ userId: "owner-A", organizationId: "org-A" },
		]);

		const result = await createIncidentNotification({
			source: "integration",
			incidentId: "inc-legacy",
			severity: "sev2",
			providerKey: "notion",
			title: "Notion may be affected",
			summary: "Legacy per-org row backfill",
			link: "/app/admin/monitoring?incident=inc-legacy",
			startedAt: FIRED_AT,
			target: "orgs",
		});

		expect(result.adminRowsWritten).toBe(0);
		expect(result.perOrgRowsWritten).toBe(1);

		// One INTEGRATION_INCIDENT row, scoped to the org owner.
		const integrationRows = notificationCreateMock.mock.calls
			.map((c) => (c[0] as { data: Record<string, unknown> }).data)
			.filter((d) => d.type === "INTEGRATION_INCIDENT");
		expect(integrationRows).toHaveLength(1);
		expect(integrationRows[0]?.organizationId).toBe("org-A");
	});

	it("emits a personal-scope row when `target: 'orgs'` is passed for a personal DataConnection (legacy)", async () => {
		userFindManyMock.mockResolvedValue([]);
		integrationProviderRegistryFindUniqueMock.mockResolvedValue({
			dataConnectionProvider: "GITHUB",
		});
		dataConnectionFindManyMock.mockResolvedValue([
			{ organizationId: null, userId: "user-personal-1" },
		]);
		memberFindManyMock.mockResolvedValue([]);

		const result = await createIncidentNotification({
			source: "integration",
			incidentId: "inc-7",
			severity: "sev2",
			providerKey: "github",
			title: "GitHub may be affected",
			summary: "GitHub reports a major outage",
			link: "/app/settings/integrations",
			startedAt: FIRED_AT,
			target: "orgs",
		});

		expect(result.perOrgRowsWritten).toBe(1);

		const personalRow = (
			notificationCreateMock.mock.calls[0]?.[0] as {
				data: Record<string, unknown>;
			}
		).data;
		// XOR is preserved: organizationId is null, userId is the personal user.
		expect(personalRow.userId).toBe("user-personal-1");
		expect(personalRow.organizationId).toBeNull();
		expect(personalRow.type).toBe("INTEGRATION_INCIDENT");
	});

	it("filters out paused / expired DataConnections when the legacy per-org override is used", async () => {
		integrationProviderRegistryFindUniqueMock.mockResolvedValue({
			dataConnectionProvider: "NOTION",
		});
		dataConnectionFindManyMock.mockResolvedValue([]);

		await createIncidentNotification({
			source: "integration",
			incidentId: "inc-noop",
			severity: "sev2",
			providerKey: "notion",
			title: "Notion may be affected",
			summary: "Notion reports a partial outage",
			link: "/app/settings/integrations",
			startedAt: FIRED_AT,
			target: "orgs",
		});

		const dcArgs = dataConnectionFindManyMock.mock.calls[0]?.[0] as {
			where: { status: { in: string[] } };
		};
		// Only active statuses are queried; PAUSED + EXPIRED are excluded.
		expect(dcArgs.where.status.in).toEqual([
			"CONNECTED",
			"SYNCING",
			"ERROR",
		]);
		// No active connections → no per-org rows.
		expect(
			notificationCreateMock.mock.calls.filter((c) => {
				const data = (c[0] as { data: { type: string } }).data;
				return data.type === "INTEGRATION_INCIDENT";
			}),
		).toHaveLength(0);
	});

	it("skips per-org rollup when registry has no DataConnectionProvider mapping (platform providers)", async () => {
		userFindManyMock.mockResolvedValue([{ id: "admin-1" }]);
		// Platform provider (e.g., OpenAI) — no DataConnection counterpart.
		integrationProviderRegistryFindUniqueMock.mockResolvedValue({
			dataConnectionProvider: null,
		});

		const result = await createIncidentNotification({
			source: "integration",
			incidentId: "inc-99",
			severity: "sev2",
			providerKey: "openai",
			title: "OpenAI may be affected",
			summary: "OpenAI reports a partial outage",
			link: "/app/admin/monitoring?incident=inc-99",
			startedAt: FIRED_AT,
		});

		expect(result.adminRowsWritten).toBe(1);
		expect(result.perOrgRowsWritten).toBe(0);
		// DataConnection lookup is bypassed entirely.
		expect(dataConnectionFindManyMock).not.toHaveBeenCalled();
	});
});

describe("createIncidentNotification — SEV-1 routing (admin-only by default)", () => {
	it("emits admin rows only for integration-source SEV-1 (per-org branch suppressed)", async () => {
		userFindManyMock.mockResolvedValue([{ id: "admin-1" }]);
		integrationProviderRegistryFindUniqueMock.mockResolvedValue({
			dataConnectionProvider: "STRIPE_PLACEHOLDER",
		});
		dataConnectionFindManyMock.mockResolvedValue([
			{ organizationId: "org-A", userId: null },
		]);
		memberFindManyMock.mockResolvedValue([
			{ userId: "owner-A", organizationId: "org-A" },
		]);

		const result = await createIncidentNotification({
			source: "integration",
			incidentId: "inc-100",
			severity: "sev1",
			providerKey: "stripe",
			title: "SEV-1: Stripe major outage",
			summary: "Stripe reports a major outage; payments unavailable",
			link: "/app/admin/monitoring?incident=inc-100",
			startedAt: FIRED_AT,
		});

		expect(result.adminRowsWritten).toBe(1);
		expect(result.perOrgRowsWritten).toBe(0);

		// Per-org branch is not exercised at all.
		expect(dataConnectionFindManyMock).not.toHaveBeenCalled();
		expect(memberFindManyMock).not.toHaveBeenCalled();

		const types = notificationCreateMock.mock.calls.map(
			(c) => (c[0] as { data: { type: string } }).data.type,
		);
		expect(types).toContain("SYSTEM_INCIDENT");
		expect(types).not.toContain("INTEGRATION_INCIDENT");
	});

	it("emits admin only when source is errorRate (no integration → no per-org rollup)", async () => {
		userFindManyMock.mockResolvedValue([{ id: "admin-1" }]);

		const result = await createIncidentNotification({
			source: "errorRate",
			incidentId: "inc-burn",
			severity: "sev1",
			title: "SEV-1: api/ai_generation error budget burn",
			summary: "14.4x burn rate for 1h",
			link: "/app/admin/monitoring?incident=inc-burn",
			startedAt: FIRED_AT,
		});

		expect(result.adminRowsWritten).toBe(1);
		expect(result.perOrgRowsWritten).toBe(0);
		// No provider lookup happens — errorRate source bypasses per-org.
		expect(
			integrationProviderRegistryFindUniqueMock,
		).not.toHaveBeenCalled();
	});
});

describe("createIncidentNotification — dedupe + override behavior", () => {
	it("swallows P2002 dedupe collisions and counts them as not-written", async () => {
		userFindManyMock.mockResolvedValue([
			{ id: "admin-1" },
			{ id: "admin-2" },
		]);
		notificationCreateMock
			.mockResolvedValueOnce({ id: "n-1" }) // first admin succeeds
			.mockRejectedValueOnce(makeP2002()); // second admin already has unread row

		const result = await createIncidentNotification({
			source: "errorRate",
			incidentId: "inc-1",
			severity: "sev3",
			title: "SEV-3",
			summary: "burn",
			link: "/app/admin/monitoring?incident=inc-1",
			startedAt: FIRED_AT,
		});

		expect(result.adminRowsWritten).toBe(1);
		expect(notificationCreateMock).toHaveBeenCalledTimes(2);
	});

	it("respects an explicit `target` override (admins-only for a recovery row)", async () => {
		userFindManyMock.mockResolvedValue([{ id: "admin-1" }]);
		integrationProviderRegistryFindUniqueMock.mockResolvedValue({
			dataConnectionProvider: "NOTION",
		});

		const result = await createIncidentNotification({
			source: "integration",
			incidentId: "inc-1",
			severity: "sev1",
			providerKey: "notion",
			title: "Resolved: Notion recovered",
			summary: "Notion is operational again",
			link: "/app/{slug}/settings/integrations",
			startedAt: FIRED_AT,
			target: "admins",
		});

		expect(result.adminRowsWritten).toBe(1);
		expect(result.perOrgRowsWritten).toBe(0);
		// Per-org path skipped because target was overridden.
		expect(dataConnectionFindManyMock).not.toHaveBeenCalled();
	});

	it("truncates summary that exceeds 280 chars before persisting", async () => {
		userFindManyMock.mockResolvedValue([{ id: "admin-1" }]);
		const longSummary = "x".repeat(400);

		await createIncidentNotification({
			source: "errorRate",
			incidentId: "inc-long",
			severity: "sev3",
			title: "SEV-3",
			summary: longSummary,
			link: "/app/admin/monitoring?incident=inc-long",
			startedAt: FIRED_AT,
		});

		const data = (
			notificationCreateMock.mock.calls[0]?.[0] as {
				data: {
					snippet: string;
					payload: { summary: string };
				};
			}
		).data;
		// Both snippet and payload.summary are bounded.
		expect(data.snippet.length).toBeLessThanOrEqual(280);
		expect(data.payload.summary.length).toBeLessThanOrEqual(280);
		expect(data.snippet.endsWith("…")).toBe(true);
	});
});

describe("createIncidentNotification — XOR invariant", () => {
	it("admin rows always carry organizationId: null (system-scope)", async () => {
		userFindManyMock.mockResolvedValue([{ id: "admin-1" }]);

		await createIncidentNotification({
			source: "errorRate",
			incidentId: "inc-x",
			severity: "sev3",
			title: "SEV-3",
			summary: "burn",
			link: "/app/admin/monitoring?incident=inc-x",
			startedAt: FIRED_AT,
		});

		const data = (
			notificationCreateMock.mock.calls[0]?.[0] as {
				data: Record<string, unknown>;
			}
		).data;
		expect(data.organizationId).toBeNull();
		expect(data.userId).toBe("admin-1");
	});

	it("legacy org-scope rows carry both organizationId AND userId when forced via `target: 'orgs'`", async () => {
		integrationProviderRegistryFindUniqueMock.mockResolvedValue({
			dataConnectionProvider: "NOTION",
		});
		dataConnectionFindManyMock.mockResolvedValue([
			{ organizationId: "org-A", userId: null },
		]);
		memberFindManyMock.mockResolvedValue([
			{ userId: "owner-A", organizationId: "org-A" },
		]);

		await createIncidentNotification({
			source: "integration",
			incidentId: "inc-y",
			severity: "sev2",
			providerKey: "notion",
			title: "Notion may be affected",
			summary: "outage",
			link: "/app/settings/integrations",
			startedAt: FIRED_AT,
			target: "orgs",
		});

		const orgData = notificationCreateMock.mock.calls
			.map((c) => (c[0] as { data: Record<string, unknown> }).data)
			.find((d) => d.type === "INTEGRATION_INCIDENT");
		expect(orgData).toBeTruthy();
		// Org-scoped: organizationId set, userId set (the owner recipient).
		expect(orgData?.organizationId).toBe("org-A");
		expect(orgData?.userId).toBe("owner-A");
	});

	it("regression (v3 admin-only): org owners do NOT receive incident rows for default-routed integration SEV-1 / SEV-2", async () => {
		userFindManyMock.mockResolvedValue([{ id: "admin-1" }]);
		integrationProviderRegistryFindUniqueMock.mockResolvedValue({
			dataConnectionProvider: "NOTION",
		});
		dataConnectionFindManyMock.mockResolvedValue([
			{ organizationId: "org-A", userId: null },
		]);
		memberFindManyMock.mockResolvedValue([
			{ userId: "owner-A", organizationId: "org-A" },
		]);

		for (const sev of ["sev1", "sev2"] as const) {
			notificationCreateMock.mockClear();
			memberFindManyMock.mockClear();
			dataConnectionFindManyMock.mockClear();

			await createIncidentNotification({
				source: "integration",
				incidentId: `inc-${sev}`,
				severity: sev,
				providerKey: "notion",
				title: `${sev}: Notion outage`,
				summary: "Notion may be affected",
				link: `/app/admin/monitoring?incident=inc-${sev}`,
				startedAt: FIRED_AT,
			});

			// No INTEGRATION_INCIDENT row ever lands on an org owner inbox
			// without an explicit per-org target override.
			const integrationRows = notificationCreateMock.mock.calls
				.map((c) => (c[0] as { data: { type: string } }).data)
				.filter((d) => d.type === "INTEGRATION_INCIDENT");
			expect(integrationRows).toHaveLength(0);

			// Member + DataConnection lookups are not performed.
			expect(memberFindManyMock).not.toHaveBeenCalled();
			expect(dataConnectionFindManyMock).not.toHaveBeenCalled();
		}
	});
});
