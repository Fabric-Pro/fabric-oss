/**
 * Proposal pull-request transitions on a real Postgres (Fizzy #2563 spec
 * §4.4, plan Decision 7): the claim's row lock and attempt fence under two
 * concurrent callers, the database clock that decides a BLOCKED row's
 * backoff, the record write's lock, and the JSON path guards the §4.4 table
 * compiles to. Self-skips without a reachable database.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	createDerivedInstructionSnapshot,
	db,
	getInstructionProposal,
	getInstructionRepositorySync,
	getInstructionRepositorySyncForProposal,
	listInstructionProposals,
	listInstructionSnapshots,
	markInstructionSnapshotRejected,
	type Prisma,
	type RecordAuditInput,
	rejectAbandonedInstructionSnapshot,
	updateInstructionRepositorySyncProposalSettings,
} from "../index";
import {
	applyPullRequestChange,
	claimPullRequestOpen,
	clearMergeSyncRequest,
	deferProposalOperation,
	findMergeTriggeredRun,
	getProposalOperation,
	getSyncRunReceiptByRunId,
	getSyncRunReceiptsByRunIds,
	markMergeSyncDispatched,
	PULL_REQUEST_REFRESH_COOLDOWN_SECONDS,
	type PullRequestAttemptRecord,
	recordMergeSyncRun,
	requestPullRequestRefresh,
	selectDueProposalOperations,
	storePullRequestHeadSha,
	transitionPullRequest,
	writeAttemptRecord,
} from "../prisma/queries/instruction-proposal-pull-requests";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `pr-transitions-org-${RUN_ID}`;
const USER_ID = `pr-transitions-user-${RUN_ID}`;
let projectId = "";
let version = 0;

function failure(code: string, phase: string, retryable: boolean) {
	return {
		code,
		phase,
		retryable,
		at: "2026-09-24T11:00:00.000Z",
		params: {},
	};
}

async function seed(
	state:
		| "QUEUED"
		| "OPENING"
		| "OPEN"
		| "BLOCKED"
		| "CLOSE_REQUESTED"
		| "MERGED"
		| "CANCELED",
	extra: Partial<Prisma.ProjectInstructionSnapshotUncheckedCreateInput> = {},
): Promise<string> {
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
			proposalStatus: "PENDING",
			proposalDestination: "REPOSITORY",
			pullRequestOperationId: `op${RUN_ID.replace(/\D/g, "")}${version}`,
			pullRequestState: state,
			pullRequestAttempt: 3,
			...extra,
		},
		select: { id: true },
	});
	return row.id;
}

async function stateOf(id: string) {
	return db.projectInstructionSnapshot.findUniqueOrThrow({
		where: { id },
		select: {
			pullRequestState: true,
			proposalStatus: true,
			pullRequestAttempt: true,
			pullRequestAttempts: true,
			pullRequestObligationOpen: true,
			pullRequestConfirmationDueAt: true,
		},
	});
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"proposal pull-request transitions (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: USER_ID,
					name: "Proposal Author",
					email: `${USER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Proposal Pull Request Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Proposal Pull Request Integration",
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

		const claim = (
			snapshotId: string,
			expectedAttempt: number,
			retryCreate?: { expectedAttempt: number },
		) =>
			claimPullRequestOpen({
				snapshotId,
				organizationId: ORGANIZATION_ID,
				expectedAttempt,
				...(retryCreate ? { retryCreate } : {}),
			});

		it("lets exactly one of two concurrent claims naming the same attempt win", async () => {
			const id = await seed("QUEUED");
			const results = await Promise.all([claim(id, 3), claim(id, 3)]);
			const kinds = results.map((r) => r.kind).sort();
			expect(kinds).toEqual(["claimed", "not_claimable"]);
			expect(results.find((r) => r.kind === "claimed")).toEqual({
				kind: "claimed",
				attempt: 4,
			});
			expect(await stateOf(id)).toMatchObject({
				pullRequestState: "OPENING",
				proposalStatus: "PENDING",
				pullRequestAttempt: 4,
			});
		});

		it("refuses a claim naming an older attempt", async () => {
			const id = await seed("OPENING");
			expect(await claim(id, 2)).toEqual({ kind: "not_claimable" });
			expect((await stateOf(id)).pullRequestAttempt).toBe(3);
		});

		it("holds a retryable BLOCKED row until the database clock reaches its next attempt", async () => {
			const id = await seed("BLOCKED", {
				pullRequestFailure: failure("GIT_FAILED", "prepare", true),
			});
			await db.$executeRaw`
				UPDATE "project_instruction_snapshot"
				SET "pullRequestNextAttemptAt" = (now() AT TIME ZONE 'UTC') + interval '10 minutes'
				WHERE "id" = ${id}`;
			expect(await claim(id, 3)).toEqual({ kind: "not_claimable" });
			await db.$executeRaw`
				UPDATE "project_instruction_snapshot"
				SET "pullRequestNextAttemptAt" = (now() AT TIME ZONE 'UTC')
				WHERE "id" = ${id}`;
			expect(await claim(id, 3)).toEqual({ kind: "claimed", attempt: 4 });
		});

		it("lets a human retry at the current attempt ignore a future next attempt", async () => {
			const id = await seed("BLOCKED", {
				pullRequestFailure: failure(
					"CREATE_OUTCOME_UNKNOWN",
					"create",
					false,
				),
			});
			await db.$executeRaw`
				UPDATE "project_instruction_snapshot"
				SET "pullRequestNextAttemptAt" = (now() AT TIME ZONE 'UTC') + interval '1 hour'
				WHERE "id" = ${id}`;
			expect(await claim(id, 3)).toEqual({ kind: "not_claimable" });
			expect(await claim(id, 3, { expectedAttempt: 3 })).toEqual({
				kind: "claimed",
				attempt: 4,
			});
		});

		it("lets exactly one of two concurrent create-marker writes land", async () => {
			const record: PullRequestAttemptRecord = {
				attempt: 3,
				ref: "fabric/instructions/op",
				sha: "a".repeat(40),
				pushIssuedAt: "2026-09-24T10:00:00.000Z",
				pushAckedAt: "2026-09-24T10:00:01.000Z",
				confirmations: 0,
			};
			const id = await seed("OPENING", {
				pullRequestAttempts: [
					record,
				] as unknown as Prisma.InputJsonValue[],
			});
			const write = (at: string) =>
				writeAttemptRecord({
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					identity: { attempt: 3, ref: record.ref },
					expect: { pushAckedAt: "set", createIssuedAt: null },
					patch: { createIssuedAt: at },
					row: { states: ["OPENING"], attempt: 3 },
				});
			const results = await Promise.all([
				write("2026-09-24T10:00:02.000Z"),
				write("2026-09-24T10:00:03.000Z"),
			]);
			expect(results.filter(Boolean)).toHaveLength(1);
			const after = await stateOf(id);
			const [stored] =
				after.pullRequestAttempts as unknown as PullRequestAttemptRecord[];
			expect(stored.createIssuedAt).toMatch(
				/^2026-09-24T10:00:0[23]\.000Z$/,
			);
			expect(after.pullRequestObligationOpen).toBe(true);
		});

		it("stores the confirmation clock a settlement starts", async () => {
			const id = await seed("OPEN", {
				pullRequestAttempts: [
					{
						attempt: 3,
						ref: "fabric/instructions/op",
						sha: "a".repeat(40),
						pushIssuedAt: "2026-09-24T10:00:00.000Z",
						pushAckedAt: "2026-09-24T10:00:01.000Z",
						confirmations: 0,
					},
				],
			});
			expect(
				await writeAttemptRecord({
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					identity: { attempt: 3, ref: "fabric/instructions/op" },
					expect: { settledAt: null },
					patch: {
						settledAt: "2026-09-24T12:00:00.000Z",
						outcome: "settled",
					},
				}),
			).toBe(true);
			expect(await stateOf(id)).toMatchObject({
				pullRequestObligationOpen: true,
				pullRequestConfirmationDueAt: new Date(
					"2026-09-24T13:00:00.000Z",
				),
			});
		});

		/**
		 * The admission transaction on Postgres (Fizzy #2563 Decision 11):
		 * a REPOSITORY proposal's `upload_started` row commits with the
		 * snapshot and its file rows, or none of them do. The fault is real,
		 * not a mock: the audit row names an actor user that does not exist,
		 * so the audit write's user reference fails inside the create
		 * transaction, after the snapshot and file rows were written.
		 */
		describe("admission rollback", () => {
			it("leaves no snapshot, file or audit row when the upload_started write fails, and admits the same proposal once it succeeds", async () => {
				version += 1;
				const baseId = `rollback-base-${RUN_ID}`;
				const basePrefix = `projects/${projectId}/instructions/snapshots/${baseId}/`;
				const operationId = `oprollback${RUN_ID.replace(/\D/g, "")}`;
				await db.projectInstructionSnapshot.create({
					data: {
						id: baseId,
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: USER_ID,
						version,
						source: "UPLOAD",
						status: "READY",
						settingsFrozen: {},
						publishOnReady: false,
						readyAt: new Date(),
					},
				});
				await db.projectInstructionFile.createMany({
					data: ["CLAUDE.md", "REMOVE.md"].map((path, index) => ({
						snapshotId: baseId,
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: USER_ID,
						path,
						kind: "INSTRUCTIONS" as const,
						storageKey: `${basePrefix}base-file-${index}`,
						sha256: createHash("sha256").update(path).digest("hex"),
						size: 10,
						mimeType: "text/markdown",
						isText: true,
					})),
				});
				await db.project.update({
					where: { id: projectId },
					data: { publishedInstructionSnapshotId: baseId },
				});
				const derive = (actorUserId: string) =>
					createDerivedInstructionSnapshot({
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: USER_ID,
						baseSnapshotId: baseId,
						publishOnReady: false,
						proposal: true,
						changes: [{ op: "delete", path: "REMOVE.md" }],
						limits: { maxFiles: 5_000, maxTotalBytes: 52_428_800 },
						baseKeyPrefix: basePrefix,
						note: { title: "Remove a file" },
						destination: {
							kind: "REPOSITORY",
							operationId,
							context: {
								syncId: "sync_rollback",
								syncGeneration: 1,
							},
							syncId: "sync_rollback",
							syncGeneration: 1,
							branch: `fabric/instructions/${operationId}`,
							uploadStartedAudit: {
								actor: { type: "user", userId: actorUserId },
								organizationId: ORGANIZATION_ID,
								projectId,
								metadata: {
									mode: "proposal",
									baseSnapshotId: baseId,
									baseVersion: version,
									putCount: 0,
									deleteCount: 1,
								},
							},
						},
					});
				const leftovers = async () => ({
					snapshots: await db.projectInstructionSnapshot.count({
						where: { projectId, id: { not: baseId } },
					}),
					files: await db.projectInstructionFile.count({
						where: { projectId, snapshotId: { not: baseId } },
					}),
					audits: await db.auditLog.count({
						where: {
							organizationId: ORGANIZATION_ID,
							projectId,
							action: "project.instructions.upload_started",
						},
					}),
				});
				try {
					const failed = await derive(`${USER_ID}-missing`).then(
						(result) => ({ result, error: undefined }),
						(error: unknown) => ({ result: undefined, error }),
					);
					// Rows first: a swallowed audit failure would still leave
					// them behind, whatever the call returned.
					expect(await leftovers()).toEqual({
						snapshots: 0,
						files: 0,
						audits: 0,
					});
					expect(failed.result).toBeUndefined();
					// The audit write's missing user, as the connect check
					// (P2025) or the foreign key (P2003) reports it.
					expect(failed.error).toMatchObject({
						code: expect.stringMatching(/^P20(25|03)$/),
					});

					// The same proposal, operation id included, is admitted
					// once the audit write succeeds: nothing of the failed
					// attempt survived to collide with it.
					const admitted = await derive(USER_ID);
					expect(admitted).toMatchObject({
						ok: true,
						auditWritten: true,
					});
					expect(await leftovers()).toEqual({
						snapshots: 1,
						files: 1,
						audits: 1,
					});
				} finally {
					await db.project.update({
						where: { id: projectId },
						data: { publishedInstructionSnapshotId: null },
					});
				}
			});
		});

		/**
		 * The attempt fence on Postgres (spec §4.2): the UPDATE's attempt
		 * predicate is what serializes two
		 * callers holding the same observation, because the loser re-reads
		 * the row after the winner commits and no longer matches.
		 */
		describe("attempt fence", () => {
			const closeClaim = (id: string, expectedAttempt: number | null) =>
				transitionPullRequest({
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					event: "claim",
					from: ["CLOSE_REQUESTED"],
					expectedAttempt,
					to: "unchanged",
					bumpAttempt: true,
				});

			it("lets exactly one of two concurrent Close claims take the row", async () => {
				const id = await seed("CLOSE_REQUESTED");
				const results = await Promise.all([
					closeClaim(id, 3),
					closeClaim(id, 3),
				]);
				expect(results.filter((r) => r.ok)).toEqual([
					{ ok: true, attempt: 4 },
				]);
				expect(results.filter((r) => !r.ok)).toEqual([{ ok: false }]);
				expect(await stateOf(id)).toMatchObject({
					pullRequestState: "CLOSE_REQUESTED",
					pullRequestAttempt: 4,
				});
			});

			it("refuses a fenced event that names no attempt, and writes nothing", async () => {
				const closing = await seed("CLOSE_REQUESTED");
				const opening = await seed("OPENING");
				await expect(closeClaim(closing, null)).rejects.toThrow(
					/is attempt-fenced/,
				);
				await expect(
					transitionPullRequest({
						snapshotId: opening,
						organizationId: ORGANIZATION_ID,
						event: "open_failure",
						from: ["OPENING"],
						expectedAttempt: null,
						to: "BLOCKED",
						bumpAttempt: false,
						data: {
							pullRequestFailure: failure(
								"GIT_FAILED",
								"prepare",
								true,
							),
						},
					}),
				).rejects.toThrow(/is attempt-fenced/);
				expect(await stateOf(closing)).toMatchObject({
					pullRequestState: "CLOSE_REQUESTED",
					pullRequestAttempt: 3,
				});
				expect(await stateOf(opening)).toMatchObject({
					pullRequestState: "OPENING",
					pullRequestAttempt: 3,
				});
			});

			it("records a receipt's facts on CLOSE_REQUESTED at whatever attempt the row is at", async () => {
				const id = await seed("CLOSE_REQUESTED", {
					pullRequestAttempt: 9,
				});
				expect(
					await transitionPullRequest({
						snapshotId: id,
						organizationId: ORGANIZATION_ID,
						event: "receipt",
						from: ["CLOSE_REQUESTED"],
						expectedAttempt: null,
						to: "unchanged",
						bumpAttempt: false,
						data: { pullRequestExternalId: "42" },
						audit: {
							action: "project.instructions.pull_request_opened",
							category: "project",
							actor: { type: "system" },
							organizationId: ORGANIZATION_ID,
							projectId,
							resource: {
								type: "project_instruction_snapshot",
								id,
							},
							metadata: { operationId: "op", adopted: false },
						},
					}),
				).toEqual({ ok: true, attempt: 9 });
				expect(await stateOf(id)).toMatchObject({
					pullRequestState: "CLOSE_REQUESTED",
					pullRequestAttempt: 9,
				});
			});

			it("cancels a gate-rejected REPOSITORY proposal at the attempt it reads under the row lock", async () => {
				const id = await seed("QUEUED", { status: "VALIDATING" });
				expect(
					await markInstructionSnapshotRejected({
						snapshotId: id,
						projectId,
						organizationId: ORGANIZATION_ID,
						rejections: [
							{ path: "a.md", reason: "secret", detail: "jwt" },
						],
						audit: {
							action: "project.instructions.rejected",
							category: "project",
							actor: { type: "user", userId: USER_ID },
							organizationId: ORGANIZATION_ID,
							projectId,
							resource: {
								type: "project_instruction_snapshot",
								id,
							},
						},
					}),
				).toEqual({ changed: true });
				expect(await stateOf(id)).toMatchObject({
					pullRequestState: "CANCELED",
					proposalStatus: "REJECTED",
					pullRequestAttempt: 4,
				});
			});
		});

		describe("JSON path guards on Postgres", () => {
			const reject = (id: string) =>
				transitionPullRequest({
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					event: "validation_rejected",
					from: ["QUEUED", "OPENING", "BLOCKED"],
					expectedAttempt: 3,
					to: "CANCELED",
					bumpAttempt: true,
					data: {
						pullRequestFailure: failure(
							"VALIDATION_REJECTED",
							"validation",
							false,
						),
					},
					audit: {
						action: "project.instructions.pull_request_reconciled",
						category: "project",
						actor: { type: "system" },
						organizationId: ORGANIZATION_ID,
						projectId,
						resource: { type: "project_instruction_snapshot", id },
						metadata: {
							outcome: "canceled",
							code: "VALIDATION_REJECTED",
						},
					},
				});

			it("cancels a BLOCKED row whose failure phase is validation, and audits it", async () => {
				const id = await seed("BLOCKED", {
					pullRequestFailure: failure(
						"VALIDATION_TIMEOUT",
						"validation",
						true,
					),
				});
				expect(await reject(id)).toEqual({ ok: true, attempt: 4 });
				expect(await stateOf(id)).toMatchObject({
					pullRequestState: "CANCELED",
					proposalStatus: "REJECTED",
					pullRequestAttempt: 4,
				});
				expect(
					await db.auditLog.count({
						where: {
							organizationId: ORGANIZATION_ID,
							action: "project.instructions.pull_request_reconciled",
							resourceId: id,
						},
					}),
				).toBe(1);
			});

			it("leaves a BLOCKED row from a later phase, and an OPENING row with a head, alone", async () => {
				const blocked = await seed("BLOCKED", {
					pullRequestFailure: failure("GIT_FAILED", "prepare", true),
				});
				const opening = await seed("OPENING", {
					pullRequestHeadSha: "b".repeat(40),
				});
				expect(await reject(blocked)).toEqual({ ok: false });
				expect(await reject(opening)).toEqual({ ok: false });
				expect((await stateOf(blocked)).pullRequestState).toBe(
					"BLOCKED",
				);
				expect((await stateOf(opening)).pullRequestState).toBe(
					"OPENING",
				);
			});

			it("splits BLOCKED cancels exactly between pre-create and later", async () => {
				const cancel = (
					id: string,
					event: "cancel_pre_create" | "cancel_later",
				) =>
					transitionPullRequest({
						snapshotId: id,
						organizationId: ORGANIZATION_ID,
						event,
						from: ["BLOCKED"],
						expectedAttempt: 3,
						to:
							event === "cancel_pre_create"
								? "CANCELED"
								: "CLOSE_REQUESTED",
						bumpAttempt: true,
						audit: {
							action: "project.instructions.pull_request_close_requested",
							category: "project",
							actor: { type: "user", userId: USER_ID },
							organizationId: ORGANIZATION_ID,
							projectId,
							resource: {
								type: "project_instruction_snapshot",
								id,
							},
							metadata: { stateBefore: "BLOCKED" },
						},
					});
				const pre = await seed("BLOCKED", {
					pullRequestFailure: failure(
						"ATTRIBUTION_REJECTED",
						"admission",
						false,
					),
				});
				const later = await seed("BLOCKED", {
					pullRequestFailure: failure(
						"PR_CREATION_REFUSED",
						"create",
						false,
					),
				});
				expect(await cancel(pre, "cancel_later")).toEqual({
					ok: false,
				});
				expect(await cancel(later, "cancel_pre_create")).toEqual({
					ok: false,
				});
				expect(await cancel(pre, "cancel_pre_create")).toEqual({
					ok: true,
					attempt: 4,
				});
				expect(await cancel(later, "cancel_later")).toEqual({
					ok: true,
					attempt: 4,
				});
				expect((await stateOf(pre)).pullRequestState).toBe("CANCELED");
				expect((await stateOf(later)).pullRequestState).toBe(
					"CLOSE_REQUESTED",
				);
			});

			it("offers Retry opening only on a non-retryable create outcome, with exactly one retry audit row", async () => {
				const retryRequested = (id: string): RecordAuditInput => ({
					action: "project.instructions.pull_request_retry_requested",
					category: "project",
					actor: { type: "user", userId: USER_ID },
					organizationId: ORGANIZATION_ID,
					projectId,
					resource: { type: "project_instruction_snapshot", id },
					metadata: { operationId: "op" },
				});
				const retry = (id: string, audit: RecordAuditInput[]) =>
					transitionPullRequest({
						snapshotId: id,
						organizationId: ORGANIZATION_ID,
						event: "retry",
						from: ["BLOCKED"],
						expectedAttempt: 3,
						to: "unchanged",
						bumpAttempt: false,
						audit,
					});
				const retryAudits = (id: string) =>
					db.auditLog.count({
						where: {
							organizationId: ORGANIZATION_ID,
							action: "project.instructions.pull_request_retry_requested",
							resourceId: id,
						},
					});
				const retryable = await seed("BLOCKED", {
					pullRequestFailure: failure(
						"CREATE_OUTCOME_UNKNOWN",
						"create",
						true,
					),
				});
				const final = await seed("BLOCKED", {
					pullRequestFailure: failure(
						"CREATE_OUTCOME_UNKNOWN",
						"create",
						false,
					),
				});
				// Spec §4.4 and §13.4: a Retry opening is never unaudited.
				await expect(retry(final, [])).rejects.toThrow(
					/writes exactly/,
				);
				await expect(
					retry(final, [
						retryRequested(final),
						retryRequested(final),
					]),
				).rejects.toThrow(/writes exactly/);
				expect(await retryAudits(final)).toBe(0);
				expect(
					await retry(retryable, [retryRequested(retryable)]),
				).toEqual({ ok: false });
				expect(await retry(final, [retryRequested(final)])).toEqual({
					ok: true,
					attempt: 3,
				});
				expect(await retryAudits(retryable)).toBe(0);
				expect(await retryAudits(final)).toBe(1);
			});
		});
		/**
		 * The sweeper's selection (spec §9) on the database's own clock. The
		 * query is system-wide, so the limits are generous and every
		 * assertion is about this run's rows only.
		 */
		describe("sweeper selection", () => {
			const LIMITS = {
				close: 1000,
				recover: 1000,
				mergeSync: 1000,
				observe: 1000,
				restart: 1000,
			};
			const ago = (minutes: number) =>
				new Date(Date.now() - minutes * 60 * 1000);
			const record = (
				id: string,
				patch: Partial<PullRequestAttemptRecord>,
				ref = "fabric/instructions/r1",
			) =>
				writeAttemptRecord({
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					identity: { attempt: 1, ref },
					expect: {},
					patch: { sha: "c".repeat(40), confirmations: 0, ...patch },
					append: true,
				});

			async function selected() {
				const due = await selectDueProposalOperations(LIMITS);
				const mine = (items: Array<{ snapshotId: string }>) =>
					items
						.map((i) => i.snapshotId)
						.filter((id) => Object.values(rows).includes(id))
						.map(
							(id) =>
								Object.entries(rows).find(
									([, v]) => v === id,
								)?.[0],
						)
						.sort();
				return {
					close: mine(due.close),
					recover: mine(due.recover),
					mergeSync: mine(due.mergeSync),
					observe: mine(due.observe),
					restart: mine(due.restart),
					raw: due,
				};
			}
			const rows: Record<string, string> = {};

			it("selects each sub-batch's rows once, on the database clock", async () => {
				// A: terminal, one record settled 61 minutes ago, no
				// confirmation yet: due for its first confirmation. B: OPEN,
				// never checked.
				rows.a = await seed("OPEN", {
					pullRequestState: "CANCELED",
					proposalStatus: "REJECTED",
				});
				expect(
					await record(rows.a, {
						pushIssuedAt: ago(70).toISOString(),
						pushAckedAt: ago(70).toISOString(),
						settledAt: ago(61).toISOString(),
						outcome: "settled",
					}),
				).toBe(true);
				rows.b = await seed("OPEN");
				// D: restart-eligible AND due for a confirmation: Close takes
				// it, so Restart must not.
				rows.d = await seed("QUEUED", { createdAt: ago(10) });
				await record(rows.d, {
					pushIssuedAt: ago(70).toISOString(),
					pushAckedAt: ago(70).toISOString(),
					settledAt: ago(61).toISOString(),
					outcome: "settled",
				});
				// E: QUEUED but created under two minutes ago.
				rows.e = await seed("QUEUED");
				// F: OPENING with an unsettled create marker: Recover (1).
				rows.f = await seed("OPENING", { createdAt: ago(10) });
				await record(rows.f, {
					pushIssuedAt: ago(9).toISOString(),
					pushAckedAt: ago(9).toISOString(),
					createIssuedAt: ago(8).toISOString(),
				});
				// G: OPENING, its current record acknowledged, never created:
				// Recover (2).
				rows.g = await seed("OPENING", {
					createdAt: ago(10),
					pullRequestRef: "fabric/instructions/r1",
				});
				await record(rows.g, {
					pushIssuedAt: ago(9).toISOString(),
					pushAckedAt: ago(9).toISOString(),
				});
				// H: merged, merge sync owed.
				rows.h = await seed("OPEN", {
					pullRequestState: "MERGED",
					proposalStatus: "MERGED",
					mergeSyncRequestedAt: ago(1),
				});
				// I: QUEUED and old enough, but not due for an hour.
				rows.i = await seed("QUEUED", {
					createdAt: ago(10),
					pullRequestNextAttemptAt: new Date(
						Date.now() + 60 * 60 * 1000,
					),
				});
				// J: QUEUED and old enough: Restart.
				rows.j = await seed("QUEUED", { createdAt: ago(10) });
				// K: a retryable BLOCKED row: Restart; L: a non-retryable one: never.
				rows.k = await seed("BLOCKED", {
					createdAt: ago(10),
					pullRequestFailure: failure(
						"PROVIDER_TEMPORARY",
						"create",
						true,
					),
				});
				rows.l = await seed("BLOCKED", {
					createdAt: ago(10),
					pullRequestFailure: failure(
						"PR_CREATION_REFUSED",
						"create",
						false,
					),
				});
				// M: CLOSE_REQUESTED and due.
				rows.m = await seed("OPEN", {
					pullRequestState: "CLOSE_REQUESTED",
				});

				const due = await selected();
				expect(due.close).toEqual(["a", "d", "m"]);
				expect(due.recover).toEqual(["f", "g"]);
				expect(due.mergeSync).toEqual(["h"]);
				expect(due.observe).toEqual(["b"]);
				expect(due.restart).toEqual(["j", "k"]);
				const clause = (id: string) =>
					due.raw.recover.find((r) => r.snapshotId === id)
						?.recoverClause;
				expect(clause(rows.f)).toBe(1);
				expect(clause(rows.g)).toBe(2);
				const itemA = due.raw.close.find(
					(r) => r.snapshotId === rows.a,
				);
				expect(itemA).toMatchObject({
					projectId,
					organizationId: ORGANIZATION_ID,
					attempt: 3,
				});
				expect(typeof itemA?.attempt).toBe("number");
			});

			it("treats only an unsettled create marker as outstanding: a settled old marker leaves Recover (2) and Restart open", async () => {
				const settledOld: Partial<PullRequestAttemptRecord> = {
					pushIssuedAt: ago(40).toISOString(),
					pushAckedAt: ago(40).toISOString(),
					createIssuedAt: ago(39).toISOString(),
					// Settled 20 minutes ago: its first confirmation is not due
					// for another 40, so Close does not take the row.
					settledAt: ago(20).toISOString(),
					outcome: "settled",
				};
				const reissued = (
					id: string,
					patch: Partial<PullRequestAttemptRecord>,
				) =>
					writeAttemptRecord({
						snapshotId: id,
						organizationId: ORGANIZATION_ID,
						identity: {
							attempt: 4,
							ref: "fabric/instructions/r1-4",
						},
						expect: {},
						patch: {
							sha: "d".repeat(40),
							confirmations: 0,
							...patch,
						},
						append: true,
					});
				// P: a human retry settled the old record and re-issued on
				// r1-4, whose push was acknowledged: Recover (2).
				rows.p = await seed("OPENING", {
					createdAt: ago(45),
					pullRequestRef: "fabric/instructions/r1-4",
				});
				expect(await record(rows.p, settledOld)).toBe(true);
				expect(
					await reissued(rows.p, {
						pushIssuedAt: ago(5).toISOString(),
						pushAckedAt: ago(5).toISOString(),
					}),
				).toBe(true);
				// Q: the same settled old record and nothing pushed on the new
				// ref yet: Restart.
				rows.q = await seed("OPENING", {
					createdAt: ago(45),
					pullRequestRef: "fabric/instructions/r1-4",
				});
				expect(await record(rows.q, settledOld)).toBe(true);
				// R: an acknowledged current record beside an UNSETTLED marker:
				// Recover (1) only, never Recover (2) or Restart.
				rows.r = await seed("OPENING", {
					createdAt: ago(45),
					pullRequestRef: "fabric/instructions/r1-4",
				});
				expect(
					await record(rows.r, {
						pushIssuedAt: ago(40).toISOString(),
						pushAckedAt: ago(40).toISOString(),
						createIssuedAt: ago(39).toISOString(),
					}),
				).toBe(true);
				expect(
					await reissued(rows.r, {
						pushIssuedAt: ago(5).toISOString(),
						pushAckedAt: ago(5).toISOString(),
					}),
				).toBe(true);
				// S: a retryable BLOCKED row whose only marker is unsettled and
				// whose state Recover (1) still covers: never Restart.
				rows.s = await seed("BLOCKED", {
					createdAt: ago(45),
					pullRequestFailure: failure(
						"PROVIDER_TEMPORARY",
						"create",
						true,
					),
				});
				expect(
					await record(rows.s, {
						pushIssuedAt: ago(40).toISOString(),
						pushAckedAt: ago(40).toISOString(),
						createIssuedAt: ago(39).toISOString(),
					}),
				).toBe(true);

				const due = await selected();
				const clause = (id: string) =>
					due.raw.recover.find((r) => r.snapshotId === id)
						?.recoverClause;
				expect(due.recover).toContain("p");
				expect(clause(rows.p)).toBe(2);
				expect(due.restart).toContain("q");
				expect(due.recover).not.toContain("q");
				expect(clause(rows.r)).toBe(1);
				expect(due.restart).not.toContain("r");
				expect(clause(rows.s)).toBe(1);
				expect(due.restart).not.toContain("s");
				for (const id of ["p", "q", "r", "s"]) {
					expect(due.close).not.toContain(id);
				}
			});

			it("defers a row on the database clock, fenced on the attempt", async () => {
				rows.n = await seed("QUEUED", { createdAt: ago(10) });

				expect(
					await deferProposalOperation({
						snapshotId: rows.n,
						organizationId: ORGANIZATION_ID,
						attempt: 2,
						minutes: 30,
					}),
				).toBe(false);
				expect(
					await deferProposalOperation({
						snapshotId: rows.n,
						organizationId: ORGANIZATION_ID,
						attempt: 3,
						minutes: 30,
					}),
				).toBe(true);
				const [{ minutes }] = await db.$queryRaw<
					Array<{ minutes: number }>
				>`
					SELECT EXTRACT(EPOCH FROM (s."pullRequestNextAttemptAt" - (now() AT TIME ZONE 'UTC'))) / 60 AS "minutes"
					FROM "project_instruction_snapshot" s WHERE s."id" = ${rows.n}
				`;
				expect(Number(minutes)).toBeGreaterThan(29);
				expect(Number(minutes)).toBeLessThanOrEqual(30);
				expect((await selected()).restart).not.toContain("n");
			});
		});

		// A REJECTED snapshot whose operation was left QUEUED (its verdict's
		// cancel never ran) is Restart's on every tick, and readiness stops
		// each time. Readiness settles it with the verdict's own transition,
		// which needs the rejection to tell abandonment apart, and CANCELED
		// is then selected by no sub-batch.
		describe("sweeper selection: a REJECTED snapshot left QUEUED", () => {
			const LIMITS = {
				close: 1000,
				recover: 1000,
				mergeSync: 1000,
				observe: 1000,
				restart: 1000,
			};
			const abandoned = {
				path: "(upload)",
				reason: "abandoned",
				detail: "staging cleared",
			};
			const settle = (id: string, expectedAttempt: number) =>
				transitionPullRequest({
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					event: "abandoned",
					from: ["QUEUED"],
					expectedAttempt,
					to: "CANCELED",
					bumpAttempt: true,
					data: {
						pullRequestFailure: {
							...failure(
								"VALIDATION_REJECTED",
								"validation",
								false,
							),
							params: { reason: "abandoned" },
						},
						pullRequestNextAttemptAt: null,
					},
					audit: {
						action: "project.instructions.pull_request_reconciled",
						category: "project",
						actor: { type: "system" },
						organizationId: ORGANIZATION_ID,
						projectId,
						resource: { type: "project_instruction_snapshot", id },
						metadata: {
							outcome: "canceled",
							code: "VALIDATION_REJECTED",
							targetMismatch: false,
						},
					},
				});
			const everySubBatch = async () => {
				const due = await selectDueProposalOperations(LIMITS);
				return Object.values(due).flatMap((items) =>
					items.map((i) => i.snapshotId),
				);
			};

			it("reads the rejection beside the operation, and once readiness cancels it no sub-batch selects it again", async () => {
				const id = await seed("QUEUED", {
					status: "REJECTED",
					proposalStatus: "REJECTED",
					rejection: [abandoned],
					pullRequestAttempt: 0,
					createdAt: new Date(Date.now() - 10 * 60 * 1000),
				});
				const restart = async () =>
					(await selectDueProposalOperations(LIMITS)).restart.map(
						(i) => i.snapshotId,
					);
				expect(await restart()).toContain(id);

				const row = await getProposalOperation({
					snapshotId: id,
					projectId,
					organizationId: ORGANIZATION_ID,
				});
				expect(row?.rejection).toEqual([abandoned]);

				expect(await settle(id, 0)).toEqual({ ok: true, attempt: 1 });
				expect(await stateOf(id)).toMatchObject({
					pullRequestState: "CANCELED",
					proposalStatus: "REJECTED",
					pullRequestAttempt: 1,
					pullRequestObligationOpen: false,
				});
				expect(await everySubBatch()).not.toContain(id);

				// A second readiness finds CANCELED: the fence refuses the
				// same write and no second audit row lands.
				expect(await settle(id, 0)).toEqual({ ok: false });
				expect(
					await db.auditLog.count({
						where: {
							organizationId: ORGANIZATION_ID,
							action: "project.instructions.pull_request_reconciled",
							resourceId: id,
						},
					}),
				).toBe(1);
			});
		});

		// Recover (1)'s push arm on Postgres (spec §9): only a
		// push that was issued and never acknowledged is uncertain. A record
		// a branch-write refusal returned to not issued (SHA kept, no push
		// marker) is Restart's, and never takes a Recover slot.
		describe("sweeper selection: Recover (1) needs an issued push", () => {
			const LIMITS = {
				close: 1000,
				recover: 1000,
				mergeSync: 1000,
				observe: 1000,
				restart: 1000,
			};
			const ago = (minutes: number) =>
				new Date(Date.now() - minutes * 60 * 1000);
			const retryable = () =>
				failure("BRANCH_WRITE_REFUSED", "push", true);
			const withRecord = async (
				patch: Partial<PullRequestAttemptRecord>,
			) => {
				const id = await seed("BLOCKED", {
					createdAt: ago(10),
					pullRequestRef: "fabric/instructions/r1",
					pullRequestFailure: retryable(),
				});
				expect(
					await writeAttemptRecord({
						snapshotId: id,
						organizationId: ORGANIZATION_ID,
						identity: { attempt: 1, ref: "fabric/instructions/r1" },
						expect: {},
						patch: {
							sha: "c".repeat(40),
							confirmations: 0,
							...patch,
						},
						append: true,
					}),
				).toBe(true);
				return id;
			};
			const ids = (items: Array<{ snapshotId: string }>) =>
				items.map((i) => i.snapshotId);

			it("selects a record with a SHA but no push marker for Restart, not Recover", async () => {
				const notIssued = await withRecord({});
				const due = await selectDueProposalOperations(LIMITS);
				expect(ids(due.restart)).toContain(notIssued);
				expect(ids(due.recover)).not.toContain(notIssued);
			});

			it("still selects an issued, unacknowledged push for Recover (1)", async () => {
				const uncertain = await withRecord({
					pushIssuedAt: ago(9).toISOString(),
				});
				const due = await selectDueProposalOperations(LIMITS);
				const item = due.recover.find(
					(i) => i.snapshotId === uncertain,
				);
				expect(item?.recoverClause).toBe(1);
				expect(ids(due.restart)).not.toContain(uncertain);
			});
		});

		describe("sweeper selection: Close takes an abandoned acknowledged push", () => {
			const LIMITS = {
				close: 1000,
				recover: 1000,
				mergeSync: 1000,
				observe: 1000,
				restart: 1000,
			};
			const REF = "fabric/instructions/r1";
			const ago = (minutes: number) =>
				new Date(Date.now() - minutes * 60 * 1000);
			const acknowledged = {
				pushIssuedAt: ago(20).toISOString(),
				pushAckedAt: ago(20).toISOString(),
			};
			const blocked = async (
				row: Partial<Prisma.ProjectInstructionSnapshotUncheckedCreateInput>,
				record: Partial<PullRequestAttemptRecord>,
			) => {
				const id = await seed("BLOCKED", {
					createdAt: ago(30),
					pullRequestRef: REF,
					pullRequestFailure: failure(
						"PERMISSION_REVOKED",
						"create",
						false,
					),
					...row,
				});
				expect(
					await writeAttemptRecord({
						snapshotId: id,
						organizationId: ORGANIZATION_ID,
						identity: { attempt: 3, ref: REF },
						expect: {},
						patch: {
							sha: "c".repeat(40),
							confirmations: 0,
							...acknowledged,
							...record,
						},
						append: true,
					}),
				).toBe(true);
				return id;
			};
			const ids = (items: Array<{ snapshotId: string }>) =>
				items.map((i) => i.snapshotId);

			it("selects a non-retryable BLOCKED row whose acknowledged push was never created or settled for Close only", async () => {
				const abandoned = await blocked({}, {});
				const due = await selectDueProposalOperations(LIMITS);
				expect(ids(due.close)).toContain(abandoned);
				expect(ids(due.recover)).not.toContain(abandoned);
				expect(ids(due.restart)).not.toContain(abandoned);
			});

			it("leaves every other row to its own sub-batch or to a human", async () => {
				const rows = {
					retryable: await blocked(
						{
							pullRequestFailure: failure(
								"BRANCH_WRITE_REFUSED",
								"push",
								true,
							),
						},
						{},
					),
					recorded: await blocked({ pullRequestExternalId: "7" }, {}),
					marked: await blocked(
						{},
						{ createIssuedAt: ago(19).toISOString() },
					),
					settled: await blocked(
						{},
						{ settledAt: ago(5).toISOString(), outcome: "settled" },
					),
					conflict: await blocked({}, { outcome: "conflict" }),
					unacknowledged: await blocked(
						{},
						{ pushAckedAt: undefined },
					),
					otherRef: await blocked({ pullRequestRef: `${REF}-4` }, {}),
					deferred: await blocked(
						{
							pullRequestNextAttemptAt: new Date(
								Date.now() + 60 * 60 * 1000,
							),
						},
						{},
					),
				};
				const due = await selectDueProposalOperations(LIMITS);
				for (const [name, id] of Object.entries(rows)) {
					expect({
						name,
						close: ids(due.close).includes(id),
					}).toEqual({
						name,
						close: false,
					});
				}
				// The retryable row is Recover (2)'s, the marked one Recover (1)'s.
				expect(
					due.recover.find((i) => i.snapshotId === rows.retryable)
						?.recoverClause,
				).toBe(2);
				expect(
					due.recover.find((i) => i.snapshotId === rows.marked)
						?.recoverClause,
				).toBe(1);
			});
		});

		/**
		 * Clearing a merge-sync request (spec §9.1 steps 2 and 5) on
		 * Postgres: the JSON equality on `mergeSyncExpected` is the fence,
		 * an acknowledgment writes its one audit row with the clear, and a
		 * give-up writes its failure and no audit row.
		 */
		describe("merge-sync request clearing", () => {
			const EXPECTED = { syncId: "sync_1", generation: 3 };
			const merged = (
				extra: Partial<Prisma.ProjectInstructionSnapshotUncheckedCreateInput> = {},
			) =>
				seed("MERGED", {
					mergeSyncRequestedAt: new Date(Date.now() - 60 * 60 * 1000),
					mergeSyncDispatchedAt: new Date(
						Date.now() - 30 * 60 * 1000,
					),
					mergeSyncRunId: "run_1",
					mergeSyncExpected: EXPECTED,
					...extra,
				});
			const markers = (id: string) =>
				db.projectInstructionSnapshot.findUniqueOrThrow({
					where: { id },
					select: {
						pullRequestState: true,
						mergeSyncRequestedAt: true,
						mergeSyncDispatchedAt: true,
						mergeSyncRunId: true,
						pullRequestFailure: true,
					},
				});
			const acknowledgments = (id: string) =>
				db.auditLog.count({
					where: {
						organizationId: ORGANIZATION_ID,
						action: "project.instructions.pull_request_merge_sync_requested",
						resourceId: id,
					},
				});
			const acknowledge = (
				id: string,
				expected: { syncId: string; generation: number },
			) =>
				clearMergeSyncRequest({
					kind: "acknowledged",
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					expected,
					audit: {
						action: "project.instructions.pull_request_merge_sync_requested",
						category: "project",
						actor: { type: "system" },
						organizationId: ORGANIZATION_ID,
						projectId,
						resource: { type: "project_instruction_snapshot", id },
						metadata: {
							operationId: "op",
							syncRunKey: "sync_1:run_1",
						},
					},
				});

			it("acknowledges only the tuple still expected, keeping the run id, with one audit row", async () => {
				const id = await merged();
				expect(
					await acknowledge(id, { syncId: "sync_1", generation: 4 }),
				).toBe(false);
				expect(await acknowledgments(id)).toBe(0);
				expect(await acknowledge(id, EXPECTED)).toBe(true);
				expect(await markers(id)).toMatchObject({
					pullRequestState: "MERGED",
					mergeSyncRequestedAt: null,
					mergeSyncDispatchedAt: null,
					mergeSyncRunId: "run_1",
					pullRequestFailure: null,
				});
				expect(await acknowledgments(id)).toBe(1);
				expect(await acknowledge(id, EXPECTED)).toBe(false);
				expect(await acknowledgments(id)).toBe(1);
			});

			it("gives up a never-dispatched request with a non-retryable failure and no audit row", async () => {
				// Never dispatched: no tuple was ever written (SQL NULL).
				const id = await merged({
					mergeSyncDispatchedAt: null,
					mergeSyncRunId: null,
					mergeSyncExpected: undefined,
				});
				const failure = {
					phase: "merge_sync" as const,
					code: "CONFIGURATION_CHANGED" as const,
					retryable: false as const,
					at: "2026-09-24T12:00:00.000Z",
					params: {},
				};
				expect(
					await clearMergeSyncRequest({
						kind: "gave_up",
						snapshotId: id,
						organizationId: ORGANIZATION_ID,
						expected: null,
						failure,
					}),
				).toBe(true);
				expect(await markers(id)).toMatchObject({
					pullRequestState: "MERGED",
					mergeSyncRequestedAt: null,
					mergeSyncRunId: null,
					pullRequestFailure: failure,
				});
				expect(await acknowledgments(id)).toBe(0);
			});
		});

		describe("merge-sync receipts", () => {
			it("finds a receipt by run id whichever sync row keyed it, never another project's, and the newest merge-triggered run", async () => {
				const integration =
					await db.projectRepositoryIntegration.create({
						data: {
							projectId,
							provider: "GITHUB",
							authMethod: "OAUTH",
							repositoryUrl:
								"https://example.com/example-org/receipts",
							repositoryOwner: "example-org",
							repositoryName: "receipts",
						},
					});
				const sync = await db.projectInstructionRepositorySync.create({
					data: {
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: USER_ID,
						repositoryIntegrationId: integration.id,
						ref: "main",
						generation: 3,
					},
				});
				const other = await db.project.create({
					data: {
						name: "Receipts elsewhere",
						userId: USER_ID,
						organizationId: ORGANIZATION_ID,
						techStack: [],
						features: [],
						tags: [],
					},
				});
				const otherIntegration =
					await db.projectRepositoryIntegration.create({
						data: {
							projectId: other.id,
							provider: "GITHUB",
							authMethod: "OAUTH",
							repositoryUrl:
								"https://example.com/example-org/other",
							repositoryOwner: "example-org",
							repositoryName: "other",
						},
					});
				const otherSync =
					await db.projectInstructionRepositorySync.create({
						data: {
							projectId: other.id,
							organizationId: ORGANIZATION_ID,
							userId: USER_ID,
							repositoryIntegrationId: otherIntegration.id,
							ref: "main",
						},
					});
				const requestedAt = new Date(Date.now() - 60 * 60 * 1000);
				const receipt = (
					id: string,
					data: Partial<Prisma.ProjectInstructionRepositorySyncRunUncheckedCreateInput>,
				) =>
					db.projectInstructionRepositorySyncRun.create({
						data: {
							id,
							syncId: sync.id,
							projectId,
							organizationId: ORGANIZATION_ID,
							userId: USER_ID,
							generation: 3,
							trigger: "PULL_REQUEST_MERGED",
							startedAt: new Date(),
							...data,
						},
					});
				try {
					// Keyed by the row that existed when `begin` ran, which is
					// not the sync id the dispatcher passed.
					await receipt(`${sync.id}:run-a`, {});
					await db.projectInstructionRepositorySyncRun.create({
						data: {
							id: `${otherSync.id}:run-b`,
							syncId: otherSync.id,
							projectId: other.id,
							organizationId: ORGANIZATION_ID,
							userId: USER_ID,
							generation: 1,
							trigger: "PULL_REQUEST_MERGED",
							startedAt: new Date(),
						},
					});
					expect(
						await getSyncRunReceiptByRunId({
							projectId,
							organizationId: ORGANIZATION_ID,
							runId: "run-a",
						}),
					).toMatchObject({
						id: `${sync.id}:run-a`,
						syncId: sync.id,
					});
					expect(
						await getSyncRunReceiptByRunId({
							projectId,
							organizationId: ORGANIZATION_ID,
							runId: "run-b",
						}),
					).toBeNull();

					// The page read answers each run as the single read does:
					// run-a from this project, not run-b from another, and
					// nothing for a run with no receipt.
					const page = await getSyncRunReceiptsByRunIds({
						projectId,
						organizationId: ORGANIZATION_ID,
						runIds: ["run-a", "run-b", "run-missing", ""],
					});
					expect([...page.keys()]).toEqual(["run-a"]);
					expect(page.get("run-a")).toMatchObject({
						id: `${sync.id}:run-a`,
						syncId: sync.id,
					});
					expect(
						await getSyncRunReceiptsByRunIds({
							projectId,
							organizationId: `${ORGANIZATION_ID}-elsewhere`,
							runIds: ["run-a"],
						}),
					).toEqual(new Map());

					await receipt(`${sync.id}:run-old`, {
						startedAt: new Date(requestedAt.getTime() - 60 * 1000),
					});
					await receipt(`${sync.id}:run-poll`, {
						trigger: "POLL",
						startedAt: new Date(Date.now() + 1000),
					});
					await receipt(`${sync.id}:run-other-generation`, {
						generation: 4,
						startedAt: new Date(Date.now() + 2000),
					});
					const newest = await receipt(`${sync.id}:run-new`, {
						startedAt: new Date(Date.now() + 500),
					});
					expect(
						await findMergeTriggeredRun({
							projectId,
							organizationId: ORGANIZATION_ID,
							syncId: sync.id,
							generation: 3,
							startedAtOrAfter: requestedAt,
						}),
					).toMatchObject({
						id: newest.id,
						trigger: "PULL_REQUEST_MERGED",
						generation: 3,
						status: null,
						error: null,
					});
				} finally {
					await db.project.deleteMany({ where: { id: other.id } });
					await db.projectInstructionRepositorySync.deleteMany({
						where: { id: sync.id },
					});
					await db.projectRepositoryIntegration.deleteMany({
						where: { id: integration.id },
					});
				}
			});

			/**
			 * Spec §13.5: `organizationId` is in every query. Each row below
			 * differs from a matching one only in its organization, so only
			 * the organization predicate can keep it out.
			 */
			it("never matches another organization's sync row or receipts", async () => {
				const OTHER_ORGANIZATION_ID = `${ORGANIZATION_ID}-other`;
				await db.organization.create({
					data: {
						id: OTHER_ORGANIZATION_ID,
						name: "Proposal Pull Request Other Tenant",
						slug: OTHER_ORGANIZATION_ID,
						createdAt: new Date(),
					},
				});
				const integration =
					await db.projectRepositoryIntegration.create({
						data: {
							projectId,
							provider: "GITHUB",
							authMethod: "OAUTH",
							repositoryUrl:
								"https://example.com/example-org/tenants",
							repositoryOwner: "example-org",
							repositoryName: "tenants",
						},
					});
				const sync = await db.projectInstructionRepositorySync.create({
					data: {
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: USER_ID,
						repositoryIntegrationId: integration.id,
						ref: "main",
						generation: 3,
					},
				});
				const requestedAt = new Date(Date.now() - 60 * 60 * 1000);
				const run = (id: string, organizationId: string, at: number) =>
					db.projectInstructionRepositorySyncRun.create({
						data: {
							id: `${sync.id}:${id}`,
							syncId: sync.id,
							projectId,
							organizationId,
							userId: USER_ID,
							generation: 3,
							trigger: "PULL_REQUEST_MERGED",
							startedAt: new Date(Date.now() + at),
						},
					});
				try {
					const mine = await run("run-mine", ORGANIZATION_ID, 0);
					// Newer, so an unscoped newest-first read would pick it.
					const foreign = await run(
						"run-foreign",
						OTHER_ORGANIZATION_ID,
						5000,
					);

					expect(
						await getInstructionRepositorySyncForProposal(
							projectId,
							ORGANIZATION_ID,
						),
					).toMatchObject({ id: sync.id });
					expect(
						await getInstructionRepositorySyncForProposal(
							projectId,
							OTHER_ORGANIZATION_ID,
						),
					).toBeNull();

					const receipt = (organizationId: string, runId: string) =>
						getSyncRunReceiptByRunId({
							projectId,
							organizationId,
							runId,
						});
					expect(
						await receipt(ORGANIZATION_ID, "run-foreign"),
					).toBeNull();
					expect(
						await receipt(OTHER_ORGANIZATION_ID, "run-mine"),
					).toBeNull();
					expect(
						await receipt(ORGANIZATION_ID, "run-mine"),
					).toMatchObject({ id: mine.id });
					expect(
						await receipt(OTHER_ORGANIZATION_ID, "run-foreign"),
					).toMatchObject({ id: foreign.id });

					const newest = (organizationId: string) =>
						findMergeTriggeredRun({
							projectId,
							organizationId,
							syncId: sync.id,
							generation: 3,
							startedAtOrAfter: requestedAt,
						});
					expect(await newest(ORGANIZATION_ID)).toMatchObject({
						id: mine.id,
					});
					expect(await newest(OTHER_ORGANIZATION_ID)).toMatchObject({
						id: foreign.id,
					});
				} finally {
					await db.projectInstructionRepositorySync.deleteMany({
						where: { id: sync.id },
					});
					await db.projectRepositoryIntegration.deleteMany({
						where: { id: integration.id },
					});
					await db.organization.deleteMany({
						where: { id: OTHER_ORGANIZATION_ID },
					});
				}
			});
		});

		describe("the stale-VALIDATING clock (phase B carry-over)", () => {
			const OLD = new Date("2026-09-20T00:00:00.000Z");
			const clockOf = async (id: string) =>
				(
					await db.projectInstructionSnapshot.findUniqueOrThrow({
						where: { id },
						select: { updatedAt: true },
					})
				).updatedAt;
			const backdate = (id: string) => db.$executeRaw`
				UPDATE "project_instruction_snapshot" SET "updatedAt" = ${OLD}
				WHERE "id" = ${id}`;

			it("leaves updatedAt alone when a transition lands on a VALIDATING snapshot", async () => {
				const id = await seed("QUEUED", { status: "VALIDATING" });
				await backdate(id);
				const moved = await transitionPullRequest({
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					event: "deadline",
					from: ["QUEUED"],
					expectedAttempt: 3,
					to: "BLOCKED",
					bumpAttempt: false,
					data: {
						pullRequestFailure: failure(
							"VALIDATION_TIMEOUT",
							"validation",
							true,
						),
					},
				});
				expect(moved).toEqual({ ok: true, attempt: 3 });
				expect((await stateOf(id)).pullRequestState).toBe("BLOCKED");
				expect((await clockOf(id)).toISOString()).toBe(
					OLD.toISOString(),
				);
			});

			it("leaves updatedAt alone for a record write and a claim on a VALIDATING snapshot", async () => {
				const id = await seed("QUEUED", {
					status: "VALIDATING",
					pullRequestAttempts: [
						{
							attempt: 1,
							ref: "fabric/instructions/x",
							sha: "a",
							confirmations: 0,
						},
					] as unknown as Prisma.InputJsonValue[],
				});
				await backdate(id);
				expect(
					await writeAttemptRecord({
						snapshotId: id,
						organizationId: ORGANIZATION_ID,
						identity: { attempt: 1, ref: "fabric/instructions/x" },
						expect: {},
						patch: { outcome: "conflict" },
					}),
				).toBe(true);
				expect(await claim(id, 3)).toEqual({
					kind: "claimed",
					attempt: 4,
				});
				expect((await clockOf(id)).toISOString()).toBe(
					OLD.toISOString(),
				);
			});

			it("still stamps updatedAt on a READY snapshot", async () => {
				const id = await seed("QUEUED");
				await backdate(id);
				await transitionPullRequest({
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					event: "deadline",
					from: ["QUEUED"],
					expectedAttempt: 3,
					to: "BLOCKED",
					bumpAttempt: false,
				});
				expect((await clockOf(id)).getTime()).toBeGreaterThan(
					OLD.getTime(),
				);
			});
		});

		describe("operation activity writes", () => {
			const REF = "fabric/instructions/cexample000000000000000a";

			it("reads the operation with the database clock", async () => {
				const id = await seed("OPENING");
				const row = await getProposalOperation({
					snapshotId: id,
					projectId,
					organizationId: ORGANIZATION_ID,
				});
				expect(row).toMatchObject({ id, pullRequestState: "OPENING" });
				expect(
					Math.abs((row?.databaseNow.getTime() ?? 0) - Date.now()),
				).toBeLessThan(60_000);
				expect(
					await getProposalOperation({
						snapshotId: id,
						projectId,
						organizationId: `${ORGANIZATION_ID}-other`,
					}),
				).toBeNull();
			});

			it("rolls every part back when one part of a composite change matches nothing", async () => {
				const id = await seed("OPENING", {
					pullRequestAttempts: [
						{
							attempt: 3,
							ref: REF,
							sha: "a",
							pushIssuedAt: "2026-09-24T00:00:00.000Z",
							pushAckedAt: "2026-09-24T00:00:01.000Z",
							createIssuedAt: "2026-09-24T00:00:02.000Z",
							confirmations: 0,
						},
					] as unknown as Prisma.InputJsonValue[],
				});
				const records = [
					{
						identity: { attempt: 3, ref: REF },
						expect: { createIssuedAt: "set" as const },
						patch: {
							createIssuedAt: null,
							outcome: "opened" as const,
						},
					},
				];
				const stale = await applyPullRequestChange({
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					records,
					transition: {
						event: "receipt",
						from: ["OPENING"],
						expectedAttempt: 2,
						to: "OPEN",
						bumpAttempt: false,
						audit: {
							action: "project.instructions.pull_request_opened",
							actor: { type: "user", userId: USER_ID },
							organizationId: ORGANIZATION_ID,
							projectId,
						},
					},
				});
				expect(stale).toEqual({ ok: false });
				const untouched = await stateOf(id);
				expect(untouched.pullRequestState).toBe("OPENING");
				expect(
					(
						untouched.pullRequestAttempts as unknown as PullRequestAttemptRecord[]
					)[0]?.createIssuedAt,
				).toBeDefined();
				const current = await applyPullRequestChange({
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					records,
					transition: {
						event: "receipt",
						from: ["OPENING"],
						expectedAttempt: 3,
						to: "OPEN",
						bumpAttempt: false,
						audit: {
							action: "project.instructions.pull_request_opened",
							actor: { type: "user", userId: USER_ID },
							organizationId: ORGANIZATION_ID,
							projectId,
						},
					},
				});
				expect(current).toEqual({ ok: true, attempt: 3 });
				const opened = await stateOf(id);
				expect(opened.pullRequestState).toBe("OPEN");
				expect(opened.pullRequestObligationOpen).toBe(false);
				expect(
					(
						opened.pullRequestAttempts as unknown as PullRequestAttemptRecord[]
					)[0],
				).toMatchObject({ outcome: "opened" });
			});

			it("stores the head SHA once, refuses another, and records the first branch", async () => {
				const id = await seed("OPENING");
				const store = (sha: string, attempt = 3) =>
					storePullRequestHeadSha({
						snapshotId: id,
						organizationId: ORGANIZATION_ID,
						attempt,
						sha,
						ref: REF,
					});
				expect(await store("a".repeat(40), 2)).toBe("moved");
				expect(await store("a".repeat(40))).toBe("stored");
				expect(await store("a".repeat(40))).toBe("stored");
				expect(await store("b".repeat(40))).toBe("mismatch");
				const row =
					await db.projectInstructionSnapshot.findUniqueOrThrow({
						where: { id },
						select: {
							pullRequestHeadSha: true,
							pullRequestRef: true,
						},
					});
				expect(row).toEqual({
					pullRequestHeadSha: "a".repeat(40),
					pullRequestRef: REF,
				});
			});

			it("writes a plain null in a JSON column as SQL NULL", async () => {
				const id = await seed("BLOCKED", {
					pullRequestFailure: failure("UNEXPECTED", "create", true),
					pullRequestObservation: { targetRef: "main" },
				});
				const moved = await transitionPullRequest({
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					event: "failure",
					from: ["BLOCKED"],
					expectedAttempt: 3,
					to: "unchanged",
					bumpAttempt: false,
					data: {
						pullRequestFailure: null,
						pullRequestObservation: null,
					},
				});
				expect(moved).toEqual({ ok: true, attempt: 3 });
				const [nulls] = await db.$queryRaw<
					Array<{ failure: boolean; observation: boolean }>
				>`SELECT "pullRequestFailure" IS NULL AS failure, "pullRequestObservation" IS NULL AS observation FROM "project_instruction_snapshot" WHERE "id" = ${id}`;
				expect(nulls).toEqual({ failure: true, observation: true });
			});

			it("marks a merge-sync dispatch only against the tuple last read, forgetting the old run", async () => {
				const requested = new Date(Date.now() - 60 * 60 * 1000);
				const id = await seed("MERGED", {
					mergeSyncRequestedAt: requested,
					mergeSyncExpected: { syncId: "sync_1", generation: 3 },
					mergeSyncDispatchedAt: new Date(
						Date.now() - 30 * 60 * 1000,
					),
					mergeSyncRunId: "run_old",
				});
				const next = { syncId: "sync_1", generation: 4 };
				const dispatchedAt = new Date();
				const nextAttemptAt = new Date(Date.now() + 5 * 60 * 1000);
				const mark = (lastExpected: typeof next | null) =>
					markMergeSyncDispatched({
						snapshotId: id,
						organizationId: ORGANIZATION_ID,
						lastExpected,
						next,
						dispatchedAt,
						nextAttemptAt,
					});
				expect(await mark(null)).toBe(false);
				expect(await mark({ syncId: "sync_1", generation: 2 })).toBe(
					false,
				);
				expect(await mark({ syncId: "sync_1", generation: 3 })).toBe(
					true,
				);
				const row =
					await db.projectInstructionSnapshot.findUniqueOrThrow({
						where: { id },
						select: {
							mergeSyncExpected: true,
							mergeSyncDispatchedAt: true,
							mergeSyncRunId: true,
							mergeSyncRequestedAt: true,
							pullRequestNextAttemptAt: true,
						},
					});
				expect(row).toEqual({
					mergeSyncExpected: next,
					mergeSyncDispatchedAt: dispatchedAt,
					mergeSyncRunId: null,
					mergeSyncRequestedAt: requested,
					pullRequestNextAttemptAt: nextAttemptAt,
				});

				expect(
					await recordMergeSyncRun({
						snapshotId: id,
						organizationId: ORGANIZATION_ID,
						expected: { syncId: "sync_1", generation: 3 },
						runId: "run_new",
					}),
				).toBe(false);
				expect(
					await recordMergeSyncRun({
						snapshotId: id,
						organizationId: ORGANIZATION_ID,
						expected: next,
						runId: "run_new",
					}),
				).toBe(true);
				expect(
					(
						await db.projectInstructionSnapshot.findUniqueOrThrow({
							where: { id },
							select: { mergeSyncRunId: true },
						})
					).mergeSyncRunId,
				).toBe("run_new");
			});

			it("marks a first dispatch against a never-dispatched request and refuses a row with no request", async () => {
				const fresh = await seed("MERGED", {
					mergeSyncRequestedAt: new Date(),
				});
				const input = {
					organizationId: ORGANIZATION_ID,
					lastExpected: null,
					next: { syncId: "sync_1", generation: 3 },
					dispatchedAt: new Date(),
					nextAttemptAt: new Date(),
				};
				expect(
					await markMergeSyncDispatched({
						...input,
						snapshotId: fresh,
					}),
				).toBe(true);
				const none = await seed("MERGED");
				expect(
					await markMergeSyncDispatched({
						...input,
						snapshotId: none,
					}),
				).toBe(false);
				const open = await seed("OPEN", {
					mergeSyncRequestedAt: new Date(),
				});
				expect(
					await markMergeSyncDispatched({
						...input,
						snapshotId: open,
					}),
				).toBe(false);
			});
		});

		describe("surfaces (phase C, Task 16)", () => {
			const target = (snapshotId: string) => ({
				snapshotId,
				projectId,
				organizationId: ORGANIZATION_ID,
			});
			const nextAttemptOf = async (id: string) =>
				db.projectInstructionSnapshot.findUniqueOrThrow({
					where: { id },
					select: {
						pullRequestNextAttemptAt: true,
						pullRequestLastCheckedAt: true,
						pullRequestRefreshAdmittedAt: true,
						updatedAt: true,
					},
				});
			const databaseNow = async () => {
				const [clock] = await db.$queryRaw<Array<{ now: Date }>>`
					SELECT (now() AT TIME ZONE 'UTC') AS "now"`;
				if (!clock) {
					throw new Error("no database clock");
				}
				return clock.now;
			};

			it("shows a proposer their own MERGED and CLOSED proposals in History, and no other non-reviewer", async () => {
				const merged = await seed("MERGED", {
					proposalStatus: "MERGED",
				});
				const closed = await seed("OPEN", {
					pullRequestState: "CLOSED",
					proposalStatus: "CLOSED",
				});
				const pending = await seed("OPEN");
				const ids = (rows: Array<{ id: string }>) =>
					rows.map((row) => row.id).sort();

				const own = await listInstructionSnapshots(
					projectId,
					ORGANIZATION_ID,
					{ viewerUserId: USER_ID, canReviewProposals: false },
				);
				expect(ids(own)).toEqual([merged, closed, pending].sort());

				const other = await listInstructionSnapshots(
					projectId,
					ORGANIZATION_ID,
					{
						viewerUserId: `${USER_ID}-other`,
						canReviewProposals: false,
					},
				);
				expect(ids(other)).toEqual([]);

				const reviewer = await listInstructionSnapshots(
					projectId,
					ORGANIZATION_ID,
					{
						viewerUserId: `${USER_ID}-other`,
						canReviewProposals: true,
					},
				);
				expect(ids(reviewer)).toEqual([merged, closed, pending].sort());
			});

			it("lists and gets a proposal with its destination, note and pull-request fields", async () => {
				const id = await seed("OPEN", {
					proposalNote: { title: "Tighten the lint rule" },
					pullRequestUrl:
						"https://example.com/example-org/example-repo/pull/7",
					pullRequestExternalId: "7",
					pullRequestObservation: {
						targetRef: "main",
						targetMismatch: false,
					},
					mergeSyncRunId: "run_1",
				});
				const listed = await listInstructionProposals(
					projectId,
					ORGANIZATION_ID,
					{ limit: 10 },
				);
				const got = await getInstructionProposal(
					id,
					projectId,
					ORGANIZATION_ID,
				);
				for (const row of [listed.items[0], got]) {
					expect(row).toMatchObject({
						id,
						proposalDestination: "REPOSITORY",
						proposalNote: { title: "Tighten the lint rule" },
						pullRequestOperationId: expect.any(String),
						pullRequestState: "OPEN",
						pullRequestAttempt: 3,
						pullRequestUrl:
							"https://example.com/example-org/example-repo/pull/7",
						pullRequestExternalId: "7",
						pullRequestFailure: null,
						pullRequestLastCheckedAt: null,
						pullRequestObservation: {
							targetRef: "main",
							targetMismatch: false,
						},
						mergeSyncRequestedAt: null,
						mergeSyncRunId: "run_1",
					});
				}
			});

			it("narrows a proposal lookup to its proposer, so another member's id reads as a missing one", async () => {
				const id = await seed("OPEN");

				expect(
					await getInstructionProposal(
						id,
						projectId,
						ORGANIZATION_ID,
						{ proposerUserId: USER_ID },
					),
				).toMatchObject({ id, userId: USER_ID });
				expect(
					await getInstructionProposal(
						id,
						projectId,
						ORGANIZATION_ID,
					),
				).toMatchObject({ id });
				for (const proposerUserId of [`${USER_ID}-other`, ""]) {
					expect(
						await getInstructionProposal(
							id,
							projectId,
							ORGANIZATION_ID,
							{ proposerUserId },
						),
					).toBeNull();
				}
				expect(
					await getInstructionProposal(
						`${id}-absent`,
						projectId,
						ORGANIZATION_ID,
						{ proposerUserId: `${USER_ID}-other` },
					),
				).toBeNull();
			});

			it("refreshes on the database clock: nulls lastCheckedAt and makes only a retryable BLOCKED row due", async () => {
				const future = new Date(Date.now() + 6 * 60 * 60 * 1000);
				const checked = new Date(Date.now() - 60 * 1000);
				const retryable = await seed("BLOCKED", {
					pullRequestFailure: failure(
						"PROVIDER_TEMPORARY",
						"create",
						true,
					),
					pullRequestNextAttemptAt: future,
					pullRequestLastCheckedAt: checked,
				});
				const refused = await seed("BLOCKED", {
					pullRequestFailure: failure(
						"PR_CREATION_REFUSED",
						"create",
						false,
					),
					pullRequestNextAttemptAt: future,
				});
				const open = await seed("OPEN", {
					pullRequestLastCheckedAt: checked,
					pullRequestNextAttemptAt: future,
				});

				const [clock] = await db.$queryRaw<Array<{ now: Date }>>`
					SELECT (now() AT TIME ZONE 'UTC') AS "now"`;
				expect(
					await requestPullRequestRefresh(target(retryable)),
				).toEqual({
					admitted: true,
					state: "BLOCKED",
					attempt: 3,
					failure: failure("PROVIDER_TEMPORARY", "create", true),
				});
				const due = await nextAttemptOf(retryable);
				expect(due.pullRequestLastCheckedAt).toBeNull();
				// The admission is stamped on the database clock.
				expect(
					Math.abs(
						(due.pullRequestRefreshAdmittedAt?.getTime() ?? 0) -
							(clock?.now.getTime() ?? 0),
					),
				).toBeLessThan(60_000);
				expect(due.pullRequestNextAttemptAt?.getTime()).toBeLessThan(
					future.getTime(),
				);
				expect(
					Math.abs(
						(due.pullRequestNextAttemptAt?.getTime() ?? 0) -
							(clock?.now.getTime() ?? 0),
					),
				).toBeLessThan(60_000);

				expect(
					await requestPullRequestRefresh(target(refused)),
				).toMatchObject({ admitted: true, state: "BLOCKED" });
				expect(
					(
						await nextAttemptOf(refused)
					).pullRequestNextAttemptAt?.getTime(),
				).toBe(future.getTime());

				expect(
					await requestPullRequestRefresh(target(open)),
				).toMatchObject({
					admitted: true,
					state: "OPEN",
				});
				const observed = await nextAttemptOf(open);
				expect(observed.pullRequestLastCheckedAt).toBeNull();
				expect(observed.pullRequestNextAttemptAt?.getTime()).toBe(
					future.getTime(),
				);
			});

			it("refreshes nothing terminal, nothing in another organization, and never moves a VALIDATING clock", async () => {
				const merged = await seed("MERGED", {
					proposalStatus: "MERGED",
				});
				expect(
					await requestPullRequestRefresh(target(merged)),
				).toBeNull();

				const queued = await seed("QUEUED");
				expect(
					await requestPullRequestRefresh({
						...target(queued),
						organizationId: `${ORGANIZATION_ID}-elsewhere`,
					}),
				).toBeNull();
				expect(
					await requestPullRequestRefresh({
						...target(queued),
						projectId: `${projectId}-elsewhere`,
					}),
				).toBeNull();

				const validating = await seed("QUEUED", {
					status: "VALIDATING",
				});
				const OLD = new Date("2026-09-20T00:00:00.000Z");
				await db.$executeRaw`
					UPDATE "project_instruction_snapshot" SET "updatedAt" = ${OLD}
					WHERE "id" = ${validating}`;
				expect(
					await requestPullRequestRefresh(target(validating)),
				).toMatchObject({ admitted: true, state: "QUEUED" });
				expect(
					(await nextAttemptOf(validating)).updatedAt.toISOString(),
				).toBe(OLD.toISOString());
			});

			it("admits one Refresh a minute: one right after is refused with the seconds left and changes nothing", async () => {
				const id = await seed("BLOCKED", {
					pullRequestFailure: failure(
						"PROVIDER_TEMPORARY",
						"create",
						true,
					),
					pullRequestNextAttemptAt: new Date(
						Date.now() + 60 * 60 * 1000,
					),
				});
				expect(
					await requestPullRequestRefresh(target(id)),
				).toMatchObject({ admitted: true, state: "BLOCKED" });
				// The attempt the Refresh made due fails again and backs off; an
				// Observe records a check. A refused Refresh undoes neither.
				const backedOff = new Date(Date.now() + 30 * 60 * 1000);
				const observed = new Date(Date.now() - 1000);
				await db.$executeRaw`
					UPDATE "project_instruction_snapshot"
					SET "pullRequestNextAttemptAt" = ${backedOff},
						"pullRequestLastCheckedAt" = ${observed}
					WHERE "id" = ${id}`;
				const before = await nextAttemptOf(id);

				const second = await requestPullRequestRefresh(target(id));
				expect(second).toMatchObject({
					admitted: false,
					reason: "cooldown",
				});
				const wait =
					second && !second.admitted ? second.retryAfterSeconds : 0;
				expect(wait).toBeGreaterThanOrEqual(
					PULL_REQUEST_REFRESH_COOLDOWN_SECONDS - 10,
				);
				expect(wait).toBeLessThanOrEqual(
					PULL_REQUEST_REFRESH_COOLDOWN_SECONDS,
				);
				expect(await nextAttemptOf(id)).toEqual(before);

				// Once the minute has passed on the database clock, it is
				// admitted again.
				await db.$executeRaw`
					UPDATE "project_instruction_snapshot"
					SET "pullRequestRefreshAdmittedAt" =
						(now() AT TIME ZONE 'UTC') - make_interval(secs => ${PULL_REQUEST_REFRESH_COOLDOWN_SECONDS + 1}::int)
					WHERE "id" = ${id}`;
				expect(
					await requestPullRequestRefresh(target(id)),
				).toMatchObject({ admitted: true });
			});

			it("admits exactly one of several concurrent refreshes", async () => {
				const id = await seed("BLOCKED", {
					pullRequestFailure: failure(
						"PROVIDER_TEMPORARY",
						"create",
						true,
					),
					pullRequestNextAttemptAt: new Date(
						Date.now() + 60 * 60 * 1000,
					),
				});

				const answers = await Promise.all(
					Array.from({ length: 6 }, () =>
						requestPullRequestRefresh(target(id)),
					),
				);

				expect(
					answers.filter((a) => a?.admitted === true),
				).toHaveLength(1);
				for (const refused of answers.filter(
					(a) => a?.admitted === false,
				)) {
					expect(refused).toMatchObject({
						admitted: false,
						reason: "cooldown",
					});
				}
				expect(answers.every((a) => a !== null)).toBe(true);
			});

			it("never moves a provider's rate-limit deadline, and admits only once it has passed", async () => {
				const now = await databaseNow();
				const deadline = new Date(now.getTime() + 10 * 60 * 1000);
				const checked = new Date(now.getTime() - 5 * 60 * 1000);
				const id = await seed("BLOCKED", {
					pullRequestFailure: failure(
						"PROVIDER_RATE_LIMITED",
						"create",
						true,
					),
					pullRequestNextAttemptAt: deadline,
					pullRequestLastCheckedAt: checked,
				});

				const refused = await requestPullRequestRefresh(target(id));
				expect(refused).toMatchObject({
					admitted: false,
					reason: "provider_rate_limited",
				});
				const wait =
					refused && !refused.admitted
						? refused.retryAfterSeconds
						: 0;
				expect(wait).toBeGreaterThan(9 * 60);
				expect(wait).toBeLessThanOrEqual(10 * 60);
				expect(await nextAttemptOf(id)).toMatchObject({
					pullRequestNextAttemptAt: deadline,
					pullRequestLastCheckedAt: checked,
					pullRequestRefreshAdmittedAt: null,
				});

				// Past its deadline the row is due anyway; a Refresh is admitted
				// and still leaves the provider's time where it was.
				const passed = new Date(now.getTime() - 60 * 1000);
				await db.$executeRaw`
					UPDATE "project_instruction_snapshot"
					SET "pullRequestNextAttemptAt" = ${passed}
					WHERE "id" = ${id}`;
				expect(
					await requestPullRequestRefresh(target(id)),
				).toMatchObject({ admitted: true, state: "BLOCKED" });
				expect(
					(await nextAttemptOf(id)).pullRequestNextAttemptAt,
				).toEqual(passed);
			});

			it("writes only allowReaderProposals, never the generation, and only in the caller's organization", async () => {
				const integration =
					await db.projectRepositoryIntegration.create({
						data: {
							projectId,
							provider: "GITHUB",
							authMethod: "OAUTH",
							repositoryUrl:
								"https://example.com/example-org/settings",
							repositoryOwner: "example-org",
							repositoryName: "settings",
						},
					});
				const sync = await db.projectInstructionRepositorySync.create({
					data: {
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: USER_ID,
						repositoryIntegrationId: integration.id,
						ref: "main",
						rootPath: "agents",
						generation: 4,
					},
				});
				try {
					expect(
						await updateInstructionRepositorySyncProposalSettings({
							projectId,
							organizationId: `${ORGANIZATION_ID}-elsewhere`,
							allowReaderProposals: true,
						}),
					).toBeNull();
					expect(
						await updateInstructionRepositorySyncProposalSettings({
							projectId,
							organizationId: ORGANIZATION_ID,
							allowReaderProposals: true,
						}),
					).toEqual({
						id: sync.id,
						generation: 4,
						allowReaderProposals: true,
						repositoryIntegration: {
							provider: "GITHUB",
							repositoryOwner: "example-org",
							repositoryName: "settings",
						},
					});
					const after =
						await db.projectInstructionRepositorySync.findUniqueOrThrow(
							{ where: { id: sync.id } },
						);
					expect(after).toMatchObject({
						generation: 4,
						ref: "main",
						rootPath: "agents",
						userId: USER_ID,
						repositoryIntegrationId: integration.id,
						allowReaderProposals: true,
					});
					expect(
						await getInstructionRepositorySync(
							projectId,
							ORGANIZATION_ID,
						),
					).toMatchObject({ allowReaderProposals: true });
				} finally {
					await db.projectInstructionRepositorySync.deleteMany({
						where: { id: sync.id },
					});
					await db.projectRepositoryIntegration.deleteMany({
						where: { id: integration.id },
					});
				}
			});
		});

		describe("inline-submit compensation", () => {
			it("compensation after a failed upload leaves the snapshot REJECTED and the operation CANCELED with VALIDATION_REJECTED and a refresh returns null", async () => {
				// A repository proposal as the create transaction leaves it:
				// RECEIVING, PENDING, its operation QUEUED. Its pull-request
				// workflow may already be waiting on readiness; the upload that
				// was to follow failed, so the request compensates.
				const id = await seed("QUEUED", { status: "RECEIVING" });
				const target = {
					snapshotId: id,
					projectId,
					organizationId: ORGANIZATION_ID,
				};

				expect(
					await rejectAbandonedInstructionSnapshot({
						...target,
						source: "inline_submit_compensation",
					}),
				).toEqual({ changed: true });

				// The operation is canceled in the same transaction as the
				// verdict, and its attempt moves past the one the row held, so
				// a write fenced on the earlier attempt can no longer land...
				const row = await getProposalOperation(target);
				expect(row).toMatchObject({
					status: "REJECTED",
					proposalStatus: "REJECTED",
					pullRequestState: "CANCELED",
					pullRequestAttempt: 4,
					pullRequestFailure: {
						phase: "validation",
						code: "VALIDATION_REJECTED",
						retryable: false,
						params: { reason: "abandoned" },
					},
				});
				// ...and a Refresh finds no unresolved operation to act on. The
				// readiness activity a waiting workflow would run next is not
				// exercised here. Its answer for a CANCELED row is pinned, on an
				// in-memory row, by "stops for a CANCELED row" in
				// packages/temporal/__tests__/instruction-proposal-pull-request-activities.test.ts.
				expect(await requestPullRequestRefresh(target)).toBeNull();

				// A second compensation, or the reaper after it, changes nothing.
				expect(
					await rejectAbandonedInstructionSnapshot({
						...target,
						source: "inline_submit_compensation",
					}),
				).toEqual({ changed: false });
			});
		});
	},
);
