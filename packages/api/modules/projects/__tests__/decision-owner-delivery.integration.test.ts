/**
 * Notification DELIVERY for decision ownership, against a real database.
 *
 * Everything upstream of the bell was covered with mocks: `createNotification`
 * was a vi.fn(), so "the owner is told" was asserted as "the tell-function was
 * called". The staging rehearsal could not close the gap either — the actor is
 * deliberately skipped, so a self-assignment writes nothing, and one account
 * cannot read another's inbox. That left the write path itself never observed.
 *
 * Pinned here, against real rows:
 *   AC3 — assigning a DIFFERENT member owner writes one row addressed to that
 *          member, typed DECISION_OWNER_ASSIGNED;
 *   AC3 — the actor is excluded: a self-assignment writes nothing, which is
 *          what the staging run saw and could not otherwise explain;
 *   dedupe — a burst of edits coalesces on `decision-owner:<id>:<owner>` rather
 *          than filling the bell, because the key is version-independent;
 *   edit  — editing someone else's owned decision writes DECISION_OWNER_UPDATED.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder — so a green
 * run here is only evidence if it actually ran (the suite name appears in the
 * reporter output).
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/projects/__tests__/decision-owner-delivery.integration.test.ts
 */

import { db, Prisma } from "@repo/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { filterByCurrentAccess } from "../../notifications/lib/access-filter";
import {
	INCIDENT_NOTIFICATION_TYPES,
	WEEKLY_DIGEST_DEDUPE_PREFIX,
} from "../../notifications/lib/incident-notification-types";
import { hasReachableDatabaseUrl } from "../../prompts/__tests__/_helpers/db-availability";
import { notifyDecisionOwner } from "../lib/decision-owner";

const RUN = `${Date.now()}-${process.pid}`;
const ORG = `do-org-${RUN}`;
const ACTOR = `do-actor-${RUN}`; // project creator, does the assigning
const OWNER = `do-owner-${RUN}`; // accepted project member, receives the row
const PROJECT = `do-proj-${RUN}`;

const decision = (ownerUserId: string | null) => ({
	id: `do-dec-${RUN}`,
	projectId: PROJECT,
	identifier: "ADR-042",
	title: "Adopt the queue-backed ingestion path",
	ownerUserId,
});

const actor = { id: ACTOR, name: "Test Actor", email: `${ACTOR}@example.com` };

const rowsFor = (userId: string) =>
	db.notification.findMany({
		where: {
			userId,
			type: { in: ["DECISION_OWNER_ASSIGNED", "DECISION_OWNER_UPDATED"] },
		},
	});

/**
 * What the recipient's bell actually returns, not what the table contains.
 *
 * A written row and a visible notification are different claims: the bell
 * matches `organizationId` exactly, hides incident types, hides archived and
 * (on the unread tab) read rows, and then re-checks project access at read
 * time. A notification can satisfy every assertion about its own columns and
 * still reach nobody. This mirrors the where-clause and the access filter in
 * `modules/notifications/procedures/list.ts` so a change there that strands
 * decision-owner rows fails here instead of in someone's empty bell.
 */
const bellFor = async (userId: string, organizationId: string | null) => {
	const rows = await db.notification.findMany({
		where: {
			userId,
			organizationId,
			archivedAt: null,
			OR: [
				{ type: { notIn: INCIDENT_NOTIFICATION_TYPES } },
				{ dedupeKey: { startsWith: WEEKLY_DIGEST_DEDUPE_PREFIX } },
			],
		},
		orderBy: { createdAt: "desc" },
	});
	return filterByCurrentAccess(rows, userId);
};

