/**
 * The prompt list's unused filter (Fizzy #2068 F13) against real rows.
 *
 * "Unused" = bound to no action at all. The where-clause has to compose with
 * the scope conditions, the document-type binding filter, and search without
 * one dropping the other — the exact kind of AND/OR composition that reads
 * fine and filters wrong.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import { listPrompts } from "../prisma/queries/prompts";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN = `${Date.now()}-${process.pid}`;
const ORG = `lf-org-${RUN}`;
const USER = `lf-user-${RUN}`;
const USED = `lf-used-${RUN}`;
const UNUSED = `lf-unused-${RUN}`;
const AGENT = `lf_agent_${RUN}`;

let usedPromptId: string;
let unusedPromptId: string;
let versionId: string;

describe.skipIf(!hasReachableDatabaseUrl())(
	"prompt list unused filter (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified",
					"onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER}, ${USER}, ${`${USER}@example.com`}, true, true, ${now}, ${now})`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG}, ${ORG}, ${ORG}, ${now})`);

			for (const [id, key] of [
				[USED, `lf-p-used-${RUN}`],
				[UNUSED, `lf-p-unused-${RUN}`],
			] as const) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "prompt" (id, key, name, scope, "createdBy",
						"createdAt", "updatedAt")
					VALUES (${id}, ${key}, ${key}, 'SYSTEM'::"PromptScope", ${USER}, ${now}, ${now})`);
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "prompt_version" (id, "promptId", version, content,
						scope, "createdBy", "createdAt")
					VALUES (${`${id}-v1`}, ${id}, 1, 'body', 'SYSTEM'::"PromptScope", ${USER}, ${now})`);
			}
			usedPromptId = USED;
			unusedPromptId = UNUSED;
			versionId = `${USED}-v1`;

			await db.promptBinding.create({
				data: {
					targetType: "AGENT",
					targetKey: AGENT,
					documentType: "GENERAL",
					storyKind: null,
					scope: "SYSTEM",
					promptVersionId: versionId,
					isDefault: true,
				},
			});
		});

		afterAll(async () => {
			await db.promptBinding.deleteMany({ where: { targetKey: AGENT } });
			await db.promptVersion.deleteMany({
				where: { promptId: { in: [usedPromptId, unusedPromptId] } },
			});
			await db.prompt.deleteMany({
				where: { id: { in: [usedPromptId, unusedPromptId] } },
			});
			await db.organization.deleteMany({ where: { id: ORG } });
			await db.user.deleteMany({ where: { id: USER } });
		});

		beforeEach(async () => {
			// The binding is the fixture; tests must not delete it.
		});

		it("unused: true returns only the prompt bound to no action", async () => {
			const result = await listPrompts({
				userId: USER,
				organizationId: ORG,
				unused: true,
			});
			const ids = result.prompts.map((p) => p.id);
			expect(ids).toContain(unusedPromptId);
			expect(ids).not.toContain(usedPromptId);
		});

		it("unused: false (default) returns both prompts", async () => {
			const result = await listPrompts({
				userId: USER,
				organizationId: ORG,
			});
			const ids = result.prompts.map((p) => p.id);
			expect(ids).toContain(usedPromptId);
			expect(ids).toContain(unusedPromptId);
		});

		it("composes with the document-type binding filter", async () => {
			// Bound for GENERAL, so with unused set the none-clause must win:
			// the used prompt is excluded even though its binding matches the
			// document type.
			const result = await listPrompts({
				userId: USER,
				organizationId: ORG,
				boundToDocumentType: "GENERAL",
				unused: true,
			});
			const ids = result.prompts.map((p) => p.id);
			expect(ids).toContain(unusedPromptId);
			expect(ids).not.toContain(usedPromptId);
		});
	},
);
