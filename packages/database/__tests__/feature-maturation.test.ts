/**
 * DB-backed coverage for the Feature Maturation V2 query helpers (TG1, Task 1.6;
 * spec 2026-06-09 §5). Real Postgres only — gated by `hasReachableDatabaseUrl()`
 * exactly like `organization-document-assistant-flag.test.ts`, so CI's
 * unconnectable placeholder URL skips cleanly.
 *
 * Covers:
 *   - Threaded Decision Log insert + assemble (roots reverse-chron, replies
 *     grouped by parent).
 *   - Soft-delete exclusion from the thread fetch.
 *   - XOR tenant isolation (org rows invisible to the personal-context filter,
 *     and vice-versa).
 *   - Approval-preference upsert (create then update keyed on the unique index).
 *   - Effective-mode resolution fall-through matrix (feature override → user
 *     default → hard default).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import {
	appendDecisionLogReply,
	createDecisionLogEntry,
	effectiveApprovalMode,
	getApprovalPreference,
	getOpenDecisionsForStories,
	HARD_DEFAULT_APPROVAL_MODE,
	listDecisionLogThreads,
	softDeleteDecisionLogEntry,
	upsertApprovalPreference,
} from "../prisma/queries/feature-maturation";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-mat-v2-org-${RUN_ID}`;
const OTHER_ORG_ID = `test-mat-v2-org2-${RUN_ID}`;
const USER_ID = `test-mat-v2-user-${RUN_ID}`;
const OTHER_USER_ID = `test-mat-v2-user2-${RUN_ID}`;

const orgTenant = { organizationId: ORG_ID, userId: USER_ID } as const;
const personalTenant = { organizationId: null, userId: USER_ID } as const;

describe.skipIf(!hasReachableDatabaseUrl())(
	"feature-maturation query helpers",
	() => {
		let storyId: string;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Mat V2 User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${OTHER_USER_ID}, ${"Mat V2 Other User"}, ${`${OTHER_USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Mat V2 Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${OTHER_ORG_ID}, ${"Mat V2 Org 2"}, ${OTHER_ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);

			const project = await db.project.create({
				data: {
					name: "Mat V2 Project",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
			const status = await db.projectStoryStatus.create({
				data: {
					projectId: project.id,
					name: "Backlog",
					color: "#94a3b8",
					order: 0,
					isDefault: true,
				},
			});
			const story = await db.userStory.create({
				data: {
					projectId: project.id,
					statusId: status.id,
					identifier: "US-001",
					title: "Mat V2 Story",
					createdById: USER_ID,
				},
			});
			storyId = story.id;
		});

		afterAll(async () => {
			await db.decisionLogEntry.deleteMany({
				where: { userId: { in: [USER_ID, OTHER_USER_ID] } },
			});
			await db.maturationApprovalPreference.deleteMany({
				where: { userId: { in: [USER_ID, OTHER_USER_ID] } },
			});
			await db.userStory.deleteMany({ where: { createdById: USER_ID } });
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: USER_ID } },
			});
			await db.project.deleteMany({ where: { userId: USER_ID } });
			await db.organization.deleteMany({
				where: { id: { in: [ORG_ID, OTHER_ORG_ID] } },
			});
			await db.user.deleteMany({
				where: { id: { in: [USER_ID, OTHER_USER_ID] } },
			});
		});

		describe("DecisionLogEntry threading", () => {
			it("assembles roots reverse-chronologically with replies grouped by parent", async () => {
				const rootA = await createDecisionLogEntry({
					tenantFilter: orgTenant,
					userStoryId: storyId,
					authorType: "USER",
					status: "RESOLVED",
					summary: "First decision",
					source: "HUMAN",
					authorUserId: USER_ID,
				});
				const rootB = await createDecisionLogEntry({
					tenantFilter: orgTenant,
					userStoryId: storyId,
					authorType: "AGENT",
					summary: "Second decision",
					source: "AI_CONFIRMED",
				});
				await appendDecisionLogReply({
					tenantFilter: orgTenant,
					userStoryId: storyId,
					parentId: rootA.id,
					authorType: "USER",
					content: "A reply on the first thread",
					authorUserId: USER_ID,
				});

				const threads = await listDecisionLogThreads({
					tenantFilter: orgTenant,
					userStoryId: storyId,
				});

				expect(threads.map((t) => t.root.id)).toEqual([
					rootB.id,
					rootA.id,
				]);
				expect(threads[0].replies).toHaveLength(0);
				expect(threads[1].replies).toHaveLength(1);
				expect(threads[1].replies[0].content).toBe(
					"A reply on the first thread",
				);
			});

			it("excludes soft-deleted entries from the thread fetch", async () => {
				const root = await createDecisionLogEntry({
					tenantFilter: orgTenant,
					userStoryId: storyId,
					authorType: "USER",
					summary: "Doomed decision",
					authorUserId: USER_ID,
				});

				const affected = await softDeleteDecisionLogEntry({
					tenantFilter: orgTenant,
					id: root.id,
				});
				expect(affected).toBe(1);

				const threads = await listDecisionLogThreads({
					tenantFilter: orgTenant,
					userStoryId: storyId,
				});
				expect(threads.map((t) => t.root.id)).not.toContain(root.id);
			});

			it("isolates tenants via the exclusive XOR filter", async () => {
				const orgEntry = await createDecisionLogEntry({
					tenantFilter: orgTenant,
					userStoryId: storyId,
					authorType: "USER",
					summary: "Org-context decision",
					authorUserId: USER_ID,
				});
				const personalEntry = await createDecisionLogEntry({
					tenantFilter: personalTenant,
					userStoryId: storyId,
					authorType: "USER",
					summary: "Personal-context decision",
					authorUserId: USER_ID,
				});

				const orgThreads = await listDecisionLogThreads({
					tenantFilter: orgTenant,
					userStoryId: storyId,
				});
				const orgRootIds = orgThreads.map((t) => t.root.id);
				expect(orgRootIds).toContain(orgEntry.id);
				expect(orgRootIds).not.toContain(personalEntry.id);

				const personalThreads = await listDecisionLogThreads({
					tenantFilter: personalTenant,
					userStoryId: storyId,
				});
				const personalRootIds = personalThreads.map((t) => t.root.id);
				expect(personalRootIds).toContain(personalEntry.id);
				expect(personalRootIds).not.toContain(orgEntry.id);
			});

			it("does not soft-delete an entry from a different tenant", async () => {
				const personalEntry = await createDecisionLogEntry({
					tenantFilter: personalTenant,
					userStoryId: storyId,
					authorType: "USER",
					summary: "Personal entry safe from org delete",
					authorUserId: USER_ID,
				});

				// Attempt to delete the personal-context row using the org tenant.
				const affected = await softDeleteDecisionLogEntry({
					tenantFilter: orgTenant,
					id: personalEntry.id,
				});
				expect(affected).toBe(0);

				const stillThere = await db.decisionLogEntry.findUnique({
					where: { id: personalEntry.id },
				});
				expect(stillThere?.deletedAt).toBeNull();
			});
		});

		describe("MaturationApprovalPreference upsert", () => {
			it("creates then updates a per-user default keyed on (userId, organizationId)", async () => {
				const created = await upsertApprovalPreference({
					tenantFilter: orgTenant,
					summaryQuestionsMode: "AUTO_ACCEPT",
				});
				expect(created.summaryQuestionsMode).toBe("AUTO_ACCEPT");
				// Untouched fields keep their DB defaults.
				expect(created.cleanSpecMode).toBe("AUTO_ACCEPT");
				expect(created.autoAcceptAll).toBe(false);

				const updated = await upsertApprovalPreference({
					tenantFilter: orgTenant,
					autoAcceptAll: true,
				});
				expect(updated.id).toBe(created.id);
				expect(updated.autoAcceptAll).toBe(true);
				// Prior write preserved (only provided fields change).
				expect(updated.summaryQuestionsMode).toBe("AUTO_ACCEPT");

				const read = await getApprovalPreference({
					tenantFilter: orgTenant,
				});
				expect(read?.id).toBe(created.id);
			});

			it("keeps org and personal preferences as separate rows", async () => {
				await upsertApprovalPreference({
					tenantFilter: personalTenant,
					cleanSpecMode: "MANUAL",
				});

				const personal = await getApprovalPreference({
					tenantFilter: personalTenant,
				});
				const org = await getApprovalPreference({
					tenantFilter: orgTenant,
				});

				expect(personal?.cleanSpecMode).toBe("MANUAL");
				expect(org?.cleanSpecMode).toBe("AUTO_ACCEPT");
				expect(personal?.id).not.toBe(org?.id);
			});
		});

		describe("effectiveApprovalMode resolution", () => {
			it("falls through to the hard default when no override or preference exists", () => {
				expect(effectiveApprovalMode(null, null, "cleanSpec")).toBe(
					HARD_DEFAULT_APPROVAL_MODE.cleanSpec,
				);
				expect(
					effectiveApprovalMode(null, null, "summaryQuestions"),
				).toBe("MANUAL");
				expect(effectiveApprovalMode(null, null, "decisionLog")).toBe(
					"AUTO_ACCEPT",
				);
			});

			it("prefers the per-user default over the hard default", () => {
				const userPref = {
					cleanSpecMode: "MANUAL" as const,
					decisionLogMode: "AUTO_ACCEPT" as const,
					summaryQuestionsMode: "AUTO_ACCEPT" as const,
				};
				expect(effectiveApprovalMode(null, userPref, "cleanSpec")).toBe(
					"MANUAL",
				);
				expect(
					effectiveApprovalMode(null, userPref, "summaryQuestions"),
				).toBe("AUTO_ACCEPT");
			});

			it("prefers the per-feature override over everything", () => {
				const feature = {
					cleanSpecApprovalMode: "MANUAL" as const,
					decisionLogApprovalMode: null,
					summaryQuestionsApprovalMode: null,
				};
				const userPref = {
					cleanSpecMode: "AUTO_ACCEPT" as const,
					decisionLogMode: "MANUAL" as const,
					summaryQuestionsMode: "AUTO_ACCEPT" as const,
				};
				// Feature override wins for cleanSpec.
				expect(
					effectiveApprovalMode(feature, userPref, "cleanSpec"),
				).toBe("MANUAL");
				// No feature override → falls to user default for decisionLog.
				expect(
					effectiveApprovalMode(feature, userPref, "decisionLog"),
				).toBe("MANUAL");
				// No feature override → falls to the user default.
				expect(
					effectiveApprovalMode(
						feature,
						userPref,
						"summaryQuestions",
					),
				).toBe("AUTO_ACCEPT");
			});
		});
		describe("getOpenDecisionsForStories", () => {
			// Its own story: the shared `storyId` above accumulates roots from
			// the threading and XOR tests (including a deliberate personal-tenant
			// entry), so counting against it would assert on other tests' state.
			let ownStoryId: string;
			let ownProjectId: string;
			// A second project in the SAME org, to prove the query authorizes
			// the individual story ids and not merely the org.
			let otherProjectStoryId: string;

			beforeAll(async () => {
				const parent = await db.userStory.findUniqueOrThrow({
					where: { id: storyId },
					select: { projectId: true, statusId: true },
				});
				ownProjectId = parent.projectId;
				const own = await db.userStory.create({
					data: {
						projectId: parent.projectId,
						statusId: parent.statusId,
						identifier: "US-002",
						title: "Open decisions story",
						createdById: USER_ID,
					},
				});
				ownStoryId = own.id;

				const host = await db.project.findUniqueOrThrow({
					where: { id: ownProjectId },
					select: { organizationId: true, userId: true },
				});
				const sibling = await db.project.create({
					data: {
						name: "Sibling project (same org)",
						organizationId: host.organizationId,
						userId: host.userId,
					},
				});
				const siblingStory = await db.userStory.create({
					data: {
						projectId: sibling.id,
						statusId: parent.statusId,
						identifier: "US-003",
						title: "Sibling project story",
						createdById: USER_ID,
					},
				});
				otherProjectStoryId = siblingStory.id;
				await createDecisionLogEntry({
					tenantFilter: orgTenant,
					userStoryId: otherProjectStoryId,
					authorType: "AGENT",
					status: "OPEN",
					summary: "Sibling project secret question",
				});
			});

			it("returns an exact count but a capped list of questions", async () => {
				// The count feeds the roadmap's Priority ranking while the
				// questions are only displayed, so capping the count too would
				// silently change the order rather than just the display.
				for (let i = 0; i < 5; i++) {
					await createDecisionLogEntry({
						tenantFilter: orgTenant,
						userStoryId: ownStoryId,
						authorType: "AGENT",
						status: "OPEN",
						summary: `Open question ${i}`,
					});
				}

				const result = await getOpenDecisionsForStories({
					tenantFilter: orgTenant,
					projectId: ownProjectId,
					userStoryIds: [ownStoryId],
					maxPerStory: 2,
				});

				expect(result.counts[ownStoryId]).toBe(5);
				expect(result.questions[ownStoryId]).toHaveLength(2);
			});

			it("counts only unresolved thread roots", async () => {
				const root = await createDecisionLogEntry({
					tenantFilter: orgTenant,
					userStoryId: ownStoryId,
					authorType: "AGENT",
					status: "RESOLVED",
					summary: "Already answered",
				});
				// A reply carries its own status, so counting every row would
				// re-count a thread that is already closed.
				await appendDecisionLogReply({
					tenantFilter: orgTenant,
					userStoryId: ownStoryId,
					parentId: root.id,
					authorType: "USER",
					content: "Because X.",
				});

				const result = await getOpenDecisionsForStories({
					tenantFilter: orgTenant,
					projectId: ownProjectId,
					userStoryIds: [ownStoryId],
					maxPerStory: 10,
				});

				const summaries = (result.questions[ownStoryId] ?? []).map(
					(q) => q.summary,
				);
				expect(summaries).not.toContain("Already answered");
			});

			it("excludes soft-deleted questions", async () => {
				const doomed = await createDecisionLogEntry({
					tenantFilter: orgTenant,
					userStoryId: ownStoryId,
					authorType: "AGENT",
					status: "OPEN",
					summary: "Soft deleted question",
				});
				await softDeleteDecisionLogEntry({
					tenantFilter: orgTenant,
					id: doomed.id,
				});

				const result = await getOpenDecisionsForStories({
					tenantFilter: orgTenant,
					projectId: ownProjectId,
					userStoryIds: [ownStoryId],
					maxPerStory: 10,
				});

				const summaries = (result.questions[ownStoryId] ?? []).map(
					(q) => q.summary,
				);
				expect(summaries).not.toContain("Soft deleted question");
			});

			it("does not leak org questions into the personal-context filter", async () => {
				const result = await getOpenDecisionsForStories({
					tenantFilter: personalTenant,
					projectId: ownProjectId,
					userStoryIds: [ownStoryId],
					maxPerStory: 10,
				});

				expect(result.counts[ownStoryId]).toBeUndefined();
				expect(result.questions[ownStoryId]).toBeUndefined();
			});

			it("does not return questions for a story in another project of the same org", async () => {
				// The caller is authorized against ONE project, but the tenant
				// filter only narrows to the org — and org membership is not
				// project access (`hasProjectAccess` also requires ownership or
				// an accepted ProjectMember row). So a caller who can reach any
				// project in the org must not be able to read another
				// project's questions by passing its story ids.
				const result = await getOpenDecisionsForStories({
					tenantFilter: orgTenant,
					projectId: ownProjectId,
					userStoryIds: [ownStoryId, otherProjectStoryId],
					maxPerStory: 10,
				});

				expect(result.counts[otherProjectStoryId]).toBeUndefined();
				expect(result.questions[otherProjectStoryId]).toBeUndefined();
				// The authorized project's own row still comes back, so this is
				// scoping and not a blanket empty result.
				expect(result.counts[ownStoryId]).toBeGreaterThan(0);
			});

			it("short-circuits on an empty id list", async () => {
				const result = await getOpenDecisionsForStories({
					tenantFilter: orgTenant,
					projectId: ownProjectId,
					userStoryIds: [],
					maxPerStory: 10,
				});

				expect(result).toEqual({ counts: {}, questions: {} });
			});
		});
	},
);
