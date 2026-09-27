/**
 * Proposal pull-request transitions on a real Postgres (Fizzy #2563 spec
 * §4.4): the row lock and attempt fence under two concurrent callers, the
 * JSON path guards the §4.4 table compiles to, the admission transaction,
 * the merge-sync receipts and the surfaces that read a proposal. #2563's own
 * claim, record writer, selection and merge-sync writers were retired with
 * its per-proposal path (Fizzy #2748). Self-skips without a reachable
 * database.
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
	rejectAbandonedInstructionSnapshot,
	updateInstructionRepositorySyncProposalSettings,
} from "../index";
import {
	findMergeTriggeredRun,
	getProposalOperation,
	getSyncRunReceiptByRunId,
	getSyncRunReceiptsByRunIds,
	PULL_REQUEST_REFRESH_COOLDOWN_SECONDS,
	requestPullRequestRefresh,
	transitionPullRequest,
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
			/**
			 * A fenced bump whose source list keeps the row matchable by
			 * state after the winner moves it (QUEUED or BLOCKED, to
			 * BLOCKED): only the attempt predicate can refuse the loser.
			 */
			const staleDestination = (
				id: string,
				expectedAttempt: number | null,
			) =>
				transitionPullRequest({
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					event: "branch_stale_destination",
					from: ["QUEUED", "BLOCKED"],
					expectedAttempt,
					to: "BLOCKED",
					bumpAttempt: true,
					data: {
						pullRequestFailure: failure(
							"CONFIGURATION_CHANGED",
							"admission",
							false,
						),
					},
				});
			const V2 = { pullRequestContext: { v: 2 } };

			it("lets exactly one of two concurrent writers holding one observation take the row", async () => {
				const id = await seed("QUEUED", V2);
				const results = await Promise.all([
					staleDestination(id, 3),
					staleDestination(id, 3),
				]);
				expect(results.filter((r) => r.ok)).toEqual([
					{ ok: true, attempt: 4 },
				]);
				expect(results.filter((r) => !r.ok)).toEqual([{ ok: false }]);
				expect(await stateOf(id)).toMatchObject({
					pullRequestState: "BLOCKED",
					pullRequestAttempt: 4,
				});
			});

			it("refuses a fenced event that names no attempt, and writes nothing", async () => {
				const queued = await seed("QUEUED", V2);
				const opening = await seed("OPENING");
				await expect(staleDestination(queued, null)).rejects.toThrow(
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
				expect(await stateOf(queued)).toMatchObject({
					pullRequestState: "QUEUED",
					pullRequestAttempt: 3,
				});
				expect(await stateOf(opening)).toMatchObject({
					pullRequestState: "OPENING",
					pullRequestAttempt: 3,
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
		});

		// A REJECTED snapshot whose operation was left QUEUED (its verdict's
		// cancel never ran). Readiness settles it with the verdict's own
		// transition, which needs the rejection to tell abandonment apart.
		describe("a REJECTED snapshot left QUEUED", () => {
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
			it("reads the rejection beside the operation, and readiness cancels it once", async () => {
				const id = await seed("QUEUED", {
					status: "REJECTED",
					proposalStatus: "REJECTED",
					rejection: [abandoned],
					pullRequestAttempt: 0,
					createdAt: new Date(Date.now() - 10 * 60 * 1000),
				});

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

			// Refresh admits only member branch (v2) rows: nothing acts on a
			// #2563 (v1) row any more (Fizzy #2748).
			const seedMemberBranch = (
				state: Parameters<typeof seed>[0],
				extra: Parameters<typeof seed>[1] = {},
			) => seed(state, { pullRequestContext: { v: 2 }, ...extra });

			it("never admits a Refresh of a #2563 row, whose context is v1 or absent, and changes nothing on it (Fizzy #2748)", async () => {
				const checked = new Date(Date.now() - 60 * 1000);
				const future = new Date(Date.now() + 6 * 60 * 60 * 1000);
				for (const context of [
					{ v: 1, branch: "fabric/instructions/r1" },
					undefined,
				]) {
					const id = await seed("BLOCKED", {
						...(context ? { pullRequestContext: context } : {}),
						pullRequestFailure: failure(
							"PROVIDER_TEMPORARY",
							"create",
							true,
						),
						pullRequestNextAttemptAt: future,
						pullRequestLastCheckedAt: checked,
					});
					expect(
						await requestPullRequestRefresh(target(id)),
					).toBeNull();
					const row =
						await db.projectInstructionSnapshot.findUniqueOrThrow({
							where: { id },
							select: {
								pullRequestLastCheckedAt: true,
								pullRequestNextAttemptAt: true,
								pullRequestRefreshAdmittedAt: true,
							},
						});
					expect(row).toEqual({
						pullRequestLastCheckedAt: checked,
						pullRequestNextAttemptAt: future,
						pullRequestRefreshAdmittedAt: null,
					});
				}
			});

			it("refreshes on the database clock: nulls lastCheckedAt and makes only a retryable BLOCKED row due", async () => {
				const future = new Date(Date.now() + 6 * 60 * 60 * 1000);
				const checked = new Date(Date.now() - 60 * 1000);
				const retryable = await seedMemberBranch("BLOCKED", {
					pullRequestFailure: failure(
						"PROVIDER_TEMPORARY",
						"create",
						true,
					),
					pullRequestNextAttemptAt: future,
					pullRequestLastCheckedAt: checked,
				});
				const refused = await seedMemberBranch("BLOCKED", {
					pullRequestFailure: failure(
						"PR_CREATION_REFUSED",
						"create",
						false,
					),
					pullRequestNextAttemptAt: future,
				});
				const open = await seedMemberBranch("OPEN", {
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
				const merged = await seedMemberBranch("MERGED", {
					proposalStatus: "MERGED",
				});
				expect(
					await requestPullRequestRefresh(target(merged)),
				).toBeNull();

				const queued = await seedMemberBranch("QUEUED");
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

				const validating = await seedMemberBranch("QUEUED", {
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
				const id = await seedMemberBranch("BLOCKED", {
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
				const id = await seedMemberBranch("BLOCKED", {
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
				const id = await seedMemberBranch("BLOCKED", {
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
