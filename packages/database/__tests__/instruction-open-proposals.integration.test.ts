/**
 * `listOpenInstructionProposals` on a real Postgres (Fizzy #2738 spec §14.2):
 * the member's own PENDING proposals with the effective delta against each
 * one's own base, newest intent per path, version desc, at most the limit.
 * `instruction-open-proposals.test.ts` pins the pure selection; this pins
 * the loader's reads (own rows only, files per snapshot, branches, journal).
 * Self-skips without a reachable database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	db,
	listOpenInstructionProposals,
	type Prisma,
	type ProposalBranchNaming,
	type ProposalRepositoryIdentity,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `open-proposals-org-${RUN_ID}`;
const USER_ID = `open-proposals-user-${RUN_ID}`;
const OTHER_USER_ID = `open-proposals-other-${RUN_ID}`;
const REPO = `open-proposals-${RUN_ID}`;
const REPOSITORY_KEY = `github:example-org/${REPO}`;
const PR_URL = `https://github.com/example-org/${REPO}/pull/7`;
const H = (c: string) => c.repeat(64);

const naming: Pick<
	ProposalBranchNaming,
	"repositoryIdentity" | "repositoryKey"
> = {
	repositoryIdentity: (provider, url) => {
		const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(
			url,
		);
		return provider === "GITHUB" && m
			? {
					provider: "GITHUB",
					owner: m[1] as string,
					repo: m[2] as string,
				}
			: null;
	},
	repositoryKey: (r: ProposalRepositoryIdentity) =>
		r.provider === "GITHUB"
			? `github:${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`
			: JSON.stringify(r),
};

let projectId = "";
let integrationId = "";
let syncId = "";
let branchId = "";
let baseId = "";
let version = 0;
const ids: Record<string, string> = {};

function contextV2(over: Record<string, unknown> = {}): Prisma.InputJsonValue {
	return {
		v: 2,
		integrationId,
		syncId,
		syncGeneration: 1,
		provider: "GITHUB",
		targetRef: "main",
		rootPath: ".claude",
		baseCommitSha: "a".repeat(40),
		repository: { provider: "GITHUB", owner: "example-org", repo: REPO },
		author: { name: "Dev Example", email: "dev@example.com" },
		committer: { name: "Fabric", email: "fabric@example.com" },
		message: "Update instructions",
		committedAt: "2026-09-27T00:00:00Z",
		...over,
	};
}

async function seedSnapshot(
	files: Record<string, string>,
	extra: Partial<Prisma.ProjectInstructionSnapshotUncheckedCreateInput> = {},
): Promise<string> {
	version += 1;
	const userId = (extra.userId as string | undefined) ?? USER_ID;
	const row = await db.projectInstructionSnapshot.create({
		data: {
			projectId,
			organizationId: ORGANIZATION_ID,
			userId,
			version,
			source: "UPLOAD",
			status: "READY",
			settingsFrozen: {},
			publishOnReady: false,
			...extra,
		},
		select: { id: true },
	});
	let n = 0;
	for (const [path, sha256] of Object.entries(files)) {
		n += 1;
		await db.projectInstructionFile.create({
			data: {
				snapshotId: row.id,
				projectId,
				organizationId: ORGANIZATION_ID,
				userId,
				path,
				kind: "INSTRUCTIONS",
				storageKey: `open-proposals/${row.id}/${n}`,
				sha256,
				size: 9,
				mimeType: "text/markdown",
				isText: true,
			},
		});
	}
	return row.id;
}

function branchProposal(
	state: "QUEUED" | "OPEN",
	intentOrder: number,
	over: Partial<Prisma.ProjectInstructionSnapshotUncheckedCreateInput> = {},
): Partial<Prisma.ProjectInstructionSnapshotUncheckedCreateInput> {
	return {
		baseSnapshotId: baseId,
		proposalStatus: "PENDING",
		proposalDestination: "REPOSITORY",
		pullRequestOperationId: `op${RUN_ID.replace(/\D/g, "")}${version + 1}`,
		pullRequestState: state,
		pullRequestAttempt: 1,
		pullRequestContext: contextV2(),
		proposalBranchId: branchId,
		proposalBranchSequence: intentOrder,
		proposalAssignment: 1,
		proposalIntentOrder: BigInt(intentOrder),
		...over,
	};
}

const BASE_FILES = {
	"CLAUDE.md": H("1"),
	"rules/a.md": H("2"),
	"rules/old.md": H("3"),
};

describe.skipIf(!hasReachableDatabaseUrl())(
	"listOpenInstructionProposals (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			for (const id of [USER_ID, OTHER_USER_ID]) {
				await db.user.create({
					data: {
						id,
						name: "Dev Example",
						email: `${id}@example.com`,
						emailVerified: true,
						createdAt: now,
						updatedAt: now,
					},
				});
			}
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Open Proposals Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Open Proposals Integration",
					userId: USER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
					instructionSettings: { sourceOfTruth: "REPOSITORY" },
				},
			});
			projectId = project.id;
			const integration = await db.projectRepositoryIntegration.create({
				data: {
					projectId,
					provider: "GITHUB",
					authMethod: "OAUTH",
					repositoryUrl: `https://github.com/example-org/${REPO}`,
					repositoryOwner: "example-org",
					repositoryName: REPO,
				},
			});
			integrationId = integration.id;
			const sync = await db.projectInstructionRepositorySync.create({
				data: {
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: USER_ID,
					repositoryIntegrationId: integrationId,
					ref: "main",
					rootPath: ".claude",
				},
			});
			syncId = sync.id;
			const branch = await db.projectInstructionProposalBranch.create({
				data: {
					organizationId: ORGANIZATION_ID,
					projectId,
					userId: USER_ID,
					repositoryKey: REPOSITORY_KEY,
					number: 1,
					ref: "fabric/instructions/members/dev-example-abcd/1",
					state: "OPEN",
					pullRequestUrl: PR_URL,
					pullRequestExternalId: "7",
					destination: {
						integrationId,
						syncId,
						repositoryKey: REPOSITORY_KEY,
						provider: "GITHUB",
						repository: {
							provider: "GITHUB",
							owner: "example-org",
							repo: REPO,
						},
						targetRef: "main",
						rootPath: ".claude",
					},
				},
			});
			branchId = branch.id;

			baseId = await seedSnapshot(BASE_FILES);
			// On the branch and appended: rewrites rules/a.md, deletes rules/old.md.
			ids.appended = await seedSnapshot(
				{ "CLAUDE.md": H("1"), "rules/a.md": H("4") },
				branchProposal("OPEN", 1),
			);
			await db.projectInstructionProposalBranchOperation.create({
				data: {
					organizationId: ORGANIZATION_ID,
					branchId,
					snapshotId: ids.appended,
					kind: "APPEND",
					executionSeq: 1,
					ref: "fabric/instructions/members/dev-example-abcd/1",
					assignment: 1,
					attempt: 1,
					parentSha: "b".repeat(40),
					sha: "c".repeat(40),
					entries: [],
					pushIssuedAt: now,
					outcome: "acked",
				},
			});
			// Queued: rewrites CLAUDE.md.
			ids.queued = await seedSnapshot(
				{ ...BASE_FILES, "CLAUDE.md": H("5") },
				branchProposal("QUEUED", 2),
			);
			// A later intent on rules/a.md: the appended proposal no longer lists it.
			ids.later = await seedSnapshot(
				{ ...BASE_FILES, "rules/a.md": H("6") },
				branchProposal("QUEUED", 3),
			);
			// No base: never listed.
			ids.noBase = await seedSnapshot(
				{ "rules/b.md": H("7") },
				branchProposal("QUEUED", 4, { baseSnapshotId: null }),
			);
			// Frozen against another sync: stale, never listed.
			ids.stale = await seedSnapshot(
				{ ...BASE_FILES, "rules/c.md": H("8") },
				branchProposal("QUEUED", 5, {
					pullRequestContext: contextV2({ syncId: "another-sync" }),
				}),
			);
			// Another member's proposal: never returned to this member.
			ids.other = await seedSnapshot(
				{ ...BASE_FILES, "rules/d.md": H("9") },
				{
					userId: OTHER_USER_ID,
					baseSnapshotId: baseId,
					proposalStatus: "PENDING",
					proposalDestination: "FABRIC",
				},
			);
			// Reviewed in Fabric: its whole delta, no pull request.
			ids.fabric = await seedSnapshot(
				{ ...BASE_FILES, "rules/e.md": H("e") },
				{
					baseSnapshotId: baseId,
					proposalStatus: "PENDING",
					proposalDestination: "FABRIC",
				},
			);
		});

		afterAll(async () => {
			await db.projectInstructionSnapshot.deleteMany({
				where: { projectId },
			});
			await db.projectInstructionProposalBranch.deleteMany({
				where: { projectId },
			});
			await db.$transaction([
				db.$executeRawUnsafe("SET LOCAL app.audit_allow_delete = 'on'"),
				db.$executeRaw`DELETE FROM "audit_log" WHERE "organizationId" = ${ORGANIZATION_ID}`,
			]);
			await db.project.deleteMany({ where: { id: projectId } });
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({
				where: { id: { in: [USER_ID, OTHER_USER_ID] } },
			});
			await db.$disconnect();
		});

		const list = (over: { userId?: string; limit?: number } = {}) =>
			listOpenInstructionProposals({
				projectId,
				organizationId: ORGANIZATION_ID,
				userId: over.userId ?? USER_ID,
				naming,
				limit: over.limit,
			});

		it("returns the member's own open proposals, version desc, each with the paths it still carries", async () => {
			const rows = await list();
			expect(
				rows.map((r) => ({
					id: r.candidate.snapshotId,
					status: r.status,
					pullRequest: r.pullRequest,
					changes: r.changes,
					branch: r.branch?.id ?? null,
				})),
			).toEqual([
				{
					id: ids.fabric,
					status: "READY",
					pullRequest: null,
					changes: [
						{ path: "rules/e.md", op: "put", sha256: H("e") },
					],
					branch: null,
				},
				{
					id: ids.later,
					status: "READY",
					pullRequest: { state: "QUEUED", url: PR_URL },
					changes: [
						{ path: "rules/a.md", op: "put", sha256: H("6") },
					],
					branch: branchId,
				},
				{
					id: ids.queued,
					status: "READY",
					pullRequest: { state: "QUEUED", url: PR_URL },
					changes: [{ path: "CLAUDE.md", op: "put", sha256: H("5") }],
					branch: branchId,
				},
				{
					id: ids.appended,
					status: "READY",
					pullRequest: { state: "OPEN", url: PR_URL },
					// rules/a.md is superseded by the later intent; the delete
					// carries a sha256 that is present and exactly null.
					changes: [
						{ path: "rules/old.md", op: "delete", sha256: null },
					],
					branch: branchId,
				},
			]);
		});

		it("never returns another member's rows, a null-base row or a stale destination", async () => {
			const listed = (await list()).map((r) => r.candidate.snapshotId);
			expect(listed).not.toContain(ids.other);
			expect(listed).not.toContain(ids.noBase);
			expect(listed).not.toContain(ids.stale);
			expect(
				(await list({ userId: OTHER_USER_ID })).map(
					(r) => r.candidate.snapshotId,
				),
			).toEqual([ids.other]);
		});

		it("keeps the newest versions within the limit", async () => {
			expect(
				(await list({ limit: 2 })).map((r) => r.candidate.snapshotId),
			).toEqual([ids.fabric, ids.later]);
		});

		it("returns nothing for a project outside the organization", async () => {
			expect(
				await listOpenInstructionProposals({
					projectId,
					organizationId: `${ORGANIZATION_ID}-elsewhere`,
					userId: USER_ID,
					naming,
				}),
			).toEqual([]);
		});
	},
);
