/**
 * The direct commit's snapshot writes on a real Postgres (Fizzy #2878 §10):
 * a `REPOSITORY_COMMIT` snapshot is created without claiming the published
 * pointer, settles exactly once under every writer (pushed, pull-request
 * fallback, plain outcome), and the writers that settle it leave the rows the
 * rest of the system reads: a REPOSITORY snapshot stamped with the commit, or
 * a QUEUED member-branch proposal with an intent order. Self-skips without a
 * reachable database.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	admitDirectCommitAsProposal,
	createDerivedInstructionSnapshot,
	db,
	failStaleDirectCommit,
	getDirectCommitSnapshot,
	getInstructionCommitOverlay,
	getInstructionSnapshot,
	hasPendingDirectCommit,
	listInstructionSnapshots,
	listStaleDirectCommits,
	recordDirectCommitFailureBeforeReady,
	recordDirectCommitOutcome,
	recordDirectCommitPushed,
	recordRevertCommitted,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `direct-commit-org-${RUN_ID}`;
const USER_ID = `direct-commit-user-${RUN_ID}`;
const SHA = "b".repeat(40);
const LIMITS = { maxFiles: 5_000, maxTotalBytes: 52_428_800 };
const CONTEXT = {
	v: 1,
	integrationId: "int_example",
	syncId: "sync_example",
	syncGeneration: 1,
	provider: "GITHUB",
	targetRef: "main",
	rootPath: "",
	baseCommitSha: "a".repeat(40),
	repository: { provider: "GITHUB", owner: "example-org", repo: "example" },
	author: { name: "Pat Example", email: "noreply@example.com" },
	committer: { name: "Fabric", email: "noreply@example.com" },
	message: "Tighten the rules",
	committedAt: "2026-10-02T10:00:00Z",
};
let projectId = "";
let version = 0;
let baseId = "";
const basePrefix = () =>
	`projects/${projectId}/instructions/snapshots/${baseId}/`;

async function derive(
	over: {
		proposal?: boolean;
		publishOnReady?: boolean;
		userId?: string;
		changes?: Parameters<
			typeof createDerivedInstructionSnapshot
		>[0]["changes"];
		syncGeneration?: number;
	} = {},
) {
	const syncGeneration = over.syncGeneration ?? CONTEXT.syncGeneration;
	return createDerivedInstructionSnapshot({
		projectId,
		organizationId: ORGANIZATION_ID,
		userId: over.userId ?? USER_ID,
		baseSnapshotId: baseId,
		publishOnReady: over.publishOnReady ?? false,
		proposal: over.proposal ?? false,
		changes: over.changes ?? [{ op: "delete", path: "REMOVE.md" }],
		limits: LIMITS,
		baseKeyPrefix: basePrefix(),
		note: null,
		commit: {
			context: { ...CONTEXT, syncGeneration },
			syncId: CONTEXT.syncId,
			syncGeneration,
		},
	});
}

/** A change set whose digest is its own: one new file whose path carries `n`. */
function distinctChange(n: number) {
	return [
		{
			op: "put" as const,
			path: `rules/extra-${n}.md`,
			kind: "INSTRUCTIONS" as const,
			storageKey: `projects/${projectId}/instructions/staging/pending/${n}`,
			sha256: createHash("sha256").update(`extra ${n}`).digest("hex"),
			size: 7,
			mimeType: "text/markdown",
			isText: true,
		},
	];
}

async function seedReadyCommit(): Promise<string> {
	const created = await derive();
	if (!created.ok) {
		throw new Error(`the derive was refused: ${created.reason}`);
	}
	await db.projectInstructionSnapshot.update({
		where: { id: created.id },
		data: { status: "READY", readyAt: new Date() },
	});
	return created.id;
}

const pushedInput = (snapshotId: string) => ({
	snapshotId,
	projectId,
	organizationId: ORGANIZATION_ID,
	actorUserId: USER_ID,
	ref: "main",
	sha: SHA,
	fileCount: 1,
});

