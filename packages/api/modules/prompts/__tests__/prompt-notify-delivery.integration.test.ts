/**
 * Notification DELIVERY for the prompt feature, against a real database.
 *
 * Everything upstream of the bell was tested with mocks: the fan-out helpers
 * were vi.fn(), so "the reviewer is told" was asserted as "the tell-function
 * was called". What these tests add is the write path itself — recipient
 * resolution and the notification rows a real bell reads — because that is
 * where the staging rehearsal stopped: a self-nomination produced zero rows,
 * and without this suite nothing distinguished "pipeline broken" from "the
 * nominator is deliberately excluded".
 *
 * Pinned here, against real rows:
 *   FR16 — a nomination notifies the tier's admin and NOT the nominator
 *           (announce-nomination.ts excludes the actor; a self-nomination
 *           correctly writes nothing, which is what staging showed);
 *   FR6  — a default change notifies the org's members, excluding the actor,
 *           with the informational framing when the member holds their own
 *           override;
 *   FR8  — the row's link lands on that action's catalog entry;
 *   dedupe — a second announce for the same nomination coalesces, so a
 *           double-fire cannot fill the bell.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/prompts/__tests__/prompt-notify-delivery.integration.test.ts
 */

import { db, listPromptNominationReviewers, Prisma } from "@repo/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { announceDefaultChange } from "../lib/announce-default-change";
import { announceNomination } from "../lib/announce-nomination";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN = `${Date.now()}-${process.pid}`;
const ORG = `pn-org-${RUN}`;
const NOMINATOR = `pn-nom-${RUN}`; // org member, no admin role
const ADMIN = `pn-adm-${RUN}`; // org admin — the FR16 reviewer
const AGENT = `pn_agent_${RUN}`;
const DOC = "GENERAL";

let promptId: string;
let versionId: string;
let nominationId: string;

const hasRow = async (userId: string, payloadNeedle?: string) => {
	const rows = await db.notification.findMany({ where: { userId } });
	const promptRows = rows.filter((r) => r.type.startsWith("PROMPT_"));
	if (!payloadNeedle) {
		return promptRows;
	}
	return promptRows.filter((r) =>
		JSON.stringify(r.payload ?? {}).includes(payloadNeedle),
	);
};

