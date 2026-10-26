/**
 * RLS regression for the four monitoring / incident tables.
 *
 * Tables under test (all four configured as `admin_only` in
 * `packages/database/scripts/apply-rls-direct.ts` -- policy is
 * `USING (false)` so every per-tenant connection sees zero rows):
 *   - error_rate_incident
 *   - integration_incident
 *   - incident_event
 *   - integration_provider_registry
 *
 * Why admin_only?
 * ---------------
 * These tables are GLOBAL -- they describe service-wide state. There is no
 * per-tenant column to gate access on, so the policy denies all per-
 * tenant reads, and admin code paths use the direct/superuser connection
 * (via `adminProcedure`) which bypasses FORCE ROW LEVEL SECURITY.
 *
 * Test strategy
 * -------------
 * Identical to `rls-isolation.test.ts`:
 *   1. Insert a row via the direct connection (Prisma client connects as
 *      the table owner / superuser and bypasses FORCE RLS).
 *   2. Use the shared restricted-role harness, which verifies NOSUPERUSER
 *      and NOBYPASSRLS and sets transaction-local tenant context.
 *   3. Read as the administrator again as a positive control.
 *
 * Excluded from the default `pnpm --filter @repo/database test` run via
 * the package's vitest config (`INTEGRATION_TESTS`). Run locally with
 * `pnpm --filter @repo/database test:rls` after `apply:rls`.
 *
 * Status: this file IS included in the integration suite (the
 * `__tests__/rls/*` glob is picked up by vitest's `include:
 * ["__tests__/**\/*.test.ts"]` pattern), so we follow the existing
 * convention of self-skipping when no DATABASE_URL is present.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../prisma/client";
import { hasReachableDatabaseUrl } from "../_helpers/db-availability";
import { asRlsRole, ensureRlsTestRole } from "../_helpers/rls-role";

// Reachable-DB gate: rejects the CI/local placeholder DATABASE_URL, not
// just an unset one (see _helpers/db-availability.ts).
const HAS_DB = hasReachableDatabaseUrl();

const TEST_USER_ID = "test-user-rls-incidents";

describe.skipIf(!HAS_DB)(
	"RLS policies — monitoring/incident tables (admin_only)",
	() => {
		let errorRateIncidentId: string;
		let integrationIncidentId: string;
		let incidentEventId: string;
		const providerRegistryKey = "test-rls-provider-key";

		beforeAll(async () => {
			// Inserts as the table owner / superuser bypass FORCE RLS.
			// The harness verifies that tenant reads cannot bypass RLS.
			await ensureRlsTestRole();

			// `createdAt`/`updatedAt` carry no default on User, so they are
			// required here. The cast this call used to carry hid that: the
			// omission only surfaced at runtime, against a real database, in a
			// suite that does not run in CI.
			const now = new Date();
			await db.user.upsert({
				where: { id: TEST_USER_ID },
				update: {},
				create: {
					id: TEST_USER_ID,
					name: "Test User RLS Incidents",
					email: "rls-incidents@example.com",
					emailVerified: true,
					onboardingComplete: false,
					createdAt: now,
					updatedAt: now,
				},
			});

			errorRateIncidentId = (
				await db.errorRateIncident.create({
					data: {
						alertName: "AppErrorBudgetBurn_Critical",
						severity: "SEV1",
						service: "api",
						feature: "ai_generation",
						errorCount: 50,
					},
				})
			).id;

			integrationIncidentId = (
				await db.integrationIncident.create({
					data: {
						providerKey: "test-provider",
						providerName: "Test Provider",
						severity: "SEV2",
						health: "PARTIAL_OUTAGE",
						detectionMethod: "STATUSPAGE_POLL",
					},
				})
			).id;

			incidentEventId = (
				await db.incidentEvent.create({
					data: {
						integrationIncidentId,
						eventType: "FIRED",
					},
				})
			).id;

			await db.integrationProviderRegistry.upsert({
				where: { providerKey: providerRegistryKey },
				create: {
					providerKey: providerRegistryKey,
					displayName: "Test RLS Provider",
				},
				update: {},
			});
		});

		afterAll(async () => {
			// Cascade clean up — IncidentEvent has FK ON DELETE CASCADE.
			await db.incidentEvent
				.delete({ where: { id: incidentEventId } })
				.catch(() => undefined);
			await db.errorRateIncident
				.delete({ where: { id: errorRateIncidentId } })
				.catch(() => undefined);
			await db.integrationIncident
				.delete({ where: { id: integrationIncidentId } })
				.catch(() => undefined);
			await db.integrationProviderRegistry
				.delete({ where: { providerKey: providerRegistryKey } })
				.catch(() => undefined);
			await db.user
				.delete({ where: { id: TEST_USER_ID } })
				.catch(() => undefined);
		});

		describe("per-tenant reads are denied (admin_only policy)", () => {
			it("denies SELECT on error_rate_incident from a personal tenant context", async () => {
				const row = await asRlsRole(
					{
						type: "personal",
						tenantId: TEST_USER_ID,
						userId: TEST_USER_ID,
					},
					(tx) =>
						tx.errorRateIncident.findUnique({
							where: { id: errorRateIncidentId },
						}),
				);
				expect(row).toBeNull();
			});

			it("denies SELECT on integration_incident from a personal tenant context", async () => {
				const row = await asRlsRole(
					{
						type: "personal",
						tenantId: TEST_USER_ID,
						userId: TEST_USER_ID,
					},
					(tx) =>
						tx.integrationIncident.findUnique({
							where: { id: integrationIncidentId },
						}),
				);
				expect(row).toBeNull();
			});

			it("denies SELECT on incident_event from a personal tenant context", async () => {
				const row = await asRlsRole(
					{
						type: "personal",
						tenantId: TEST_USER_ID,
						userId: TEST_USER_ID,
					},
					(tx) =>
						tx.incidentEvent.findUnique({
							where: { id: incidentEventId },
						}),
				);
				expect(row).toBeNull();
			});

			it("denies SELECT on integration_provider_registry from a personal tenant context", async () => {
				const row = await asRlsRole(
					{
						type: "personal",
						tenantId: TEST_USER_ID,
						userId: TEST_USER_ID,
					},
					(tx) =>
						tx.integrationProviderRegistry.findUnique({
							where: { providerKey: providerRegistryKey },
						}),
				);
				expect(row).toBeNull();
			});

			it("denies findMany across error_rate_incident from a personal tenant context", async () => {
				const rows = await asRlsRole(
					{
						type: "personal",
						tenantId: TEST_USER_ID,
						userId: TEST_USER_ID,
					},
					(tx) =>
						tx.errorRateIncident.findMany({
							where: { id: errorRateIncidentId },
						}),
				);
				expect(rows).toEqual([]);
			});

			it("denies findMany across integration_incident from a personal tenant context", async () => {
				const rows = await asRlsRole(
					{
						type: "personal",
						tenantId: TEST_USER_ID,
						userId: TEST_USER_ID,
					},
					(tx) =>
						tx.integrationIncident.findMany({
							where: { id: integrationIncidentId },
						}),
				);
				expect(rows).toEqual([]);
			});
		});

		describe("admin / superuser reads succeed", () => {
			it("reads error_rate_incident as the administrator (admin bypass)", async () => {
				const row = await db.errorRateIncident.findUnique({
					where: { id: errorRateIncidentId },
				});
				// This administrator connection bypasses RLS, providing a
				// positive control for the restricted-role reads above.
				expect(row).not.toBeNull();
				expect(row?.id).toBe(errorRateIncidentId);
			});

			it("reads integration_incident as the administrator", async () => {
				const row = await db.integrationIncident.findUnique({
					where: { id: integrationIncidentId },
				});
				expect(row).not.toBeNull();
				expect(row?.id).toBe(integrationIncidentId);
			});

			it("reads incident_event as the administrator", async () => {
				const row = await db.incidentEvent.findUnique({
					where: { id: incidentEventId },
				});
				expect(row).not.toBeNull();
				expect(row?.id).toBe(incidentEventId);
			});

			it("reads integration_provider_registry as the administrator", async () => {
				const row = await db.integrationProviderRegistry.findUnique({
					where: { providerKey: providerRegistryKey },
				});
				expect(row).not.toBeNull();
				expect(row?.providerKey).toBe(providerRegistryKey);
			});
		});

		describe("organization tenant context is also denied", () => {
			it("denies SELECT on integration_incident from an organization tenant context", async () => {
				const row = await asRlsRole(
					{
						type: "organization",
						tenantId: "example-org",
						userId: TEST_USER_ID,
					},
					(tx) =>
						tx.integrationIncident.findUnique({
							where: { id: integrationIncidentId },
						}),
				);
				expect(row).toBeNull();
			});

			it("denies SELECT on error_rate_incident from an organization tenant context", async () => {
				const row = await asRlsRole(
					{
						type: "organization",
						tenantId: "example-org",
						userId: TEST_USER_ID,
					},
					(tx) =>
						tx.errorRateIncident.findUnique({
							where: { id: errorRateIncidentId },
						}),
				);
				expect(row).toBeNull();
			});
		});
	},
);
