/**
 * Real-Postgres tests for automatic sync being ON by default on a new
 * coding-instructions repository sync (Fizzy #2878).
 *
 * The default lives in two places that must agree: the `automatic` column's
 * `DEFAULT true` (migration `20261002141000`) and the insert in
 * `upsertInstructionRepositorySync`. A mocked client can hold the second and
 * never the first, so this reads a row the database itself defaulted.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database exec dotenv -c -e ../../.env.local -- vitest run __tests__/instruction-sync-automatic-default.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, upsertInstructionRepositorySync } from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `sync-default-org-${RUN_ID}`;
const OWNER_ID = `sync-default-owner-${RUN_ID}`;

let integrationId = "";
const projectIds: string[] = [];

async function newProject(): Promise<string> {
	const project = await db.project.create({
		data: {
			name: "Sync Default Integration",
			userId: OWNER_ID,
			organizationId: ORGANIZATION_ID,
			techStack: [],
			features: [],
			tags: [],
		},
	});
	projectIds.push(project.id);
	return project.id;
}

function configuration(projectId: string, extra: { automatic?: boolean } = {}) {
	return {
		projectId,
		organizationId: ORGANIZATION_ID,
		userId: OWNER_ID,
		repositoryIntegrationId: integrationId,
		ref: "main",
		rootPath: "",
		...extra,
	};
}

async function storedAutomatic(projectId: string): Promise<boolean> {
	const row = await db.projectInstructionRepositorySync.findFirstOrThrow({
		where: { projectId, organizationId: ORGANIZATION_ID },
		select: { automatic: true },
	});
	return row.automatic;
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"automatic sync is on by default (Fizzy #2878)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: OWNER_ID,
					name: "Dev Example",
					email: `${OWNER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Sync Default Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const seedProject = await newProject();
			const integration = await db.projectRepositoryIntegration.create({
				data: {
					projectId: seedProject,
					provider: "GITHUB",
					authMethod: "OAUTH",
					repositoryUrl: `https://github.com/example-org/sync-default-${RUN_ID}`,
					repositoryOwner: "example-org",
					repositoryName: `sync-default-${RUN_ID}`,
				},
			});
			integrationId = integration.id;
		});

		afterAll(async () => {
			// Delete by the exact ids this run created, never by pattern.
			await db.project.deleteMany({ where: { id: { in: projectIds } } });
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({ where: { id: OWNER_ID } });
			await db.$disconnect();
		});

		it("the column's own default is true: a row inserted by plain SQL without it reads true", async () => {
			const projectId = await newProject();

			await db.$executeRaw`
				INSERT INTO "project_instruction_repository_sync"
					("id", "projectId", "organizationId", "userId", "repositoryIntegrationId", "ref", "updatedAt")
				VALUES
					(${`sync-default-${RUN_ID}`}, ${projectId}, ${ORGANIZATION_ID}, ${OWNER_ID}, ${integrationId}, 'main', now())`;

			expect(await storedAutomatic(projectId)).toBe(true);
		});

		it("a first configure that does not say reads true", async () => {
			const projectId = await newProject();

			const result = await upsertInstructionRepositorySync(
				configuration(projectId),
			);

			expect(result?.sync.automatic).toBe(true);
			expect(await storedAutomatic(projectId)).toBe(true);
		});

		it("a first configure that turns it off keeps it off", async () => {
			const projectId = await newProject();

			await upsertInstructionRepositorySync(
				configuration(projectId, { automatic: false }),
			);

			expect(await storedAutomatic(projectId)).toBe(false);
		});

		it("re-configuring without saying does not turn a deliberate off back on", async () => {
			const projectId = await newProject();
			await upsertInstructionRepositorySync(
				configuration(projectId, { automatic: false }),
			);

			await upsertInstructionRepositorySync(configuration(projectId));

			expect(await storedAutomatic(projectId)).toBe(false);
		});
	},
);
