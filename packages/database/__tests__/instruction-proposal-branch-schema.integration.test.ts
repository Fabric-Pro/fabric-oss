/**
 * Member proposal branch schema on a real Postgres (Fizzy #2738 spec §4.1,
 * §4.6): every CHECK the migrations add rejects its violating row, the
 * partial unique index allows one accepting branch per member and project,
 * and the intent-order sequence is monotonic. Self-skips without a reachable
 * database.
 *
 * Violations are written with raw SQL so the assertion can name the
 * constraint Postgres reports, rather than trusting any rejection.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `pr-branch-schema-org-${RUN_ID}`;
const USER_ID = `pr-branch-schema-user-${RUN_ID}`;
const REPOSITORY_KEY = `github:example-org/example-repo-${RUN_ID}`;
let projectId = "";
let version = 0;
let branchNumber = 0;

const DESTINATION = {
	integrationId: "int_1",
	syncId: "sync_1",
	repositoryKey: REPOSITORY_KEY,
	provider: "GITHUB",
	repository: {
		provider: "GITHUB",
		owner: "example-org",
		repo: "example-repo",
	},
	targetRef: "main",
	rootPath: "",
};

async function seedSnapshot(): Promise<string> {
	version += 1;
	const row = await db.projectInstructionSnapshot.create({
		data: {
			projectId,
			organizationId: ORGANIZATION_ID,
			userId: USER_ID,
			version,
			source: "UPLOAD",
			status: "READY",
			settingsFrozen: {},
			publishOnReady: false,
		},
		select: { id: true },
	});
	return row.id;
}

async function seedBranch(
	state: "PENDING" | "OPENING" | "OPEN" | "BLOCKED" | "MERGED" = "PENDING",
): Promise<string> {
	branchNumber += 1;
	const row = await db.projectInstructionProposalBranch.create({
		data: {
			organizationId: ORGANIZATION_ID,
			projectId,
			userId: USER_ID,
			repositoryKey: REPOSITORY_KEY,
			number: branchNumber,
			ref: `fabric/instructions/members/member-abcd/${branchNumber}`,
			state,
			destination: DESTINATION,
		},
		select: { id: true },
	});
	return row.id;
}

/** Runs one statement and returns the constraint Postgres named, or null. */
async function violation(sql: string, ...values: unknown[]) {
	try {
		await db.$executeRawUnsafe(sql, ...values);
		return null;
	} catch (error) {
		return String(error);
	}
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"member proposal branch schema (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: USER_ID,
					name: "Branch Schema Member",
					email: `${USER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Proposal Branch Schema Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Proposal Branch Schema Integration",
					userId: USER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			projectId = project.id;
		});

		afterEach(async () => {
			await db.projectInstructionSnapshot.deleteMany({
				where: { projectId },
			});
			await db.projectInstructionProposalBranch.deleteMany({
				where: { projectId },
			});
			await db.projectInstructionProposalRefReservation.deleteMany({
				where: { organizationId: ORGANIZATION_ID },
			});
		});

		afterAll(async () => {
			if (projectId) {
				await db.project.deleteMany({ where: { id: projectId } });
			}
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({ where: { id: USER_ID } });
			await db.$disconnect();
		});

		describe("snapshot CHECKs (spec §4.1)", () => {
			const update = (id: string, set: string) =>
				violation(
					`UPDATE "project_instruction_snapshot" SET ${set} WHERE "id" = $1`,
					id,
				);

			it.each([
				[
					"project_instruction_snapshot_withdraw_pair",
					`"withdrawRequestedAt" = now()`,
				],
				[
					"project_instruction_snapshot_withdraw_pair",
					`"withdrawScope" = 'change'`,
				],
				[
					"project_instruction_snapshot_withdraw_scope",
					`"withdrawRequestedAt" = now(), "withdrawScope" = 'everything'`,
				],
				[
					"project_instruction_snapshot_pending_command_pair",
					`"pendingCommand" = 'APPEND'`,
				],
				[
					"project_instruction_snapshot_pending_command_pair",
					`"pendingCommandSeq" = 3`,
				],
				[
					"project_instruction_snapshot_pending_command_kind",
					`"pendingCommand" = 'REVERT', "pendingCommandSeq" = 3`,
				],
				// The null-safe implication: a WITHDRAW with no intent at all
				// must not pass on a NULL operand.
				[
					"project_instruction_snapshot_pending_withdraw_scope",
					`"pendingCommand" = 'WITHDRAW', "pendingCommandSeq" = 7, "withdrawRequestedAt" = NULL, "withdrawScope" = NULL`,
				],
				[
					"project_instruction_snapshot_pending_withdraw_scope",
					`"pendingCommand" = 'WITHDRAW', "pendingCommandSeq" = 7, "withdrawRequestedAt" = now(), "withdrawScope" = 'branch'`,
				],
				[
					"project_instruction_snapshot_pending_append_intent",
					`"pendingCommand" = 'APPEND', "pendingCommandSeq" = 2, "withdrawRequestedAt" = now(), "withdrawScope" = 'change'`,
				],
			])("%s rejects SET %s", async (constraint, set) => {
				const id = await seedSnapshot();
				expect(await update(id, set)).toContain(constraint);
			});

			it.each([
				`"withdrawRequestedAt" = now(), "withdrawScope" = 'change'`,
				`"withdrawRequestedAt" = now(), "withdrawScope" = 'branch'`,
				`"pendingCommand" = 'WITHDRAW', "pendingCommandSeq" = 7, "withdrawRequestedAt" = now(), "withdrawScope" = 'change'`,
				`"pendingCommand" = 'APPEND', "pendingCommandSeq" = 2`,
			])("accepts SET %s", async (set) => {
				const id = await seedSnapshot();
				expect(await update(id, set)).toBeNull();
			});
		});

		describe("branch, reservation and journal CHECKs", () => {
			it.each([
				[
					"project_instruction_proposal_branch_close_intent",
					`"closeIntent" = 'DELETE'`,
				],
				[
					"project_instruction_proposal_branch_settlement_phase",
					`"settlementPhase" = 'closed'`,
				],
				[
					"project_instruction_proposal_branch_retired_reason",
					`"retiredReason" = 'TARGET_BRANCH_MISSING'`,
				],
			])("%s rejects SET %s", async (constraint, set) => {
				const id = await seedBranch();
				expect(
					await violation(
						`UPDATE "project_instruction_proposal_branch" SET ${set} WHERE "id" = $1`,
						id,
					),
				).toContain(constraint);
			});

			it("accepts every allowed branch value", async () => {
				const id = await seedBranch();
				expect(
					await violation(
						`UPDATE "project_instruction_proposal_branch" SET "closeIntent" = 'START_OVER', "settlementPhase" = 'recorded', "retiredReason" = 'BRANCH_MISSING' WHERE "id" = $1`,
						id,
					),
				).toBeNull();
			});

			it("rejects a reservation status outside current, refused, retired", async () => {
				const insert = (status: string, ref: string) =>
					violation(
						`INSERT INTO "project_instruction_proposal_ref_reservation" ("id", "organizationId", "repositoryKey", "ref", "branchId", "status") VALUES ($1, $2, $3, $4, 'branch_x', $5)`,
						`res-${ref}-${RUN_ID}`,
						ORGANIZATION_ID,
						REPOSITORY_KEY,
						`fabric/instructions/members/member-abcd/${ref}`,
						status,
					);
				expect(await insert("released", "901")).toContain(
					"project_instruction_proposal_ref_reservation_status",
				);
				expect(await insert("refused", "902")).toBeNull();
			});

			it("never lets one ref be reserved twice on a repository", async () => {
				const insert = (id: string) =>
					violation(
						`INSERT INTO "project_instruction_proposal_ref_reservation" ("id", "organizationId", "repositoryKey", "ref", "branchId", "status") VALUES ($1, $2, $3, 'fabric/instructions/members/member-abcd/903', 'branch_x', 'current')`,
						`${id}-${RUN_ID}`,
						ORGANIZATION_ID,
						REPOSITORY_KEY,
					);
				expect(await insert("res-a")).toBeNull();
				expect(await insert("res-b")).toContain(
					"project_instruction_proposal_ref_reservation_ref_key",
				);
			});

			it.each([
				[
					"project_instruction_proposal_branch_operation_outcome",
					"'pushed'",
					"NULL",
				],
				[
					"project_instruction_proposal_branch_operation_membership",
					"NULL",
					"'excluded'",
				],
			])(
				"%s rejects its value",
				async (constraint, outcome, membership) => {
					const branchId = await seedBranch();
					expect(
						await violation(
							`INSERT INTO "project_instruction_proposal_branch_operation" ("id", "organizationId", "branchId", "snapshotId", "kind", "executionSeq", "ref", "assignment", "attempt", "sha", "entries", "outcome", "membership") VALUES ($1, $2, $3, 'snap_x', 'APPEND', 1, 'fabric/instructions/members/member-abcd/1', 0, 1, $4, '[]'::jsonb, ${outcome}, ${membership})`,
							`op-${RUN_ID}-${constraint.length}`,
							ORGANIZATION_ID,
							branchId,
							"a".repeat(40),
						),
					).toContain(constraint);
				},
			);
		});

		describe("one accepting branch per member and project (spec Decision 2)", () => {
			it("rejects a second accepting branch and accepts one once the first is retired", async () => {
				const first = await seedBranch("OPEN");
				await expect(seedBranch("PENDING")).rejects.toThrow();
				await db.projectInstructionProposalBranch.update({
					where: { id: first },
					data: {
						retiredAt: new Date(),
						retiredReason: "CONFIGURATION_CHANGED",
					},
				});
				await expect(seedBranch("PENDING")).resolves.toEqual(
					expect.any(String),
				);
			});

			it("does not count a terminal or untracked branch", async () => {
				await seedBranch("MERGED");
				const untracked = await seedBranch("BLOCKED");
				await db.projectInstructionProposalBranch.update({
					where: { id: untracked },
					data: { untracked: true },
				});
				await expect(seedBranch("OPENING")).resolves.toEqual(
					expect.any(String),
				);
			});
		});

		it("hands out a monotonic intent order", async () => {
			const next = async () => {
				const [row] = await db.$queryRaw<{ n: bigint }[]>`
					SELECT nextval('project_instruction_proposal_intent_seq') AS n
				`;
				return row.n;
			};
			const a = await next();
			const b = await next();
			const c = await next();
			expect(b > a).toBe(true);
			expect(c > b).toBe(true);
		});
	},
);
