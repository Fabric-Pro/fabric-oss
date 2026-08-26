/**
 * Clearing a tier's override is reversible from where it happened.
 *
 * FR12 of Fizzy #2068 asks that a cleared override "remain accessible so users
 * can reactivate it later without recreating it". The prompt and its versions
 * always survived — clearing only ever touched the binding row. What this suite
 * pins is the stronger reading: the binding row itself survives with its
 * default flag dropped, which is exactly the state `bindPromptVersion` writes
 * for a bind saved with "set as default" unchecked. Every reader already
 * understands that state — the resolver filters `isDefault: true` per tier,
 * the catalog lists the variant as an offer, and the badge reports bound but
 * not in force — so clearing becomes a one-click undo in the catalog rather
 * than a trip back to the library.
 *
 * RED-FIRST NOTE: these tests were written against the soft-clear behaviour
 * before it existed; at verification time, run them against HEAD~ of the fix
 * (git stash-free: checkout the prior prompts.ts into place) to watch the
 * row-persistence and catalog-visibility cases fail on deleteMany, then restore
 * the fix and watch them pass.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/prompt-clear-soft.integration.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import {
	bindPromptVersion,
	clearPromptBinding,
	getBindingStatusForPrompts,
	getBoundPromptVersion,
	listPromptCatalog,
} from "../prisma/queries/prompts";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN = `${Date.now()}-${process.pid}`;
const ORG = `cs-org-${RUN}`;
const USER = `cs-user-${RUN}`;
const AGENT = `cs_agent_${RUN}`;
const DOC = "GENERAL";

const TIERS = [
	{
		scope: "SYSTEM" as const,
		prompt: `cs-p-sys-${RUN}`,
		version: `cs-v-sys-${RUN}`,
	},
	{
		scope: "ORG" as const,
		prompt: `cs-p-org-${RUN}`,
		version: `cs-v-org-${RUN}`,
	},
	{
		scope: "USER" as const,
		prompt: `cs-p-usr-${RUN}`,
		version: `cs-v-usr-${RUN}`,
	},
];

const versionOf = (scope: "SYSTEM" | "ORG" | "USER") =>
	TIERS.find((t) => t.scope === scope)?.version;

const bind = (scope: "SYSTEM" | "ORG" | "USER") =>
	bindPromptVersion({
		targetType: "AGENT",
		targetKey: AGENT,
		documentType: DOC,
		storyKind: null,
		scope,
		userId: scope === "USER" ? USER : undefined,
		organizationId: scope === "ORG" ? ORG : undefined,
		promptVersionId: versionOf(scope) as string,
		isDefault: true,
		callerUserId: USER,
	});

const resolveInOrg = () =>
	getBoundPromptVersion({
		targetType: "AGENT",
		targetKey: AGENT,
		documentType: DOC,
		storyKind: null,
		userId: USER,
		organizationId: ORG,
	});

describe.skipIf(!hasReachableDatabaseUrl())(
	"clearing keeps the binding row available (real Postgres)",
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

			for (const tier of TIERS) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "prompt" (id, key, name, scope, "createdBy",
						"createdAt", "updatedAt")
					VALUES (${tier.prompt}, ${tier.prompt}, ${tier.scope},
						'SYSTEM'::"PromptScope", ${USER}, ${now}, ${now})`);
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "prompt_version" (id, "promptId", version, content,
						scope, "createdBy", "createdAt")
					VALUES (${tier.version}, ${tier.prompt}, 1, ${`${tier.scope} body`},
						'SYSTEM'::"PromptScope", ${USER}, ${now})`);
			}
		});

		afterAll(async () => {
			await db.promptBinding.deleteMany({ where: { targetKey: AGENT } });
			await db.promptVersion.deleteMany({
				where: { id: { in: TIERS.map((t) => t.version) } },
			});
			await db.prompt.deleteMany({
				where: { id: { in: TIERS.map((t) => t.prompt) } },
			});
			await db.organization.deleteMany({ where: { id: ORG } });
			await db.user.deleteMany({ where: { id: USER } });
		});

		beforeEach(async () => {
			await db.promptBinding.deleteMany({ where: { targetKey: AGENT } });
		});

		it("keeps the personal binding row with its default flag dropped", async () => {
			await bind("SYSTEM");
			await bind("ORG");
			await bind("USER");

			const cleared = await clearPromptBinding({
				targetType: "AGENT",
				targetKey: AGENT,
				documentType: DOC,
				storyKind: null,
				scope: "USER",
				userId: USER,
			});
			expect(cleared).toEqual({ cleared: true });

			const rows = await db.promptBinding.findMany({
				where: {
					targetKey: AGENT,
					scope: "USER",
					userId: USER,
				},
			});
			expect(rows).toHaveLength(1);
			expect(rows[0].isDefault).toBe(false);
			expect(rows[0].promptVersionId).toBe(versionOf("USER"));
		});

		it("falls through to the organization tier once cleared", async () => {
			await bind("SYSTEM");
			await bind("ORG");
			await bind("USER");
			await clearPromptBinding({
				targetType: "AGENT",
				targetKey: AGENT,
				documentType: DOC,
				storyKind: null,
				scope: "USER",
				userId: USER,
			});

			expect((await resolveInOrg())?.id).toBe(versionOf("ORG"));
		});

		it("still lists the cleared prompt in the catalog as an offer", async () => {
			await bind("SYSTEM");
			await bind("USER");
			await clearPromptBinding({
				targetType: "AGENT",
				targetKey: AGENT,
				documentType: DOC,
				storyKind: null,
				scope: "USER",
				userId: USER,
			});

			const entries = await listPromptCatalog({
				userId: USER,
				organizationId: ORG,
			});
			const userPromptId = TIERS.find((t) => t.scope === "USER")?.prompt;
			const action = entries.find((e) => e.targetKey === AGENT);
			const clearedBinding = action?.prompts.find(
				(b) => b.promptId === userPromptId,
			);
			expect(clearedBinding).toBeDefined();
			expect(clearedBinding?.isDefault).toBe(false);
			expect(clearedBinding?.isEffective).toBe(false);
		});

		it("reports bound but not in force to the badge query", async () => {
			await bind("SYSTEM");
			await bind("USER");
			await clearPromptBinding({
				targetType: "AGENT",
				targetKey: AGENT,
				documentType: DOC,
				storyKind: null,
				scope: "USER",
				userId: USER,
			});

			const status = await getBindingStatusForPrompts({
				promptIds: TIERS.map((t) => t.prompt),
				documentType: DOC,
				userId: USER,
				organizationId: ORG,
			});
			const userStatus = status.get(
				TIERS.find((t) => t.scope === "USER")?.prompt as string,
			);
			expect(userStatus?.isBound).toBe(true);
			expect(userStatus?.isDefault).toBe(false);
			expect(userStatus?.defaultScope).toBeNull();
		});

		it("restores by re-binding the same row, not a new one", async () => {
			await bind("SYSTEM");
			await bind("USER");
			await clearPromptBinding({
				targetType: "AGENT",
				targetKey: AGENT,
				documentType: DOC,
				storyKind: null,
				scope: "USER",
				userId: USER,
			});

			const before = await db.promptBinding.findFirst({
				where: { targetKey: AGENT, scope: "USER", userId: USER },
			});

			await bind("USER");

			const rows = await db.promptBinding.findMany({
				where: { targetKey: AGENT, scope: "USER", userId: USER },
			});
			expect(rows).toHaveLength(1);
			expect(rows[0].id).toBe(before?.id);
			expect(rows[0].isDefault).toBe(true);
			expect((await resolveInOrg())?.id).toBe(versionOf("USER"));
		});

		it("reports nothing left to clear on a second clear", async () => {
			await bind("USER");
			const args = {
				targetType: "AGENT" as const,
				targetKey: AGENT,
				documentType: DOC,
				storyKind: null,
				scope: "USER" as const,
				userId: USER,
			};

			expect(await clearPromptBinding(args)).toEqual({ cleared: true });
			expect(await clearPromptBinding(args)).toEqual({ cleared: false });
		});

		it("stands the caller's override down softly when a system default is set", async () => {
			await bind("USER");

			// Setting the SYSTEM default carries callerUserId, which used to
			// DELETE the caller's USER row outright.
			await bind("SYSTEM");

			const rows = await db.promptBinding.findMany({
				where: { targetKey: AGENT, scope: "USER", userId: USER },
			});
			expect(rows).toHaveLength(1);
			expect(rows[0].isDefault).toBe(false);
			expect((await resolveInOrg())?.id).toBe(versionOf("SYSTEM"));
		});
	},
);
