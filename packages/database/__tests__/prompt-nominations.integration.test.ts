/**
 * Real-Postgres integration tests for the prompt-nomination lifecycle.
 *
 * These are the assertions a mocked suite cannot make, because in every one of
 * them the contract IS the SQL:
 *
 *   - The approval **claim** is an atomic `updateMany` on `id + status`. Whether
 *     it is really a lock depends on Postgres, not on a `vi.fn()` returning
 *     `{ count: 1 }`. Two concurrent approvals must produce exactly one winner.
 *   - `targets` is a `jsonb` column. What comes back out of it — and whether the
 *     overlap comparison still works on it — is a driver-and-database question.
 *   - `listPromptNominationReviewers` resolves through two different tables and
 *     two different role fields. A mock proves the query was shaped a certain
 *     way; only a database proves that shape selects the right people.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/prompt-nominations.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import { listPromptNominationReviewers } from "../prisma/queries/prompt-nomination-reviewers";
import {
	approvePromptNomination,
	createPromptNomination,
	listPendingNominations,
	withdrawPromptNomination,
} from "../prisma/queries/prompt-nominations";
import { bindPromptVersionToTargets } from "../prisma/queries/prompts";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN = `${Date.now()}-${process.pid}`;
const ORG = `pn-org-${RUN}`;
const OTHER_ORG = `pn-org-other-${RUN}`;
const OWNER = `pn-owner-${RUN}`;
const ADMIN = `pn-admin-${RUN}`;
const MEMBER = `pn-member-${RUN}`;
const PLATFORM_ADMIN = `pn-plat-${RUN}`;
const PROMPT = `pn-prompt-${RUN}`;
const VERSION_A = `pn-ver-a-${RUN}`;
const VERSION_B = `pn-ver-b-${RUN}`;

const DRAFTER = {
	targetKey: `pn_drafter_${RUN}`,
	documentType: "GENERAL",
	storyKind: null,
};
const REVISER = {
	targetKey: `pn_reviser_${RUN}`,
	documentType: "GENERAL",
	storyKind: null,
};

describe.skipIf(!hasReachableDatabaseUrl())(
	"prompt nomination lifecycle (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			for (const [id, role] of [
				[OWNER, null],
				[ADMIN, null],
				[MEMBER, null],
				[PLATFORM_ADMIN, "admin"],
			] as const) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "user" (id, name, email, "emailVerified", role,
						"onboardingComplete", "createdAt", "updatedAt")
					VALUES (${id}, ${id}, ${`${id}@example.com`}, true, ${role},
						true, ${now}, ${now})`);
			}

			for (const org of [ORG, OTHER_ORG]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "organization" (id, name, slug, "createdAt")
					VALUES (${org}, ${org}, ${org}, ${now})`);
			}

			for (const [user, role, org] of [
				[OWNER, "owner", ORG],
				[ADMIN, "admin", ORG],
				[MEMBER, "member", ORG],
				// An admin of a DIFFERENT organization must never be selected.
				[PLATFORM_ADMIN, "admin", OTHER_ORG],
			] as const) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
					VALUES (${`${user}-${org}`}, ${org}, ${user}, ${role}, ${now})`);
			}

			await db.$executeRaw(Prisma.sql`
				INSERT INTO "prompt" (id, key, name, scope, "organizationId",
					"createdBy", "createdAt", "updatedAt")
				VALUES (${PROMPT}, ${PROMPT}, ${"Integration prompt"}, 'ORG'::"PromptScope",
					${ORG}, ${MEMBER}, ${now}, ${now})`);

			for (const [vid, n] of [
				[VERSION_A, 1],
				[VERSION_B, 2],
			] as const) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "prompt_version" (id, "promptId", version, content,
						scope, "organizationId", "createdBy", "createdAt")
					VALUES (${vid}, ${PROMPT}, ${n}, ${`body ${n}`},
						'ORG'::"PromptScope", ${ORG}, ${MEMBER}, ${now})`);
			}
		});

		afterAll(async () => {
			// Delete by the exact ids this run created, never by pattern.
			await db.promptBinding.deleteMany({
				where: {
					targetKey: { in: [DRAFTER.targetKey, REVISER.targetKey] },
				},
			});
			await db.promptNomination.deleteMany({
				where: { promptVersionId: { in: [VERSION_A, VERSION_B] } },
			});
			await db.promptVersion.deleteMany({
				where: { id: { in: [VERSION_A, VERSION_B] } },
			});
			await db.prompt.deleteMany({ where: { id: PROMPT } });
			await db.member.deleteMany({
				where: { organizationId: { in: [ORG, OTHER_ORG] } },
			});
			await db.organization.deleteMany({
				where: { id: { in: [ORG, OTHER_ORG] } },
			});
			await db.user.deleteMany({
				where: { id: { in: [OWNER, ADMIN, MEMBER, PLATFORM_ADMIN] } },
			});
		});

		const nominate = (versionId: string, targets = [DRAFTER]) =>
			createPromptNomination({
				promptVersionId: versionId,
				nominatedById: MEMBER,
				targetScope: "ORG",
				organizationId: ORG,
				targets,
				changeSummary: "adds preconditions",
				summaryDegraded: false,
			});

		it("round-trips the targets json column", async () => {
			// parseTargets reads whatever the driver hands back for `jsonb`.
			const created = await nominate(VERSION_A, [DRAFTER, REVISER]);

			const pending = await listPendingNominations({
				targetScope: "ORG",
				organizationId: ORG,
			});
			const found = pending.find((p) => p.id === created.id);

			expect(found).toBeDefined();
			expect(found?.targets).toHaveLength(2);
			expect(
				(found?.targets as Array<{ targetKey: string }>).map(
					(t) => t.targetKey,
				),
			).toEqual([DRAFTER.targetKey, REVISER.targetKey]);

			await db.promptNomination.deleteMany({ where: { id: created.id } });
		});

		it("scopes the queue to one organization", async () => {
			const mine = await nominate(VERSION_A);

			const otherOrg = await listPendingNominations({
				targetScope: "ORG",
				organizationId: OTHER_ORG,
			});

			expect(otherOrg.map((n) => n.id)).not.toContain(mine.id);

			await db.promptNomination.deleteMany({ where: { id: mine.id } });
		});

		it("lets exactly one of two concurrent approvals win", async () => {
			// The whole point of claiming the row before binding. With a
			// read-then-write both callers would pass the check and both bind.
			const nomination = await nominate(VERSION_A);

			const results = await Promise.allSettled([
				approvePromptNomination({
					nominationId: nomination.id,
					reviewedById: ADMIN,
					targets: [DRAFTER],
					promptVersionId: VERSION_A,
					targetScope: "ORG",
					organizationId: ORG,
				}),
				approvePromptNomination({
					nominationId: nomination.id,
					reviewedById: OWNER,
					targets: [DRAFTER],
					promptVersionId: VERSION_A,
					targetScope: "ORG",
					organizationId: ORG,
				}),
			]);

			const won = results.filter((r) => r.status === "fulfilled").length;
			const lost = results.filter((r) => r.status === "rejected").length;
			expect(won).toBe(1);
			expect(lost).toBe(1);

			const row = await db.promptNomination.findUnique({
				where: { id: nomination.id },
			});
			expect(row?.status).toBe("APPROVED");

			// And exactly one binding exists for the action, not two.
			const bindings = await db.promptBinding.findMany({
				where: { targetKey: DRAFTER.targetKey, scope: "ORG" },
			});
			expect(bindings).toHaveLength(1);
		});

		it("supersedes only the competing nomination for the same action", async () => {
			await db.promptNomination.deleteMany({
				where: { promptVersionId: { in: [VERSION_A, VERSION_B] } },
			});

			const competing = await nominate(VERSION_B, [DRAFTER]);
			const unrelated = await nominate(VERSION_B, [REVISER]);
			const winner = await nominate(VERSION_A, [DRAFTER]);

			const result = await approvePromptNomination({
				nominationId: winner.id,
				reviewedById: ADMIN,
				targets: [DRAFTER],
				promptVersionId: VERSION_A,
				targetScope: "ORG",
				organizationId: ORG,
			});

			expect(result.supersededCount).toBe(1);

			const after = await db.promptNomination.findMany({
				where: { id: { in: [competing.id, unrelated.id] } },
				select: { id: true, status: true },
			});
			const byId = new Map(after.map((r) => [r.id, r.status]));
			expect(byId.get(competing.id)).toBe("SUPERSEDED");
			// Nobody reviewed this one; closing it would discard it silently.
			expect(byId.get(unrelated.id)).toBe("PENDING");
		});

		it("refuses a withdraw from anyone but the nominator", async () => {
			await db.promptNomination.deleteMany({
				where: { promptVersionId: { in: [VERSION_A, VERSION_B] } },
			});
			const mine = await nominate(VERSION_A);

			await expect(
				withdrawPromptNomination({
					nominationId: mine.id,
					nominatedById: ADMIN,
				}),
			).resolves.toEqual({ withdrawn: false });

			await expect(
				withdrawPromptNomination({
					nominationId: mine.id,
					nominatedById: MEMBER,
				}),
			).resolves.toEqual({ withdrawn: true });
		});

		describe("binding several actions at once", () => {
			it("binds all of them or none (FR19)", async () => {
				// The all-or-nothing claim is a transaction claim, so only a
				// database can settle it. A partial application is the state
				// nobody asked for: some actions moved, some did not, and the
				// UI reported success.
				//
				// The FIRST target must be valid and the SECOND must fail —
				// otherwise nothing is ever written and the test proves only
				// that a doomed call throws, which is not rollback. The second
				// carries a storyKind outside the enum, so its INSERT is what
				// breaks, after the first has already been written.
				const base = {
					targetType: "AGENT" as const,
					targetKey: DRAFTER.targetKey,
					documentType: "ROLLBACK_PROBE",
					storyKind: null,
				};

				await expect(
					bindPromptVersionToTargets({
						targets: [
							base,
							{
								...base,
								targetKey: REVISER.targetKey,
								// Deliberately not a StoryKind: forces the
								// failure onto the second write specifically.
								storyKind: "NOT_A_STORY_KIND" as never,
							},
						],
						scope: "ORG",
						organizationId: ORG,
						promptVersionId: VERSION_A,
						isDefault: true,
						callerUserId: ADMIN,
					}),
				).rejects.toThrow();

				// The first target was valid and would have been written. If the
				// transaction did not cover it, it is still there.
				const written = await db.promptBinding.findMany({
					where: { documentType: "ROLLBACK_PROBE" },
				});
				expect(written).toHaveLength(0);
			});

			it("binds every target when they all succeed", async () => {
				// Guards the guard: if the batch silently wrote nothing, the
				// rollback assertion above would pass for the wrong reason.
				const base = {
					targetType: "AGENT" as const,
					documentType: "BATCH_PROBE",
					storyKind: null,
				};

				const result = await bindPromptVersionToTargets({
					targets: [
						{ ...base, targetKey: DRAFTER.targetKey },
						{ ...base, targetKey: REVISER.targetKey },
					],
					scope: "ORG",
					organizationId: ORG,
					promptVersionId: VERSION_A,
					isDefault: true,
					callerUserId: ADMIN,
				});

				expect(result.bound).toBe(2);
				const written = await db.promptBinding.findMany({
					where: { documentType: "BATCH_PROBE" },
				});
				expect(written).toHaveLength(2);

				await db.promptBinding.deleteMany({
					where: { documentType: "BATCH_PROBE" },
				});
			});
		});

		describe("reviewers resolve against real rows", () => {
			it("selects this organization's admins and owners, and nobody else's", async () => {
				const reviewers = await listPromptNominationReviewers({
					targetScope: "ORG",
					organizationId: ORG,
				});
				const ids = reviewers.map((r) => r.userId);

				expect(ids).toContain(OWNER);
				expect(ids).toContain(ADMIN);
				// A plain member cannot decide, so must not be told.
				expect(ids).not.toContain(MEMBER);
				// An admin of a different organization is not this org's reviewer.
				expect(ids).not.toContain(PLATFORM_ADMIN);
			});

			it("selects platform admins for the system tier, by User.role", async () => {
				const reviewers = await listPromptNominationReviewers({
					targetScope: "SYSTEM",
				});
				const ids = reviewers.map((r) => r.userId);

				// PLATFORM_ADMIN has User.role = 'admin'; the org owner does not,
				// which is the distinction the two tiers turn on.
				expect(ids).toContain(PLATFORM_ADMIN);
				expect(ids).not.toContain(OWNER);
				expect(ids).not.toContain(MEMBER);
			});

			it("excludes the nominator", async () => {
				const reviewers = await listPromptNominationReviewers({
					targetScope: "ORG",
					organizationId: ORG,
					excludeUserId: ADMIN,
				});

				expect(reviewers.map((r) => r.userId)).not.toContain(ADMIN);
			});
		});
	},
);