describe.skipIf(!hasReachableDatabaseUrl())(
	"direct commit snapshot writes (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: USER_ID,
					name: "Direct Commit Author",
					email: `${USER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Direct Commit Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Direct Commit Integration",
					userId: USER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			projectId = project.id;
			version += 1;
			baseId = `direct-commit-base-${RUN_ID}`;
			await db.projectInstructionSnapshot.create({
				data: {
					id: baseId,
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: USER_ID,
					version,
					source: "REPOSITORY",
					sourceCommitSha: "a".repeat(40),
					sourceRef: "main",
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
					storageKey: `${basePrefix()}base-file-${index}`,
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
		});

		afterEach(async () => {
			await db.projectInstructionSnapshot.deleteMany({
				where: { projectId, id: { not: baseId } },
			});
		});

		afterAll(async () => {
			if (projectId) {
				await db.project.update({
					where: { id: projectId },
					data: { publishedInstructionSnapshotId: null },
				});
				await db.projectInstructionSnapshot.deleteMany({
					where: { projectId },
				});
				await db.project.deleteMany({ where: { id: projectId } });
			}
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({ where: { id: USER_ID } });
			await db.$disconnect();
		});

		it("creates a REPOSITORY_COMMIT snapshot that carries its frozen context and claims nothing", async () => {
			const created = await derive();

			expect(created).toMatchObject({ ok: true });
			const row = await getDirectCommitSnapshot({
				snapshotId: (created as { id: string }).id,
				organizationId: ORGANIZATION_ID,
			});
			expect(row).toMatchObject({
				proposalDestination: "REPOSITORY_COMMIT",
				proposalStatus: null,
				commitContext: CONTEXT,
				commitOutcome: null,
				source: "UPLOAD",
			});
			const project = await db.project.findUniqueOrThrow({
				where: { id: projectId },
				select: { publishedInstructionSnapshotId: true },
			});
			expect(project.publishedInstructionSnapshotId).toBe(baseId);
		});

		describe("pending commits are replayed and capped like proposals", () => {
			it("returns a retried commit as the pending one it duplicates, writing nothing", async () => {
				const first = await derive();
				const again = await derive();

				expect(first).toMatchObject({ ok: true });
				expect(again).toMatchObject({
					ok: false,
					reason: "duplicate_proposal",
					auditWritten: false,
					existing: { id: (first as { id: string }).id },
				});
				const rows = await db.projectInstructionSnapshot.count({
					where: {
						projectId,
						proposalDestination: "REPOSITORY_COMMIT",
					},
				});
				expect(rows).toBe(1);
			});

			it("does not replay a commit that has an outcome, one the scan refused, one for another destination or another member", async () => {
				const first = (await derive()) as { id: string };
				await db.projectInstructionSnapshot.update({
					where: { id: first.id },
					data: { status: "READY", readyAt: new Date() },
				});
				await recordDirectCommitOutcome({
					snapshotId: first.id,
					organizationId: ORGANIZATION_ID,
					outcome: { outcome: "branch-moved" },
				});
				const afterOutcome = await derive();
				expect(afterOutcome).toMatchObject({ ok: true });

				await db.projectInstructionSnapshot.update({
					where: { id: (afterOutcome as { id: string }).id },
					data: { status: "REJECTED" },
				});
				const afterRejection = await derive();
				expect(afterRejection).toMatchObject({ ok: true });

				const otherGeneration = await derive({ syncGeneration: 2 });
				expect(otherGeneration).toMatchObject({ ok: true });
			});

			it("refuses the sixth pending commit of a member and frees a slot when one ends", async () => {
				const created: string[] = [];
				for (let n = 0; n < 5; n++) {
					const result = await derive({ changes: distinctChange(n) });
					expect(result).toMatchObject({ ok: true });
					created.push((result as { id: string }).id);
				}

				const sixth = await derive({ changes: distinctChange(5) });
				expect(sixth).toEqual({
					ok: false,
					reason: "commit_proposer_limit",
				});

				await db.projectInstructionSnapshot.update({
					where: { id: created[0] },
					data: { status: "READY", readyAt: new Date() },
				});
				await recordDirectCommitOutcome({
					snapshotId: created[0] as string,
					organizationId: ORGANIZATION_ID,
					outcome: { outcome: "unchanged", sha: SHA },
				});
				expect(
					await derive({ changes: distinctChange(5) }),
				).toMatchObject({ ok: true });
			});

			it("refuses the twenty-sixth pending commit of a project, whoever asks", async () => {
				const members = [0, 1, 2, 3, 4, 5].map(
					(n) => `${USER_ID}-member-${n}`,
				);
				const now = new Date();
				for (const id of members) {
					await db.user.create({
						data: {
							id,
							name: "Direct Commit Member",
							email: `${id}@example.com`,
							emailVerified: true,
							createdAt: now,
							updatedAt: now,
						},
					});
				}
				try {
					let n = 0;
					for (const member of members.slice(0, 5)) {
						for (let k = 0; k < 5; k++) {
							const result = await derive({
								userId: member,
								changes: distinctChange(n++),
							});
							expect(result).toMatchObject({ ok: true });
						}
					}

					const overflow = await derive({
						userId: members[5],
						changes: distinctChange(n),
					});

					expect(overflow).toEqual({
						ok: false,
						reason: "commit_project_limit",
					});
				} finally {
					await db.projectInstructionSnapshot.deleteMany({
						where: { projectId, id: { not: baseId } },
					});
					await db.user.deleteMany({
						where: { id: { in: members } },
					});
				}
			});

			describe("a pending commit that has outlived its workflow", () => {
				const ageAll = (hours: number) =>
					db.projectInstructionSnapshot.updateMany({
						where: {
							projectId,
							proposalDestination: "REPOSITORY_COMMIT",
						},
						data: {
							createdAt: new Date(
								Date.now() - hours * 60 * 60_000,
							),
						},
					});

				it("stops counting against the member's cap after a day, so five dead ones do not lock the member out for good", async () => {
					for (let n = 0; n < 5; n++) {
						const created = await derive({
							changes: distinctChange(n),
						});
						expect(created).toMatchObject({ ok: true });
					}
					await ageAll(25);

					const sixth = await derive({ changes: distinctChange(5) });

					expect(sixth).toMatchObject({ ok: true });
				});

				it("still counts one that is a few hours old: its workflow may be alive", async () => {
					for (let n = 0; n < 5; n++) {
						await derive({ changes: distinctChange(n) });
					}
					await ageAll(23);

					const sixth = await derive({ changes: distinctChange(5) });

					expect(sixth).toEqual({
						ok: false,
						reason: "commit_proposer_limit",
					});
				});

				it("stops counting against the project's cap after a day too", async () => {
					const members = [0, 1, 2, 3, 4, 5].map(
						(n) => `${USER_ID}-stale-${n}`,
					);
					const now = new Date();
					for (const id of members) {
						await db.user.create({
							data: {
								id,
								name: "Direct Commit Member",
								email: `${id}@example.com`,
								emailVerified: true,
								createdAt: now,
								updatedAt: now,
							},
						});
					}
					try {
						let n = 0;
						for (const member of members.slice(0, 5)) {
							for (let k = 0; k < 5; k++) {
								await derive({
									userId: member,
									changes: distinctChange(n++),
								});
							}
						}
						expect(
							await derive({
								userId: members[5],
								changes: distinctChange(n),
							}),
						).toEqual({
							ok: false,
							reason: "commit_project_limit",
						});
						await ageAll(25);

						const again = await derive({
							userId: members[5],
							changes: distinctChange(n),
						});

						expect(again).toMatchObject({ ok: true });
					} finally {
						await db.projectInstructionSnapshot.deleteMany({
							where: { projectId, id: { not: baseId } },
						});
						await db.user.deleteMany({
							where: { id: { in: members } },
						});
					}
				});

				it("is not handed back to a retried request after two hours: the request it was made for is long gone", async () => {
					const first = (await derive()) as { id: string };
					await ageAll(3);

					const again = await derive();

					expect(again).toMatchObject({ ok: true });
					expect((again as { id: string }).id).not.toBe(first.id);
				});

				it("is still handed back to a retried request within the hour", async () => {
					const first = (await derive()) as { id: string };
					await ageAll(1);

					const again = await derive();

					expect(again).toMatchObject({
						ok: false,
						reason: "duplicate_proposal",
						existing: { id: first.id },
					});
				});
			});

			it("does not count a proposal against the commit cap, nor a commit against the proposal cap", async () => {
				for (let n = 0; n < 5; n++) {
					await derive({ changes: distinctChange(n) });
				}

				const commitRows = await db.projectInstructionSnapshot.count({
					where: {
						projectId,
						proposalDestination: "REPOSITORY_COMMIT",
					},
				});
				const proposalRows = await db.projectInstructionSnapshot.count({
					where: { projectId, proposalStatus: "PENDING" },
				});

				expect(commitRows).toBe(5);
				expect(proposalRows).toBe(0);
			});
		});

		describe("listStaleDirectCommits and failStaleDirectCommit (the reaper's phase 0c)", () => {
			const DAY_MS = 24 * 60 * 60_000;
			const cutoff = () => new Date(Date.now() - DAY_MS);
			const age = (id: string, hours: number) =>
				db.projectInstructionSnapshot.update({
					where: { id },
					data: {
						createdAt: new Date(Date.now() - hours * 60 * 60_000),
					},
				});
			const list = async () =>
				(await listStaleDirectCommits(cutoff(), 100, 0)).candidates
					.filter((c) => c.projectId === projectId)
					.map((c) => c.id);

			it("lists only READY direct commits with no outcome that are older than the cutoff, oldest first, with their own tenant", async () => {
				const old = await seedReadyCommit();
				await age(old, 30);
				const older = (
					(await derive({ changes: distinctChange(1) })) as {
						id: string;
					}
				).id;
				await db.projectInstructionSnapshot.update({
					where: { id: older },
					data: { status: "READY", readyAt: new Date() },
				});
				await age(older, 50);
				const recent = (
					(await derive({ changes: distinctChange(2) })) as {
						id: string;
					}
				).id;
				await db.projectInstructionSnapshot.update({
					where: { id: recent },
					data: { status: "READY", readyAt: new Date() },
				});
				const settled = (
					(await derive({ changes: distinctChange(3) })) as {
						id: string;
					}
				).id;
				await db.projectInstructionSnapshot.update({
					where: { id: settled },
					data: { status: "READY", readyAt: new Date() },
				});
				await recordDirectCommitOutcome({
					snapshotId: settled,
					organizationId: ORGANIZATION_ID,
					outcome: { outcome: "branch-moved" },
				});
				await age(settled, 60);
				const stillValidating = (
					(await derive({ changes: distinctChange(4) })) as {
						id: string;
					}
				).id;
				await age(stillValidating, 70);

				const listed = await listStaleDirectCommits(cutoff(), 100, 0);

				expect(await list()).toEqual([older, old]);
				expect(
					listed.candidates.find((c) => c.id === old),
				).toMatchObject({
					projectId,
					organizationId: ORGANIZATION_ID,
				});
				expect(listed.total).toBeGreaterThanOrEqual(2);
			});

			it("pages in one order, with the size of the population on every page", async () => {
				const ids: string[] = [];
				for (let n = 0; n < 3; n++) {
					const id = (
						(await derive({ changes: distinctChange(10 + n) })) as {
							id: string;
						}
					).id;
					await db.projectInstructionSnapshot.update({
						where: { id },
						data: { status: "READY", readyAt: new Date() },
					});
					await age(id, 100 - n);
					ids.push(id);
				}

				const first = await listStaleDirectCommits(cutoff(), 2, 0);
				const second = await listStaleDirectCommits(cutoff(), 2, 2);

				const mine = (rows: { id: string }[]) =>
					rows.map((r) => r.id).filter((id) => ids.includes(id));
				expect([
					...mine(first.candidates),
					...mine(second.candidates),
				]).toEqual(ids);
				expect(first.total).toBe(second.total);
			});

			it("closes a stale commit as failed STALE, retryable, once", async () => {
				const id = await seedReadyCommit();
				await age(id, 30);
				const input = {
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
					cutoff: cutoff(),
				};

				expect(await failStaleDirectCommit(input)).toBe(true);
				expect(await failStaleDirectCommit(input)).toBe(false);

				const row = await getDirectCommitSnapshot({
					snapshotId: id,
					organizationId: ORGANIZATION_ID,
				});
				expect(row?.commitOutcome).toEqual({
					outcome: "failed",
					code: "STALE",
					retryable: true,
				});
				expect(await list()).not.toContain(id);
			});

			it("leaves alone a commit that settled since it was listed, one younger than the cutoff, one not READY and another tenant's", async () => {
				const settled = await seedReadyCommit();
				await age(settled, 30);
				await recordDirectCommitOutcome({
					snapshotId: settled,
					organizationId: ORGANIZATION_ID,
					outcome: { outcome: "unchanged", sha: SHA },
				});
				const young = (
					(await derive({ changes: distinctChange(20) })) as {
						id: string;
					}
				).id;
				await db.projectInstructionSnapshot.update({
					where: { id: young },
					data: { status: "READY", readyAt: new Date() },
				});
				const validating = (
					(await derive({ changes: distinctChange(21) })) as {
						id: string;
					}
				).id;
				await age(validating, 30);
				const foreign = await seedReadyCommit();
				await age(foreign, 30);

				const attempts = [
					await failStaleDirectCommit({
						snapshotId: settled,
						organizationId: ORGANIZATION_ID,
						cutoff: cutoff(),
					}),
					await failStaleDirectCommit({
						snapshotId: young,
						organizationId: ORGANIZATION_ID,
						cutoff: cutoff(),
					}),
					await failStaleDirectCommit({
						snapshotId: validating,
						organizationId: ORGANIZATION_ID,
						cutoff: cutoff(),
					}),
					await failStaleDirectCommit({
						snapshotId: foreign,
						organizationId: `${ORGANIZATION_ID}-other`,
						cutoff: cutoff(),
					}),
				];

				expect(attempts).toEqual([false, false, false, false]);
				const unchanged = await getDirectCommitSnapshot({
					snapshotId: settled,
					organizationId: ORGANIZATION_ID,
				});
				expect(unchanged?.commitOutcome).toMatchObject({
					outcome: "unchanged",
				});
			});
		});

		describe("hasPendingDirectCommit", () => {
			it("is true while a commit is on its way and false once it has an outcome, was refused, or is stale", async () => {
				expect(
					await hasPendingDirectCommit({
						projectId,
						organizationId: ORGANIZATION_ID,
					}),
				).toBe(false);

				const created = (await derive()) as { id: string };
				const pending = () =>
					hasPendingDirectCommit({
						projectId,
						organizationId: ORGANIZATION_ID,
					});
				expect(await pending()).toBe(true);
				expect(
					await hasPendingDirectCommit({
						projectId,
						organizationId: `${ORGANIZATION_ID}-other`,
					}),
				).toBe(false);

				await db.projectInstructionSnapshot.update({
					where: { id: created.id },
					data: { status: "REJECTED" },
				});
				expect(await pending()).toBe(false);

				await db.projectInstructionSnapshot.update({
					where: { id: created.id },
					data: { status: "VALIDATING" },
				});
				expect(await pending()).toBe(true);

				await db.projectInstructionSnapshot.update({
					where: { id: created.id },
					data: { createdAt: new Date(Date.now() - 3 * 60 * 60_000) },
				});
				expect(await pending()).toBe(false);

				await db.projectInstructionSnapshot.update({
					where: { id: created.id },
					data: { createdAt: new Date(), status: "READY" },
				});
				await recordDirectCommitOutcome({
					snapshotId: created.id,
					organizationId: ORGANIZATION_ID,
					outcome: { outcome: "branch-moved" },
				});
				expect(await pending()).toBe(false);
			});
		});

		it.each([
			["a proposal", { proposal: true }],
			["a publish-on-ready save", { publishOnReady: true }],
		])("refuses a commit combined with %s", async (_label, over) => {
			await expect(derive(over)).rejects.toThrow(/commit/i);
		});

		it("records the commit as the outcome and audits it, once, without turning the snapshot into a copy of it", async () => {
			const id = await seedReadyCommit();

			expect(await recordDirectCommitPushed(pushedInput(id))).toBe(true);
			expect(await recordDirectCommitPushed(pushedInput(id))).toBe(false);

			const row = await db.projectInstructionSnapshot.findUniqueOrThrow({
				where: { id },
				select: {
					source: true,
					repositoryIntegrationId: true,
					sourceRef: true,
					sourceCommitSha: true,
					commitOutcome: true,
					publishedAt: true,
				},
			});
			expect(row).toEqual({
				source: "UPLOAD",
				repositoryIntegrationId: null,
				sourceRef: null,
				sourceCommitSha: null,
				commitOutcome: { outcome: "committed", sha: SHA, ref: "main" },
				publishedAt: null,
			});
			const project = await db.project.findUniqueOrThrow({
				where: { id: projectId },
				select: { publishedInstructionSnapshotId: true },
			});
			expect(project.publishedInstructionSnapshotId).toBe(baseId);
			const audits = await db.auditLog.findMany({
				where: {
					organizationId: ORGANIZATION_ID,
					action: "project.instructions.committed",
					resourceId: id,
				},
				select: { metadata: true, resourceId: true, userId: true },
			});
			expect(audits).toHaveLength(1);
			expect(audits[0]).toMatchObject({
				resourceId: id,
				userId: USER_ID,
				metadata: { sha: SHA, ref: "main", fileCount: 1 },
			});
		});

		it("refuses to stamp a snapshot that is not READY, writing no audit row", async () => {
			const created = await derive();
			const id = (created as { id: string }).id;

			expect(await recordDirectCommitPushed(pushedInput(id))).toBe(false);

			const audits = await db.auditLog.count({
				where: {
					organizationId: ORGANIZATION_ID,
					action: "project.instructions.committed",
					resourceId: id,
				},
			});
			expect(audits).toBe(0);
		});

		it("admits the same rows as a QUEUED repository proposal with an intent order, once", async () => {
			const id = await seedReadyCommit();
			const input = {
				snapshotId: id,
				projectId,
				organizationId: ORGANIZATION_ID,
				actorUserId: USER_ID,
				operationId: `commit-${id}`,
				context: { ...CONTEXT, v: 2 },
				reason: "protected" as const,
			};

			expect(await admitDirectCommitAsProposal(input)).toBe(true);
			expect(await admitDirectCommitAsProposal(input)).toBe(false);

			const row = await db.projectInstructionSnapshot.findUniqueOrThrow({
				where: { id },
				select: {
					proposalDestination: true,
					proposalStatus: true,
					pullRequestState: true,
					pullRequestOperationId: true,
					pullRequestContext: true,
					proposalIntentOrder: true,
					commitOutcome: true,
					status: true,
				},
			});
			expect(row).toMatchObject({
				proposalDestination: "REPOSITORY",
				proposalStatus: "PENDING",
				pullRequestState: "QUEUED",
				pullRequestOperationId: `commit-${id}`,
				pullRequestContext: { ...CONTEXT, v: 2 },
				commitOutcome: {
					outcome: "pull-request",
					operationId: `commit-${id}`,
					reason: "protected",
				},
				status: "READY",
			});
			expect(row.proposalIntentOrder).not.toBeNull();
			expect(
				await db.auditLog.count({
					where: {
						organizationId: ORGANIZATION_ID,
						action: "project.instructions.commit_fell_back_to_pull_request",
						resourceId: id,
					},
				}),
			).toBe(1);
		});

		it("settles with one outcome only: the first writer wins and nothing overwrites it", async () => {
			const id = await seedReadyCommit();
			const base = { snapshotId: id, organizationId: ORGANIZATION_ID };

			expect(
				await recordDirectCommitOutcome({
					...base,
					outcome: { outcome: "branch-moved" },
				}),
			).toBe(true);
			expect(
				await recordDirectCommitOutcome({
					...base,
					outcome: { outcome: "unchanged", sha: SHA },
				}),
			).toBe(false);
			expect(await recordDirectCommitPushed(pushedInput(id))).toBe(false);
			expect(
				await admitDirectCommitAsProposal({
					...base,
					projectId,
					actorUserId: USER_ID,
					operationId: "op_late",
					context: { ...CONTEXT, v: 2 },
					reason: "busy",
				}),
			).toBe(false);

			const row = await db.projectInstructionSnapshot.findUniqueOrThrow({
				where: { id },
				select: {
					commitOutcome: true,
					source: true,
					proposalDestination: true,
				},
			});
			expect(row).toEqual({
				commitOutcome: { outcome: "branch-moved" },
				source: "UPLOAD",
				proposalDestination: "REPOSITORY_COMMIT",
			});
		});

		it("records a failure against a snapshot that never reached READY, and only that one", async () => {
			const created = await derive();
			const id = (created as { id: string }).id;
			const base = { snapshotId: id, organizationId: ORGANIZATION_ID };
			const outcome = {
				outcome: "failed",
				code: "VALIDATION_TIMEOUT",
				retryable: false,
			};

			expect(await recordDirectCommitOutcome({ ...base, outcome })).toBe(
				false,
			);
			expect(
				await recordDirectCommitFailureBeforeReady({
					...base,
					outcome,
				}),
			).toBe(true);
			expect(
				await recordDirectCommitFailureBeforeReady({
					...base,
					outcome,
				}),
			).toBe(false);

			const ready = await seedReadyCommit();
			expect(
				await recordDirectCommitFailureBeforeReady({
					snapshotId: ready,
					organizationId: ORGANIZATION_ID,
					outcome,
				}),
			).toBe(false);
		});

		it("overlays a page of commits with the version of Fabric's copy and the runs the scan refused", async () => {
			const published = "1".repeat(40);
			const refused = "2".repeat(40);
			const unknown = "3".repeat(40);
			const pending = "4".repeat(40);
			const copy = async (sha: string, status: "READY" | "REJECTED") => {
				version += 1;
				return db.projectInstructionSnapshot.create({
					data: {
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: USER_ID,
						version,
						source: "REPOSITORY",
						sourceCommitSha: sha,
						status,
						settingsFrozen: {},
						publishOnReady: false,
					},
					select: { version: true },
				});
			};
			const first = await copy(published, "READY");
			const second = await copy(published, "READY");
			await copy(pending, "REJECTED");
			await db.projectInstructionRepositorySyncRun.createMany({
				data: [
					{
						id: `overlay-run-1-${RUN_ID}`,
						syncId: "sync_example",
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: USER_ID,
						generation: 1,
						trigger: "MANUAL",
						startedAt: new Date(),
						finishedAt: new Date(),
						status: "FAILED",
						error: "TREE_REFUSED",
						commitSha: refused,
					},
					{
						id: `overlay-run-2-${RUN_ID}`,
						syncId: "sync_example",
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: USER_ID,
						generation: 1,
						trigger: "MANUAL",
						startedAt: new Date(),
						finishedAt: new Date(),
						status: "FAILED",
						error: "CLONE_FAILED",
						commitSha: unknown,
					},
				],
			});

			try {
				const overlay = await getInstructionCommitOverlay({
					projectId,
					organizationId: ORGANIZATION_ID,
					shas: [published, refused, unknown, pending],
				});

				expect(overlay.published.get(published)).toBe(
					Math.max(first.version, second.version),
				);
				expect([...overlay.published.keys()]).toEqual([published]);
				expect([...overlay.refused]).toEqual([refused]);
				expect(
					await getInstructionCommitOverlay({
						projectId,
						organizationId: `${ORGANIZATION_ID}-other`,
						shas: [published, refused],
					}),
				).toEqual({ published: new Map(), refused: new Set() });
				expect(
					await getInstructionCommitOverlay({
						projectId,
						organizationId: ORGANIZATION_ID,
						shas: [],
					}),
				).toEqual({ published: new Map(), refused: new Set() });
			} finally {
				await db.projectInstructionRepositorySyncRun.deleteMany({
					where: { projectId },
				});
			}
		});

		it("keeps a direct commit's own snapshot hidden from readers after the push: the version they see is the sync's copy of the real tree", async () => {
			const id = await seedReadyCommit();
			const reader = {
				viewerUserId: `${USER_ID}-reader`,
				canReviewProposals: false,
			};
			const author = { viewerUserId: USER_ID, canReviewProposals: false };
			const reviewer = {
				viewerUserId: `${USER_ID}-rev`,
				canReviewProposals: true,
			};

			expect(
				await getInstructionSnapshot(
					id,
					projectId,
					ORGANIZATION_ID,
					reader,
				),
			).toBeNull();
			expect(
				await getInstructionSnapshot(
					id,
					projectId,
					ORGANIZATION_ID,
					author,
				),
			).not.toBeNull();
			expect(
				await getInstructionSnapshot(
					id,
					projectId,
					ORGANIZATION_ID,
					reviewer,
				),
			).not.toBeNull();
			expect(
				(
					await listInstructionSnapshots(
						projectId,
						ORGANIZATION_ID,
						reader,
					)
				).map((s) => s.id),
			).not.toContain(id);

			await recordDirectCommitPushed(pushedInput(id));

			expect(
				await getInstructionSnapshot(
					id,
					projectId,
					ORGANIZATION_ID,
					reader,
				),
			).toBeNull();
			expect(
				(
					await listInstructionSnapshots(
						projectId,
						ORGANIZATION_ID,
						reader,
					)
				).map((s) => s.id),
			).not.toContain(id);
			expect(
				await getInstructionSnapshot(
					id,
					projectId,
					ORGANIZATION_ID,
					author,
				),
			).not.toBeNull();
		});

		it("keeps showing readers an ordinary upload version and a synced copy beside a hidden direct commit", async () => {
			const hiddenId = await seedReadyCommit();
			const upload = await db.projectInstructionSnapshot.create({
				data: {
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: USER_ID,
					version: ++version + 100,
					source: "UPLOAD",
					status: "READY",
					settingsFrozen: {},
					readyAt: new Date(),
				},
			});
			const reader = {
				viewerUserId: `${USER_ID}-reader`,
				canReviewProposals: false,
			};

			const listed = (
				await listInstructionSnapshots(
					projectId,
					ORGANIZATION_ID,
					reader,
				)
			).map((s) => s.id);

			expect(listed).toContain(upload.id);
			expect(listed).toContain(baseId);
			expect(listed).not.toContain(hiddenId);
		});

		it("writes a revert's audit row transactionally, with its outcome, and only once per commit", async () => {
			const revertedSha = "c".repeat(40);
			const input = {
				projectId,
				organizationId: ORGANIZATION_ID,
				actorUserId: USER_ID,
				sha: revertedSha,
				ref: "main",
				fileCount: 3,
				revertOf: SHA,
			};

			await recordRevertCommitted(input);
			await recordRevertCommitted(input);

			const audits = await db.auditLog.findMany({
				where: {
					organizationId: ORGANIZATION_ID,
					action: "project.instructions.committed",
					resourceId: revertedSha,
				},
				select: {
					outcome: true,
					resourceType: true,
					metadata: true,
					userId: true,
				},
			});
			expect(audits).toHaveLength(1);
			expect(audits[0]).toMatchObject({
				outcome: "success",
				resourceType: "project_instruction_commit",
				userId: USER_ID,
				metadata: {
					sha: revertedSha,
					ref: "main",
					fileCount: 3,
					revertOf: SHA,
				},
			});
		});

		it("never reads or settles another organization's snapshot", async () => {
			const id = await seedReadyCommit();
			const stranger = {
				snapshotId: id,
				organizationId: `${ORGANIZATION_ID}-other`,
			};

			expect(await getDirectCommitSnapshot(stranger)).toBeNull();
			expect(
				await recordDirectCommitOutcome({
					...stranger,
					outcome: { outcome: "branch-moved" },
				}),
			).toBe(false);
		});
	},
);