describe.skipIf(!hasReachableDatabaseUrl())(
	"prompt notification delivery (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			for (const id of [NOMINATOR, ADMIN]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "user" (id, name, email, "emailVerified",
						"onboardingComplete", "createdAt", "updatedAt")
					VALUES (${id}, ${id}, ${`${id}@example.com`}, true, true, ${now}, ${now})`);
			}
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG}, ${ORG}, ${ORG}, ${now})`);
			await db.member.create({
				data: {
					organizationId: ORG,
					userId: NOMINATOR,
					role: "member",
					createdAt: now,
				},
			});
			await db.member.create({
				data: {
					organizationId: ORG,
					userId: ADMIN,
					role: "admin",
					createdAt: now,
				},
			});

			const prompt = await db.prompt.create({
				data: {
					key: `pn-p-${RUN}`,
					name: "Story Breakdown (delivery test)",
					scope: "SYSTEM",
					createdBy: ADMIN,
				},
			});
			promptId = prompt.id;
			const version = await db.promptVersion.create({
				data: {
					promptId: prompt.id,
					version: 1,
					content: "delivery-test body",
					changeNote: "delivery-test change note",
					createdBy: ADMIN,
					scope: "SYSTEM",
				},
			});
			versionId = version.id;
			await db.promptBinding.create({
				data: {
					targetType: "AGENT",
					targetKey: AGENT,
					documentType: DOC,
					storyKind: null,
					scope: "SYSTEM",
					promptVersionId: versionId,
					isDefault: true,
				},
			});
		});

		afterAll(async () => {
			await db.notification.deleteMany({
				where: { userId: { in: [NOMINATOR, ADMIN] } },
			});
			await db.promptBinding.deleteMany({ where: { targetKey: AGENT } });
			await db.promptVersion.deleteMany({ where: { promptId } });
			await db.prompt.deleteMany({ where: { id: promptId } });
			await db.member.deleteMany({
				where: {
					organizationId: ORG,
					userId: { in: [NOMINATOR, ADMIN] },
				},
			});
			await db.organization.deleteMany({ where: { id: ORG } });
			await db.user.deleteMany({
				where: { id: { in: [NOMINATOR, ADMIN] } },
			});
		});

		beforeEach(async () => {
			await db.notification.deleteMany({
				where: { userId: { in: [NOMINATOR, ADMIN] } },
			});
		});

		it("FR16 — resolves the admin as reviewer and excludes the nominator", async () => {
			// The exact case staging surfaced: a self-nomination must produce
			// zero recipients, because the nominator already knows.
			const selfReviewers = await listPromptNominationReviewers({
				targetScope: "ORG",
				organizationId: ORG,
				excludeUserId: ADMIN,
			});
			expect(selfReviewers.map((r) => r.userId)).not.toContain(ADMIN);

			const reviewers = await listPromptNominationReviewers({
				targetScope: "ORG",
				organizationId: ORG,
				excludeUserId: NOMINATOR,
			});
			expect(reviewers.map((r) => r.userId)).toEqual([ADMIN]);
		});

		it("FR16 — announceNomination writes a row for the admin and none for the nominator", async () => {
			const nomination = await db.promptNomination.create({
				data: {
					promptVersionId: versionId,
					nominatedById: NOMINATOR,
					targetScope: "ORG",
					organizationId: ORG,
					targets: [target],
					status: "PENDING",
				},
			});
			nominationId = nomination.id;

			await announceNomination({
				nomination: { id: nomination.id },
				targetScope: "ORG",
				organizationId: ORG,
				targets: [target],
				promptId,
				promptName: "Story Breakdown (delivery test)",
				summary: "tightened the acceptance criteria section",
				degraded: false,
				actor: { id: NOMINATOR, name: "Nominator" },
			});

			const adminRows = await hasRow(ADMIN, nomination.id);
			expect(adminRows).toHaveLength(1);
			expect(adminRows[0].title).toBe(
				"Nominator proposed an organization default prompt",
			);
			// An ORG nomination's queue link must land in the org's context.
			expect(adminRows[0].link).toMatch(
				/^\/app\/pn-org-[^/]+\/prompts\/nominations/,
			);
			// The AI summary rides in the snippet; the payload carries ids.
			expect(adminRows[0].snippet).toContain(
				"tightened the acceptance criteria",
			);
			expect(JSON.stringify(adminRows[0].payload)).toContain(
				nomination.id,
			);

			expect(await hasRow(NOMINATOR, nomination.id)).toHaveLength(0);
		});

		it("dedupe — a second announce for the same nomination coalesces", async () => {
			await announceNomination({
				nomination: { id: nominationId },
				targetScope: "ORG",
				organizationId: ORG,
				targets: [target],
				promptId,
				promptName: "Story Breakdown (delivery test)",
				summary: "refired",
				degraded: false,
				actor: { id: NOMINATOR },
			});

			const adminRows = await hasRow(ADMIN, nominationId);
			expect(adminRows).toHaveLength(1);
		});

		it("FR6 + FR8 — a default change notifies members with the catalog deep-link, excluding the actor", async () => {
			await announceDefaultChange({
				scope: "ORG",
				organizationId: ORG,
				targetKey: AGENT,
				documentType: DOC,
				storyKind: null,
				promptVersionId: versionId,
				actorUserId: ADMIN,
			});

			// The member is subject to the new default; the acting admin is
			// excluded (self-skip), so the member holds the only row.
			const memberRows = await hasRow(NOMINATOR, AGENT);
			expect(memberRows).toHaveLength(1);
			expect(memberRows[0].link).toContain("/prompts/catalog?action=");
			expect(memberRows[0].link).toContain(AGENT);
			expect(memberRows[0].title).toContain(
				"Organization prompt updated",
			);

			expect(await hasRow(ADMIN, AGENT)).toHaveLength(0);
		});

		it("FR6 — a member with their own override gets the informational framing", async () => {
			// Give the member a personal default for the same action: the change
			// no longer alters what they run, and the message must say so.
			const memberVersion = await db.promptVersion.create({
				data: {
					promptId,
					version: 2,
					content: "member's own body",
					createdBy: NOMINATOR,
					scope: "SYSTEM",
				},
			});
			await db.promptBinding.create({
				data: {
					targetType: "AGENT",
					targetKey: AGENT,
					documentType: DOC,
					storyKind: null,
					scope: "USER",
					userId: NOMINATOR,
					promptVersionId: memberVersion.id,
					isDefault: true,
				},
			});

			await announceDefaultChange({
				scope: "ORG",
				organizationId: ORG,
				targetKey: AGENT,
				documentType: DOC,
				storyKind: null,
				promptVersionId: versionId,
				actorUserId: ADMIN,
			});

			const rows = await hasRow(NOMINATOR, "informationalOnly");
			expect(rows).toHaveLength(1);
			expect(rows[0].title).toContain("An improvement is available");

			await db.promptBinding.deleteMany({
				where: { scope: "USER", userId: NOMINATOR, targetKey: AGENT },
			});
			await db.promptVersion.delete({ where: { id: memberVersion.id } });
		});
	},
);

const target = {
	targetKey: AGENT,
	documentType: DOC,
};
