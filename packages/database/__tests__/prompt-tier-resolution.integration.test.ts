/**
 * Tier precedence, proven against real rows rather than asserted about queries.
 *
 * Every existing test of this behaviour inspects the WHERE clause the resolver
 * builds. That catches a dropped filter, but it cannot answer the question the
 * requirements actually ask — given these bindings in a database, which prompt
 * does a user get? These do that:
 *
 *   FR3/FR4 — a personal default overrides the organization's for whoever set
 *   it, and the badge must name the same tier the resolver picked. Those two
 *   answers coming from different functions is precisely how the badge started
 *   claiming a tier that was not running, so they are compared here on ONE set
 *   of rows.
 *
 *   FR11/FR12 — clearing an override reveals the tier beneath it, and the
 *   prompt itself survives so it can be put back. "Survives" is a claim about
 *   rows that still exist, which no mock can make.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/prompt-tier-resolution.integration.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import {
	bindPromptVersion,
	clearPromptBinding,
	getBindingStatusForPrompts,
	getBoundPromptVersion,
} from "../prisma/queries/prompts";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN = `${Date.now()}-${process.pid}`;
const ORG = `tr-org-${RUN}`;
const USER = `tr-user-${RUN}`;
const OTHER_USER = `tr-other-${RUN}`;
const PROJECT_A = `tr-proj-a-${RUN}`;
const PROJECT_B = `tr-proj-b-${RUN}`;
const AGENT = `tr_agent_${RUN}`;
const DOC = "GENERAL";

/** One prompt per tier, so "which one came back" is unambiguous. */
const TIERS = [
	{
		scope: "SYSTEM" as const,
		prompt: `tr-p-sys-${RUN}`,
		version: `tr-v-sys-${RUN}`,
	},
	{
		scope: "PROJECT" as const,
		prompt: `tr-p-prj-${RUN}`,
		version: `tr-v-prj-${RUN}`,
	},
	{
		scope: "ORG" as const,
		prompt: `tr-p-org-${RUN}`,
		version: `tr-v-org-${RUN}`,
	},
	{
		scope: "USER" as const,
		prompt: `tr-p-usr-${RUN}`,
		version: `tr-v-usr-${RUN}`,
	},
];

const versionOf = (scope: "SYSTEM" | "ORG" | "PROJECT" | "USER") =>
	TIERS.find((t) => t.scope === scope)?.version;

const bind = (
	scope: "SYSTEM" | "ORG" | "PROJECT" | "USER",
	projectId?: string,
) =>
	bindPromptVersion({
		targetType: "AGENT",
		targetKey: AGENT,
		documentType: DOC,
		storyKind: null,
		scope: scope === "PROJECT" ? "ORG" : scope,
		userId: scope === "USER" ? USER : undefined,
		organizationId:
			scope === "ORG" || scope === "PROJECT" ? ORG : undefined,
		projectId: scope === "PROJECT" ? projectId : undefined,
		promptVersionId: versionOf(scope) as string,
		isDefault: true,
		callerUserId: USER,
	});

const resolveInOrg = (projectId?: string) =>
	getBoundPromptVersion({
		targetType: "AGENT",
		targetKey: AGENT,
		documentType: DOC,
		storyKind: null,
		userId: USER,
		organizationId: ORG,
		projectId,
	});

