/**
 * Real-Postgres integration tests for the failure-metadata extensions to the
 * pending-backlog-proposal query layer.
 *
 * Covered surfaces:
 *
 *   1. `markPendingProposalFailed` — new structured signature
 *      (`{ errorClass, errorMessage, rawApplyError? }`):
 *      - Persists all three columns with the documented truncation lengths
 *        (`errorClass` ≤ 200, `errorMessage` ≤ 500, `applyError` ≤ 4000).
 *      - When `rawApplyError` is omitted, `applyError` falls back to
 *        `errorMessage` so legacy single-string call-sites stay readable.
 *      - Stamps `failedAt` to a fresh `Date` and flips status to FAILED.
 *
 *   2. `listFailedProposals` — filters rows by `status="FAILED"` plus an
 *      optional `source` filter (single value, array, or undefined). Results
 *      come back ordered by `failedAt desc`.
 *
 *   3. Tenant XOR isolation — seeding rows under one org/user pair does not
 *      leak into another tenancy's view of the same project row set. The
 *      query layer itself is not tenant-aware (callers filter), so this
 *      sanity check confirms the projectId scope keeps tenancies separate
 *      when the caller honours the standard XOR pattern.
 *
 * No mocks — hits the live Aspire Postgres via the same Prisma singleton
 * the rest of the suite uses. Self-skips when DATABASE_URL is unset or
 * points at the CI placeholder (`hasReachableDatabaseUrl`), mirroring the
 * pattern from `backlog-dedup-guard.integration.test.ts`.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../../client";
import {
	listFailedProposals,
	markPendingProposalFailed,
} from "../pending-backlog-proposals";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_A = `test-failed-proposals-orgA-${RUN_ID}`;
const ORG_B = `test-failed-proposals-orgB-${RUN_ID}`;
const USER_A = `test-failed-proposals-userA-${RUN_ID}`;
const USER_B = `test-failed-proposals-userB-${RUN_ID}`;

async function seedProject(args: {
	orgId: string;
	userId: string;
	name: string;
}) {
	return await db.project.create({
		data: {
			name: args.name,
			userId: args.userId,
			organizationId: args.orgId,
		},
	});
}

async function seedPendingProposal(args: {
	projectId: string;
	userId: string;
	organizationId: string;
	source?:
		| "TEAMS_CHANNEL"
		| "TEAMS_CHAT"
		| "SLACK_CHANNEL"
		| "AI_UPDATE_SIDEBAR";
}) {
	return await db.pendingBacklogProposal.create({
		data: {
			projectId: args.projectId,
			userId: args.userId,
			organizationId: args.organizationId,
			source: args.source ?? "AI_UPDATE_SIDEBAR",
			status: "PENDING",
			proposal: { changes: [] } as Prisma.InputJsonValue,
			summary: "1 proposed change(s) from AI Update",
			changeCount: 1,
		},
	});
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"markPendingProposalFailed + listFailedProposals (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			for (const userId of [USER_A, USER_B]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
					VALUES (${userId}, ${`Failed Proposals Test ${userId}`}, ${`${userId}@test.com`}, true, false, ${now}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
			for (const orgId of [ORG_A, ORG_B]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "organization" (id, name, slug, "createdAt")
					VALUES (${orgId}, ${`Failed Proposals Test ${orgId}`}, ${orgId}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
		});

		afterEach(async () => {
			// PendingBacklogProposal → Project (FK order).
			await db.pendingBacklogProposal.deleteMany({
				where: { userId: { in: [USER_A, USER_B] } },
			});
			await db.project.deleteMany({
				where: { userId: { in: [USER_A, USER_B] } },
			});
		});

		it("persists errorClass + errorMessage + applyError (raw) + failedAt", async () => {
			const project = await seedProject({
				orgId: ORG_A,
				userId: USER_A,
				name: "Failure Metadata Project",
			});
			const proposal = await seedPendingProposal({
				projectId: project.id,
				userId: USER_A,
				organizationId: ORG_A,
			});
			const beforeMark = Date.now();
			await markPendingProposalFailed(proposal.id, {
				errorClass: "PmAuthError",
				errorMessage: "PM tool credentials are invalid.",
				rawApplyError:
					"PmAuthError: 401 from upstream; stack-trace follows… (very long body)",
			});
			const reread = await db.pendingBacklogProposal.findUniqueOrThrow({
				where: { id: proposal.id },
			});
			expect(reread.status).toBe("FAILED");
			expect(reread.errorClass).toBe("PmAuthError");
			expect(reread.errorMessage).toBe(
				"PM tool credentials are invalid.",
			);
			expect(reread.applyError).toBe(
				"PmAuthError: 401 from upstream; stack-trace follows… (very long body)",
			);
			expect(reread.failedAt).not.toBeNull();
			expect(reread.failedAt?.getTime()).toBeGreaterThanOrEqual(
				beforeMark,
			);
		});

		it("truncates errorClass to 200, errorMessage to 500, applyError to 4000 chars", async () => {
			const project = await seedProject({
				orgId: ORG_A,
				userId: USER_A,
				name: "Truncation Project",
			});
			const proposal = await seedPendingProposal({
				projectId: project.id,
				userId: USER_A,
				organizationId: ORG_A,
			});
			const longClass = "X".repeat(500);
			const longMessage = "M".repeat(1500);
			const longApply = "A".repeat(8000);
			await markPendingProposalFailed(proposal.id, {
				errorClass: longClass,
				errorMessage: longMessage,
				rawApplyError: longApply,
			});
			const reread = await db.pendingBacklogProposal.findUniqueOrThrow({
				where: { id: proposal.id },
			});
			expect(reread.errorClass?.length).toBe(200);
			expect(reread.errorMessage?.length).toBe(500);
			expect(reread.applyError?.length).toBe(4000);
		});

		it("falls back to errorMessage when rawApplyError is omitted", async () => {
			const project = await seedProject({
				orgId: ORG_A,
				userId: USER_A,
				name: "Fallback Project",
			});
			const proposal = await seedPendingProposal({
				projectId: project.id,
				userId: USER_A,
				organizationId: ORG_A,
			});
			await markPendingProposalFailed(proposal.id, {
				errorClass: "default",
				errorMessage: "Couldn't sync this proposal.",
			});
			const reread = await db.pendingBacklogProposal.findUniqueOrThrow({
				where: { id: proposal.id },
			});
			expect(reread.applyError).toBe("Couldn't sync this proposal.");
			expect(reread.errorMessage).toBe("Couldn't sync this proposal.");
		});

		it("listFailedProposals filters by status=FAILED and respects per-source filter", async () => {
			const project = await seedProject({
				orgId: ORG_A,
				userId: USER_A,
				name: "List Filter Project",
			});
			const pendingRow = await seedPendingProposal({
				projectId: project.id,
				userId: USER_A,
				organizationId: ORG_A,
			});
			const failedSidebar = await seedPendingProposal({
				projectId: project.id,
				userId: USER_A,
				organizationId: ORG_A,
				source: "AI_UPDATE_SIDEBAR",
			});
			const failedTeams = await seedPendingProposal({
				projectId: project.id,
				userId: USER_A,
				organizationId: ORG_A,
				source: "TEAMS_CHANNEL",
			});
			await markPendingProposalFailed(failedSidebar.id, {
				errorClass: "PayloadTooLarge",
				errorMessage: "Body too long.",
			});
			await markPendingProposalFailed(failedTeams.id, {
				errorClass: "PmRateLimitError",
				errorMessage: "Rate limited.",
			});

			// No source filter → both failed rows, pending excluded.
			const all = await listFailedProposals({ projectId: project.id });
			expect(all.map((r) => r.id).sort()).toEqual(
				[failedSidebar.id, failedTeams.id].sort(),
			);
			expect(all.some((r) => r.id === pendingRow.id)).toBe(false);

			// Single-value source filter.
			const sidebarOnly = await listFailedProposals({
				projectId: project.id,
				source: "AI_UPDATE_SIDEBAR",
			});
			expect(sidebarOnly.map((r) => r.id)).toEqual([failedSidebar.id]);

			// Array source filter.
			const both = await listFailedProposals({
				projectId: project.id,
				source: ["AI_UPDATE_SIDEBAR", "TEAMS_CHANNEL"],
			});
			expect(both.map((r) => r.id).sort()).toEqual(
				[failedSidebar.id, failedTeams.id].sort(),
			);
		});

		it("listFailedProposals orders by failedAt desc", async () => {
			const project = await seedProject({
				orgId: ORG_A,
				userId: USER_A,
				name: "Order Project",
			});
			const first = await seedPendingProposal({
				projectId: project.id,
				userId: USER_A,
				organizationId: ORG_A,
			});
			await markPendingProposalFailed(first.id, {
				errorClass: "default",
				errorMessage: "earliest failure",
			});
			// Force a measurable gap so the timestamps differ.
			await new Promise((resolve) => setTimeout(resolve, 20));
			const second = await seedPendingProposal({
				projectId: project.id,
				userId: USER_A,
				organizationId: ORG_A,
			});
			await markPendingProposalFailed(second.id, {
				errorClass: "default",
				errorMessage: "later failure",
			});

			const rows = await listFailedProposals({ projectId: project.id });
			expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
		});

		it("tenant XOR — listFailedProposals stays inside its projectId scope", async () => {
			const projectA = await seedProject({
				orgId: ORG_A,
				userId: USER_A,
				name: "Tenant XOR Project A",
			});
			const projectB = await seedProject({
				orgId: ORG_B,
				userId: USER_B,
				name: "Tenant XOR Project B",
			});
			const proposalA = await seedPendingProposal({
				projectId: projectA.id,
				userId: USER_A,
				organizationId: ORG_A,
			});
			const proposalB = await seedPendingProposal({
				projectId: projectB.id,
				userId: USER_B,
				organizationId: ORG_B,
			});
			await markPendingProposalFailed(proposalA.id, {
				errorClass: "default",
				errorMessage: "tenant A failure",
			});
			await markPendingProposalFailed(proposalB.id, {
				errorClass: "default",
				errorMessage: "tenant B failure",
			});

			const rowsForA = await listFailedProposals({
				projectId: projectA.id,
			});
			expect(rowsForA.map((r) => r.id)).toEqual([proposalA.id]);
			expect(rowsForA.every((r) => r.organizationId === ORG_A)).toBe(
				true,
			);
			expect(rowsForA.every((r) => r.userId === USER_A)).toBe(true);

			const rowsForB = await listFailedProposals({
				projectId: projectB.id,
			});
			expect(rowsForB.map((r) => r.id)).toEqual([proposalB.id]);
		});
	},
);
