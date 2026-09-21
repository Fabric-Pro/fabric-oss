/**
 * Turning the PM status sync on is ONE transaction (Fizzy #2304, spec D1.5).
 *
 * Switching it on saves the switch, enrols the project in the hourly poll,
 * clears every story's sync base and the last-run summary, and stamps a fresh
 * session. If any part of that fails, none of it may stick: a switch left on
 * over un-reset bases would let the next poll treat an old observation as the
 * ticket's last known state. The mocked update-project suite can only show the
 * operations were handed to `$transaction`; this one arms a test-only trigger
 * that fails the story reset and proves the rest rolled back with it, after a
 * positive control on a second project.
 *
 * Drives the real `updateProjectProcedure` handler against real rows. Only the
 * fire-and-forget request audit is mocked. Self-skips without a reachable
 * DATABASE_URL; `.github/workflows/db-integration.yml` runs it with an
 * exact-count guard.
 */

import { inspect } from "node:util";
import { db, Prisma } from "@repo/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hasReachableDatabaseUrl } from "../../prompts/__tests__/_helpers/db-availability";

vi.mock("../../../lib/audit", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../lib/audit")>()),
	recordAuditFromRequest: vi.fn(),
}));

import { updateProjectProcedure } from "../procedures/update-project";

const RUN = `${Date.now()}-${process.pid}`;
const USER = `pss-api-user-${RUN}`;
const ORG = `pss-api-org-${RUN}`;
const PROJECT_OK = `pss-api-ok-${RUN}`;
const PROJECT_CONTROL = `pss-api-control-${RUN}`;
const PROJECT_FAIL = `pss-api-fail-${RUN}`;
const FAIL_FN = `pss_test_fail_reset_${RUN.replace(/[^A-Za-z0-9]/g, "_")}`;
const OLD_SESSION = new Date("2026-09-01T08:00:00.000Z");
const BASE_AT = new Date("2026-09-20T08:00:00.000Z");
const OLD_LAST_RUN = {
	sessionAt: OLD_SESSION.toISOString(),
	fetch: {
		at: "2026-09-01T09:00:00.000Z",
		linked: 2,
		fetched: 2,
		failed: 0,
		notFound: 0,
		complete: true,
	},
};
const NULL_BASE = {
	pmStatusSyncBaseId: null,
	pmStatusSyncBaseAt: null,
	pmStatusSyncBaseLink: null,
	pmStatusSyncBaseFabricId: null,
};
const issueUrl = (n: number) =>
	`https://gitlab.example.com/example-group/example-project/-/issues/${n}`;

const statusIdByProject = new Map<string, string>();

async function seedProject(id: string) {
	await db.project.create({
		data: {
			id,
			name: `Status sync session ${RUN}`,
			userId: USER,
			organizationId: ORG,
			projectManagementMcpServerId: "key:gitlab-official",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "4711",
			projectManagementContainerName: "example-group/example-project",
			pmStatusSyncEnabled: false,
			adoStatePollActive: false,
			pmStatusSyncSessionAt: OLD_SESSION,
			pmStatusSyncLastRun: OLD_LAST_RUN,
		},
	});
	const status = await db.projectStoryStatus.create({
		data: {
			projectId: id,
			name: "Backlog",
			color: "#94a3b8",
			order: 0,
			isDefault: true,
		},
	});
	statusIdByProject.set(id, status.id);
	for (const n of [1, 2]) {
		await db.userStory.create({
			data: {
				projectId: id,
				statusId: status.id,
				identifier: `PSS-${n}`,
				title: `Linked story ${n}`,
				createdById: USER,
				externalId: String(n),
				externalUrl: issueUrl(n),
				pmStatusSyncBaseId: status.id,
				pmStatusSyncBaseAt: BASE_AT,
				pmStatusSyncBaseLink: issueUrl(n),
				pmStatusSyncBaseFabricId: status.id,
			},
		});
	}
}

function seededBases(projectId: string) {
	const statusId = statusIdByProject.get(projectId);
	return [1, 2].map((n) => ({
		pmStatusSyncBaseId: statusId,
		pmStatusSyncBaseAt: BASE_AT,
		pmStatusSyncBaseLink: issueUrl(n),
		pmStatusSyncBaseFabricId: statusId,
	}));
}

function enableStatusSync(projectId: string) {
	return updateProjectProcedure["~orpc"].handler({
		input: {
			id: projectId,
			organizationId: ORG,
			pmStatusSyncEnabled: true,
		},
		context: {
			user: { id: USER },
			session: { activeOrganizationId: ORG },
		},
	} as never);
}

const readProject = (id: string) =>
	db.project.findUniqueOrThrow({
		where: { id },
		select: {
			pmStatusSyncEnabled: true,
			adoStatePollActive: true,
			pmStatusSyncSessionAt: true,
			pmStatusSyncLastRun: true,
		},
	});

const readBases = (projectId: string) =>
	db.userStory.findMany({
		where: { projectId },
		orderBy: { identifier: "asc" },
		select: {
			pmStatusSyncBaseId: true,
			pmStatusSyncBaseAt: true,
			pmStatusSyncBaseLink: true,
			pmStatusSyncBaseFabricId: true,
		},
	});