describe.skipIf(!hasReachableDatabaseUrl())(
	"decision owner notification delivery (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			for (const id of [ACTOR, OWNER]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "user" (id, name, email, "emailVerified",
						"onboardingComplete", "createdAt", "updatedAt")
					VALUES (${id}, ${id}, ${`${id}@example.com`}, true, true, ${now}, ${now})`);
			}
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG}, ${ORG}, ${ORG}, ${now})`);
			for (const id of [ACTOR, OWNER]) {
				await db.member.create({
					data: {
						organizationId: ORG,
						userId: id,
						role: "member",
						createdAt: now,
					},
				});
			}
			await db.project.create({
				data: {
					id: PROJECT,
					name: `Decision owner delivery ${RUN}`,
					userId: ACTOR,
					organizationId: ORG,
				},
			});
			await db.projectMember.create({
				data: {
					projectId: PROJECT,
					userId: OWNER,
					role: "EDITOR",
					acceptedAt: now,
					invitedBy: ACTOR,
				},
			});
		});

		afterAll(async () => {
			await db.notification.deleteMany({
				where: { userId: { in: [ACTOR, OWNER] } },
			});
			await db.projectMember.deleteMany({
				where: { projectId: PROJECT },
			});
			await db.project.deleteMany({ where: { id: PROJECT } });
			await db.member.deleteMany({
				where: { organizationId: ORG, userId: { in: [ACTOR, OWNER] } },
			});
			await db.organization.deleteMany({ where: { id: ORG } });
			await db.user.deleteMany({ where: { id: { in: [ACTOR, OWNER] } } });
		});

		beforeEach(async () => {
			await db.notification.deleteMany({
				where: { userId: { in: [ACTOR, OWNER] } },
			});
		});

		it("writes one row to the assigned owner, typed and keyed", async () => {
			await notifyDecisionOwner(decision(OWNER), actor, ORG, true);

			const rows = await rowsFor(OWNER);
			expect(rows).toHaveLength(1);
			expect(rows[0].type).toBe("DECISION_OWNER_ASSIGNED");
			expect(rows[0].dedupeKey).toBe(
				`decision-owner:do-dec-${RUN}:${OWNER}`,
			);
			expect(rows[0].title).toContain("ADR-042");
			// The link must carry the org slug so the bell lands in the right
			// tenant's project rather than the personal route.
			expect(rows[0].link).toBe(
				`/app/${ORG}/projects/${PROJECT}?tab=decisions`,
			);
		});

		it("writes nothing when the actor assigns themselves", async () => {
			await notifyDecisionOwner(decision(ACTOR), actor, ORG, true);

			expect(await rowsFor(ACTOR)).toHaveLength(0);
		});

		it("coalesces a burst of edits onto one unread row", async () => {
			await notifyDecisionOwner(decision(OWNER), actor, ORG, true);
			await notifyDecisionOwner(decision(OWNER), actor, ORG, false);
			await notifyDecisionOwner(decision(OWNER), actor, ORG, false);

			expect(await rowsFor(OWNER)).toHaveLength(1);
		});

		it("types a later edit of an owned decision as an update", async () => {
			await notifyDecisionOwner(decision(OWNER), actor, ORG, false);

			const rows = await rowsFor(OWNER);
			expect(rows).toHaveLength(1);
			expect(rows[0].type).toBe("DECISION_OWNER_UPDATED");
		});

		// The rest of this suite proves a row was written. These prove the
		// owner can actually SEE it — the two are not the same claim, and a
		// notification nobody's bell returns is indistinguishable from one
		// that was never sent.
		it("reaches the owner's bell, not just the table", async () => {
			await notifyDecisionOwner(decision(OWNER), actor, ORG, true);

			const bell = await bellFor(OWNER, ORG);
			const mine = bell.filter((n) =>
				n.type.startsWith("DECISION_OWNER_"),
			);
			expect(mine).toHaveLength(1);
			expect(mine[0].title).toContain("ADR-042");
		});

		// createNotification maps source.projectId onto the projectId COLUMN,
		// which is what the read-time access filter reads. If that mapping is
		// ever dropped the row survives every column assertion and silently
		// stops being access-checked.
		it("carries the project id the read-time access check needs", async () => {
			await notifyDecisionOwner(decision(OWNER), actor, ORG, true);

			const rows = await rowsFor(OWNER);
			expect(rows[0].projectId).toBe(PROJECT);
		});

		// The bell matches organizationId exactly. A row written against the
		// wrong tenant is invisible in the one the owner is actually browsing,
		// which is the failure this assertion exists to catch.
		it("is invisible from a different organization's bell", async () => {
			await notifyDecisionOwner(decision(OWNER), actor, ORG, true);

			expect(await bellFor(OWNER, null)).toHaveLength(0);
		});
	},
);