describe.skipIf(!hasReachableDatabaseUrl())(
	"prompt tier resolution (real Postgres)",
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
			for (const id of [PROJECT_A, PROJECT_B]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "project" (id, name, "userId", "createdAt", "updatedAt")
					VALUES (${id}, ${id}, ${USER}, ${now}, ${now})`);
			}

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
			await db.project.deleteMany({
				where: { id: { in: [PROJECT_A, PROJECT_B] } },
			});
			await db.organization.deleteMany({ where: { id: ORG } });
			await db.user.deleteMany({
				where: { id: { in: [USER, OTHER_USER] } },
			});
		});

		beforeEach(async () => {
			await db.promptBinding.deleteMany({ where: { targetKey: AGENT } });
		});

		describe("FR3 — personal beats organization, inside an organization", () => {
			it("returns the personal prompt when all three tiers are bound", async () => {
				await bind("SYSTEM");
				await bind("ORG");
				await bind("USER");

				const got = await resolveInOrg();

				expect(got?.id).toBe(versionOf("USER"));
			});

			it("returns the organization's when the user has no override", async () => {
				await bind("SYSTEM");
				await bind("ORG");

				expect((await resolveInOrg())?.id).toBe(versionOf("ORG"));
			});

			it("returns the system prompt when neither exists", async () => {
				await bind("SYSTEM");

				expect((await resolveInOrg())?.id).toBe(versionOf("SYSTEM"));
			});

			it("does not give one user another's override", async () => {
				// The isolation that stays absolute. USER's binding must not
				// resolve for OTHER_USER, who falls through to the org's.
				await bind("ORG");
				await bind("USER");

				const forOther = await getBoundPromptVersion({
					targetType: "AGENT",
					targetKey: AGENT,
					documentType: DOC,
					storyKind: null,
					userId: OTHER_USER,
					organizationId: ORG,
				});

				expect(forOther?.id).toBe(versionOf("ORG"));
			});
		});

		describe("PROJECT tier — an org default narrowed to one project", () => {
			it("wins over org-wide inside its own project", async () => {
				await bind("SYSTEM");
				await bind("ORG");
				await bind("PROJECT", PROJECT_A);

				expect((await resolveInOrg(PROJECT_A))?.id).toBe(
					versionOf("PROJECT"),
				);
			});

			it("stays inside its project — another project gets org-wide", async () => {
				await bind("SYSTEM");
				await bind("ORG");
				await bind("PROJECT", PROJECT_A);

				expect((await resolveInOrg(PROJECT_B))?.id).toBe(
					versionOf("ORG"),
				);
			});

			it("does not shadow org-wide when resolved without a project", async () => {
				await bind("ORG");
				await bind("PROJECT", PROJECT_A);

				expect((await resolveInOrg())?.id).toBe(versionOf("ORG"));
			});

			it("falls through to org-wide when the project binding is cleared", async () => {
				await bind("SYSTEM");
				await bind("ORG");
				await bind("PROJECT", PROJECT_A);
				await clearPromptBinding({
					targetType: "AGENT",
					targetKey: AGENT,
					documentType: DOC,
					storyKind: null,
					scope: "ORG",
					organizationId: ORG,
					projectId: PROJECT_A,
				});

				expect((await resolveInOrg(PROJECT_A))?.id).toBe(
					versionOf("ORG"),
				);
			});

			it("loses to a personal override, like every tier beneath it", async () => {
				await bind("ORG");
				await bind("PROJECT", PROJECT_A);
				await bind("USER");

				expect((await resolveInOrg(PROJECT_A))?.id).toBe(
					versionOf("USER"),
				);
			});

			it("is named by the badge, which agrees with the resolver", async () => {
				await bind("SYSTEM");
				await bind("ORG");
				await bind("PROJECT", PROJECT_A);

				const ran = await resolveInOrg(PROJECT_A);
				const status = await getBindingStatusForPrompts({
					promptIds: TIERS.map((t) => t.prompt),
					documentType: DOC,
					userId: USER,
					organizationId: ORG,
					projectId: PROJECT_A,
				});

				const badgedDefault = [...status.entries()].find(
					([, v]) => v.isDefault,
				);
				expect(badgedDefault?.[1].defaultScope).toBe("PROJECT");
				expect(badgedDefault?.[0]).toBe(
					TIERS.find((t) => t.version === ran?.id)?.prompt,
				);
			});
		});

		describe("FR4 — the badge names the tier that actually ran", () => {
			it("agrees with the resolver on the same rows", async () => {
				// The two answers come from different functions over different
				// queries. Reading them from one set of rows is the only way to
				// catch them drifting — which they did once already.
				await bind("SYSTEM");
				await bind("ORG");
				await bind("USER");

				const ran = await resolveInOrg();
				const status = await getBindingStatusForPrompts({
					promptIds: TIERS.map((t) => t.prompt),
					documentType: DOC,
					userId: USER,
					organizationId: ORG,
				});

				const badgedDefault = [...status.entries()].find(
					([, v]) => v.isDefault,
				);
				const ranTier = TIERS.find((t) => t.version === ran?.id)?.scope;

				expect(badgedDefault?.[1].defaultScope).toBe(ranTier);
				expect(badgedDefault?.[0]).toBe(
					TIERS.find((t) => t.scope === ranTier)?.prompt,
				);
			});

			it("stops the shadowed tiers claiming to be the default", async () => {
				await bind("SYSTEM");
				await bind("USER");

				const status = await getBindingStatusForPrompts({
					promptIds: TIERS.map((t) => t.prompt),
					documentType: DOC,
					userId: USER,
					organizationId: ORG,
				});

				const defaults = [...status.values()].filter(
					(v) => v.isDefault,
				);
				expect(defaults).toHaveLength(1);
			});
		});

		describe("FR11 / FR12 — clearing reveals the tier beneath, and keeps the prompt", () => {
			it("falls back to the organization when the personal override is cleared", async () => {
				await bind("SYSTEM");
				await bind("ORG");
				await bind("USER");
				expect((await resolveInOrg())?.id).toBe(versionOf("USER"));

				const cleared = await clearPromptBinding({
					targetType: "AGENT",
					targetKey: AGENT,
					documentType: DOC,
					storyKind: null,
					scope: "USER",
					userId: USER,
				});

				expect(cleared).toEqual({ cleared: true });
				expect((await resolveInOrg())?.id).toBe(versionOf("ORG"));
			});

			it("falls back to the system prompt when the organization's is cleared", async () => {
				await bind("SYSTEM");
				await bind("ORG");

				await clearPromptBinding({
					targetType: "AGENT",
					targetKey: AGENT,
					documentType: DOC,
					storyKind: null,
					scope: "ORG",
					organizationId: ORG,
				});

				expect((await resolveInOrg())?.id).toBe(versionOf("SYSTEM"));
			});

			it("leaves the prompt and its version intact so it can be put back", async () => {
				// FR12's whole point: clearing is not deleting.
				await bind("ORG");
				await clearPromptBinding({
					targetType: "AGENT",
					targetKey: AGENT,
					documentType: DOC,
					storyKind: null,
					scope: "ORG",
					organizationId: ORG,
				});

				const version = await db.promptVersion.findUnique({
					where: { id: versionOf("ORG") as string },
				});
				const prompt = await db.prompt.findUnique({
					where: {
						id: TIERS.find((t) => t.scope === "ORG")
							?.prompt as string,
					},
				});
				expect(version).not.toBeNull();
				expect(prompt).not.toBeNull();

				// And re-binding it works without recreating anything.
				await bind("ORG");
				expect((await resolveInOrg())?.id).toBe(versionOf("ORG"));
			});

			it("clears only the tier asked for", async () => {
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

				// Clearing now drops the default flag rather than deleting the
				// row (FR12, soft-clear), so BOTH rows remain — the assertion
				// that matters is which tier was actually affected.
				const left = await db.promptBinding.findMany({
					where: { targetKey: AGENT },
				});
				expect(left).toHaveLength(2);
				const orgRow = left.find((r) => r.scope === "ORG");
				const userRow = left.find((r) => r.scope === "USER");
				expect(orgRow?.isDefault).toBe(true);
				expect(userRow?.isDefault).toBe(false);
			});
		});
	},
);