async function armStoryResetFailure(projectId: string) {
	await db.$executeRawUnsafe(`
CREATE OR REPLACE FUNCTION "${FAIL_FN}"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
	IF OLD."projectId" = '${projectId}'
		AND OLD."pmStatusSyncBaseId" IS NOT NULL
		AND NEW."pmStatusSyncBaseId" IS NULL THEN
		RAISE EXCEPTION 'pm_status_sync_test: injected story-reset failure';
	END IF;
	RETURN NEW;
END;
$fn$`);
	await db.$executeRawUnsafe(
		`CREATE TRIGGER "${FAIL_FN}" BEFORE UPDATE ON "user_story" FOR EACH ROW EXECUTE FUNCTION "${FAIL_FN}"()`,
	);
}

async function disarmStoryResetFailure() {
	await db.$executeRawUnsafe(
		`DROP TRIGGER IF EXISTS "${FAIL_FN}" ON "user_story"`,
	);
	await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${FAIL_FN}"()`);
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"turning the PM status sync on (real Postgres, spec D1.5)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER}, ${"Status Sync API"}, ${`${USER}@example.com`}, true, true, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG}, ${"Status Sync API Org"}, ${ORG}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			// The switch is admin-only (D1.6). Without an org membership an
			// organization project's creator resolves to NO permissions
			// (`resolveEffectiveProjectPermissions` → source "none"), so every
			// call below would be FORBIDDEN — pattern of
			// decision-owner-delivery.integration.test.ts:103-110.
			await db.member.create({
				data: {
					organizationId: ORG,
					userId: USER,
					role: "owner",
					createdAt: now,
				},
			});
			for (const id of [PROJECT_OK, PROJECT_CONTROL, PROJECT_FAIL]) {
				await seedProject(id);
			}
		});

		afterAll(async () => {
			await disarmStoryResetFailure();
			const ids = [PROJECT_OK, PROJECT_CONTROL, PROJECT_FAIL];
			await db.userStory.deleteMany({
				where: { projectId: { in: ids } },
			});
			await db.projectStoryStatus.deleteMany({
				where: { projectId: { in: ids } },
			});
			await db.project.deleteMany({ where: { id: { in: ids } } });
			await db.member.deleteMany({
				where: { organizationId: ORG, userId: USER },
			});
		});

		it("saves the switch, enrols the project, clears every base and the last run, and stamps a fresh session", async () => {
			const before = Date.now();
			await enableStatusSync(PROJECT_OK);
			const after = Date.now();

			const project = await readProject(PROJECT_OK);
			expect(project.pmStatusSyncEnabled).toBe(true);
			expect(project.adoStatePollActive).toBe(true);
			expect(project.pmStatusSyncLastRun).toBeNull();
			expect(project.pmStatusSyncSessionAt).not.toBeNull();
			expect(
				project.pmStatusSyncSessionAt?.getTime(),
			).toBeGreaterThanOrEqual(before - 5_000);
			expect(
				project.pmStatusSyncSessionAt?.getTime(),
			).toBeLessThanOrEqual(after + 5_000);
			expect(await readBases(PROJECT_OK)).toEqual([NULL_BASE, NULL_BASE]);
		});

		it("rolls every part back when the story reset fails", async () => {
			await armStoryResetFailure(PROJECT_FAIL);
			try {
				// Positive control: the armed failure is scoped to one project, and
				// the same request commits in full for another.
				await enableStatusSync(PROJECT_CONTROL);
				expect(
					(await readProject(PROJECT_CONTROL)).pmStatusSyncEnabled,
				).toBe(true);
				expect(await readBases(PROJECT_CONTROL)).toEqual([
					NULL_BASE,
					NULL_BASE,
				]);

				// Precondition: the failure IS armed for the target project.
				const probe = await db.userStory
					.updateMany({
						where: { projectId: PROJECT_FAIL },
						data: { pmStatusSyncBaseId: null },
					})
					.then(
						() => null,
						(error: unknown) => error,
					);
				expect(inspect(probe, { depth: 8 })).toContain(
					"injected story-reset failure",
				);

				const failure = await enableStatusSync(PROJECT_FAIL).then(
					() => null,
					(error: unknown) => error,
				);
				// The request failed BECAUSE of the injected story-reset failure —
				// not a permission or validation refusal that never reached the
				// transaction.
				expect(failure).not.toBeNull();
				expect(inspect(failure, { depth: 8 })).toContain(
					"pm_status_sync_test: injected story-reset failure",
				);

				expect(await readProject(PROJECT_FAIL)).toEqual({
					pmStatusSyncEnabled: false,
					adoStatePollActive: false,
					pmStatusSyncSessionAt: OLD_SESSION,
					pmStatusSyncLastRun: OLD_LAST_RUN,
				});
				expect(await readBases(PROJECT_FAIL)).toEqual(
					seededBases(PROJECT_FAIL),
				);
			} finally {
				await disarmStoryResetFailure();
			}
		});
	},
);
