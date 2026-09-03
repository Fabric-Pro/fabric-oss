/**
 * The binding unique key rejects a duplicate — proven against real Postgres.
 *
 * Until migration 20260903100000 it did not. Postgres treats NULL as distinct
 * from NULL in a plain unique index, and every row shape this table writes
 * carries at least one NULL in the composite key: SYSTEM nulls
 * userId/organizationId/projectId, an org-wide ORG row nulls userId/projectId,
 * a PROJECT row nulls userId, a USER row nulls organizationId/projectId, and
 * every non-stage binding nulls storyKind. So the constraint only ever bound a
 * fully-non-null 8-tuple that the schema never produces, and two concurrent
 * binds could leave two `isDefault` rows for one action pointing at different
 * prompt versions — after which `getBoundPromptVersion` picked between them in
 * whatever order Postgres returned.
 *
 * Every other test of this is a mock, and a mock cannot have an opinion about
 * NULL semantics. This one inserts rows.
 *
 * Writes go through raw SQL rather than `bindPromptVersion`, deliberately: that
 * function reads first and takes an update path, which would step around the
 * very constraint under test.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/prompt-binding-unique-key.integration.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN = `${Date.now()}-${process.pid}`;
const ORG = `uk-org-${RUN}`;
const USER = `uk-user-${RUN}`;
const OTHER_USER = `uk-other-${RUN}`;
const PROJECT = `uk-proj-${RUN}`;
const OTHER_PROJECT = `uk-proj2-${RUN}`;
const PROMPT = `uk-prompt-${RUN}`;
const VERSION_A = `uk-va-${RUN}`;
const VERSION_B = `uk-vb-${RUN}`;
const AGENT = `uk_agent_${RUN}`;
const DOC = "GENERAL";

/**
 * One binding row, written straight to the table. `scope` is the column, so a
 * PROJECT-tier row is ORG scope with a projectId.
 */
const insertBinding = (opts: {
	id: string;
	versionId: string;
	userId?: string | null;
	organizationId?: string | null;
	projectId?: string | null;
}) =>
	db.$executeRaw(Prisma.sql`
		INSERT INTO "prompt_binding" (id, "targetType", "targetKey", "documentType",
			"storyKind", scope, "userId", "organizationId", "projectId",
			"promptVersionId", "isDefault", "createdAt", "updatedAt")
		VALUES (${opts.id}, 'AGENT'::"PromptTargetType", ${AGENT}, ${DOC},
			NULL, ${opts.userId ? "USER" : "ORG"}::"PromptScope",
			${opts.userId ?? null}, ${opts.organizationId ?? null},
			${opts.projectId ?? null}, ${opts.versionId}, true, NOW(), NOW())`);

describe.skipIf(!hasReachableDatabaseUrl())(
	"prompt binding unique key (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			for (const id of [USER, OTHER_USER]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "user" (id, name, email, "emailVerified",
						"onboardingComplete", "createdAt", "updatedAt")
					VALUES (${id}, ${id}, ${`${id}@example.com`}, true, true, ${now}, ${now})`);
			}
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG}, ${ORG}, ${ORG}, ${now})`);
			for (const id of [PROJECT, OTHER_PROJECT]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "project" (id, name, "userId", "createdAt", "updatedAt")
					VALUES (${id}, ${id}, ${USER}, ${now}, ${now})`);
			}
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "prompt" (id, key, name, scope, "createdBy",
					"createdAt", "updatedAt")
				VALUES (${PROMPT}, ${PROMPT}, ${PROMPT},
					'SYSTEM'::"PromptScope", ${USER}, ${now}, ${now})`);
			for (const [i, v] of [VERSION_A, VERSION_B].entries()) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "prompt_version" (id, "promptId", version, content,
						scope, "createdBy", "createdAt")
					VALUES (${v}, ${PROMPT}, ${i + 1}, ${`body ${i + 1}`},
						'SYSTEM'::"PromptScope", ${USER}, ${now})`);
			}
		});

		afterAll(async () => {
			await db.promptBinding.deleteMany({ where: { targetKey: AGENT } });
			await db.promptVersion.deleteMany({
				where: { id: { in: [VERSION_A, VERSION_B] } },
			});
			await db.prompt.deleteMany({ where: { id: PROMPT } });
			await db.project.deleteMany({
				where: { id: { in: [PROJECT, OTHER_PROJECT] } },
			});
			await db.organization.deleteMany({ where: { id: ORG } });
			await db.user.deleteMany({
				where: { id: { in: [USER, OTHER_USER] } },
			});
		});

		beforeEach(async () => {
			await db.promptBinding.deleteMany({ where: { targetKey: AGENT } });
		});

		it("refuses a second org-wide default for the same action", async () => {
			// The exact pair that both inserted before the migration: userId,
			// projectId and storyKind all NULL on each side.
			await insertBinding({
				id: `${AGENT}-1`,
				versionId: VERSION_A,
				organizationId: ORG,
			});

			await expect(
				insertBinding({
					id: `${AGENT}-2`,
					versionId: VERSION_B,
					organizationId: ORG,
				}),
			).rejects.toThrow();

			expect(
				await db.promptBinding.count({ where: { targetKey: AGENT } }),
			).toBe(1);
		});

		it("refuses a second binding for the same project", async () => {
			await insertBinding({
				id: `${AGENT}-p1`,
				versionId: VERSION_A,
				organizationId: ORG,
				projectId: PROJECT,
			});

			await expect(
				insertBinding({
					id: `${AGENT}-p2`,
					versionId: VERSION_B,
					organizationId: ORG,
					projectId: PROJECT,
				}),
			).rejects.toThrow();
		});

		it("refuses a second personal default for the same user", async () => {
			await insertBinding({
				id: `${AGENT}-u1`,
				versionId: VERSION_A,
				userId: USER,
			});

			await expect(
				insertBinding({
					id: `${AGENT}-u2`,
					versionId: VERSION_B,
					userId: USER,
				}),
			).rejects.toThrow();
		});

		it("still lets the tiers coexist, which is the whole point", async () => {
			// Org-wide, two different projects, and two different people. None
			// of these collide, and the constraint must not say otherwise.
			await insertBinding({
				id: `${AGENT}-c1`,
				versionId: VERSION_A,
				organizationId: ORG,
			});
			await insertBinding({
				id: `${AGENT}-c2`,
				versionId: VERSION_A,
				organizationId: ORG,
				projectId: PROJECT,
			});
			await insertBinding({
				id: `${AGENT}-c3`,
				versionId: VERSION_A,
				organizationId: ORG,
				projectId: OTHER_PROJECT,
			});
			await insertBinding({
				id: `${AGENT}-c4`,
				versionId: VERSION_A,
				userId: USER,
			});
			await insertBinding({
				id: `${AGENT}-c5`,
				versionId: VERSION_A,
				userId: OTHER_USER,
			});

			expect(
				await db.promptBinding.count({ where: { targetKey: AGENT } }),
			).toBe(5);
		});
	},
);
