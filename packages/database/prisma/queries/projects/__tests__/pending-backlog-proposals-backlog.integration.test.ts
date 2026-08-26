/**
 * Real-Postgres integration tests for the Backlog deferral transitions on the
 * pending-backlog-proposal query layer.
 *
 * These exercise the actual `updateMany` status-guard WHERE clauses (which a
 * mocked unit test cannot), and would have caught the staging regression where
 * rejecting a BACKLOG proposal 404/409'd because `markPendingProposalRejected`
 * only admitted PENDING/FAILED.
 *
 * Covered:
 *   - markPendingProposalBacklog: PENDING → BACKLOG (PENDING-only guard).
 *   - markPendingProposalRejected: BACKLOG → REJECTED (FR5 transition out).
 *   - markPendingProposalApproved: BACKLOG → APPROVED (FR5 transition out).
 *   - Backlog guard rejects a non-PENDING row (updated=false).
 *
 * Self-skips when DATABASE_URL is unset / CI placeholder, mirroring
 * `pending-backlog-proposals-failures.test.ts`.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../../client";
import {
	markPendingProposalApproved,
	markPendingProposalBacklog,
	markPendingProposalRejected,
} from "../pending-backlog-proposals";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG = `test-backlog-org-${RUN_ID}`;
const USER = `test-backlog-user-${RUN_ID}`;

async function seedPendingProposal(projectId: string) {
	return await db.pendingBacklogProposal.create({
		data: {
			projectId,
			userId: USER,
			organizationId: ORG,
			source: "AI_UPDATE_SIDEBAR",
			status: "PENDING",
			proposal: { changes: [] } as Prisma.InputJsonValue,
			summary: "1 proposed change(s) from AI Update",
			changeCount: 1,
		},
	});
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"pending backlog proposal — Backlog transitions (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER}, ${`Backlog Test ${USER}`}, ${`${USER}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG}, ${`Backlog Test ${ORG}`}, ${ORG}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterEach(async () => {
			await db.pendingBacklogProposal.deleteMany({
				where: { userId: USER },
			});
			await db.project.deleteMany({ where: { userId: USER } });
		});

		async function seedProject() {
			return await db.project.create({
				data: {
					name: "Backlog Test Project",
					userId: USER,
					organizationId: ORG,
				},
			});
		}

		it("defers a PENDING proposal to BACKLOG", async () => {
			const project = await seedProject();
			const p = await seedPendingProposal(project.id);

			const res = await markPendingProposalBacklog({
				proposalId: p.id,
				reviewedBy: USER,
			});

			expect(res.updated).toBe(true);
			const reread = await db.pendingBacklogProposal.findUniqueOrThrow({
				where: { id: p.id },
			});
			expect(reread.status).toBe("BACKLOG");
			expect(reread.reviewedBy).toBe(USER);
		});

		it("rejects a BACKLOG proposal (FR5: transition out to REJECTED)", async () => {
			const project = await seedProject();
			const p = await seedPendingProposal(project.id);
			await markPendingProposalBacklog({
				proposalId: p.id,
				reviewedBy: USER,
			});

			const res = await markPendingProposalRejected({
				proposalId: p.id,
				reviewedBy: USER,
			});

			expect(res.updated).toBe(true);
			const reread = await db.pendingBacklogProposal.findUniqueOrThrow({
				where: { id: p.id },
			});
			expect(reread.status).toBe("REJECTED");
		});

		it("approves a BACKLOG proposal (FR5: transition out to APPROVED)", async () => {
			const project = await seedProject();
			const p = await seedPendingProposal(project.id);
			await markPendingProposalBacklog({
				proposalId: p.id,
				reviewedBy: USER,
			});

			await markPendingProposalApproved({
				proposalId: p.id,
				reviewedBy: USER,
			});

			const reread = await db.pendingBacklogProposal.findUniqueOrThrow({
				where: { id: p.id },
			});
			expect(reread.status).toBe("APPROVED");
		});

		it("does not defer a non-PENDING proposal (compare-and-set guard)", async () => {
			const project = await seedProject();
			const p = await seedPendingProposal(project.id);
			// Move to BACKLOG, then a second backlog attempt must be a no-op.
			await markPendingProposalBacklog({
				proposalId: p.id,
				reviewedBy: USER,
			});

			const res = await markPendingProposalBacklog({
				proposalId: p.id,
				reviewedBy: USER,
			});

			expect(res.updated).toBe(false);
		});
	},
);
