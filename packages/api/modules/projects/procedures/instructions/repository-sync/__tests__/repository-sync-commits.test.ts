/**
 * `repositorySync.listCommits`, `compareCommits` and `readCommitFile` — the
 * commit-level reads of a repository-backed Coding Instructions project
 * (Fizzy #2878 §10): History, the commit diff and one file at a commit.
 *
 * Each call runs the procedure's REAL middleware chain (visibility, then the
 * real `requireProjectPermission`) before the handler. The database, the
 * credential resolver and the `@repo/connectors` reads are mocked; the source
 * loader (`commit-source.ts`), the ignore rules, the credential-name rules, the
 * secret scanner and the path rules are real, so the refusals and withholdings
 * pinned here are the ones that ship. Every identifier is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	getProjectRepoIntegration: vi.fn(),
	resolveFreshRepoTokenForRow: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	getInstructionRepositorySync: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	getInstructionCommitOverlay: vi.fn(),
	listRepositoryCommits: vi.fn(),
	compareRepositoryRefs: vi.fn(),
	isCommitOnBranch: vi.fn(),
	readRepositoryFileAtCommit: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {},
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(),
	hasProjectAccess: m.hasProjectAccess,
	grantProjectAccess: vi.fn(),
	getProjectRepoIntegration: m.getProjectRepoIntegration,
	getProjectInstructionSettings: m.getProjectInstructionSettings,
	getInstructionRepositorySync: m.getInstructionRepositorySync,
	getPublishedInstructionSnapshot: m.getPublishedInstructionSnapshot,
	getInstructionCommitOverlay: m.getInstructionCommitOverlay,
}));
vi.mock("@repo/connectors", () => ({
	listRepositoryCommits: m.listRepositoryCommits,
	compareRepositoryRefs: m.compareRepositoryRefs,
	isCommitOnBranch: m.isCommitOnBranch,
	readRepositoryFileAtCommit: m.readRepositoryFileAtCommit,
}));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: m.resolveFreshRepoTokenForRow,
}));
vi.mock("../../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));
vi.mock("../../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.resolveEffectiveProjectPermissions,
}));
vi.mock("../../../../../../orpc/procedures", async () => {
	const { requireProjectPermission } = await vi.importActual<
		typeof import("../../../../../../orpc/middleware/require-permission")
	>("../../../../../../orpc/middleware/require-permission");
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	function builder(chain: unknown[], schema?: unknown) {
		const b: Record<string, unknown> = {};
		b.use = (middleware: unknown) =>
			builder([...chain, middleware], schema);
		b.route = () => b;
		b.input = (next: unknown) => builder(chain, next);
		b.handler = (fn: unknown) => ({
			handler: fn,
			middlewares: chain,
			inputSchema: schema,
		});
		return b;
	}
	return {
		tenantProtectedProcedure: builder([]),
		requireProjectPermission,
		Permissions,
	};
});

import { resetCommitSourceCaches } from "../commit-source";
import { compareInstructionRepositoryCommitsProcedure } from "../compare-commits";
import {
	listInstructionRepositoryCommitsProcedure,
	resetCommitHistoryCache,
} from "../list-commits";
import { readInstructionRepositoryCommitFileProcedure } from "../read-commit-file";

type Ctx = {
	user: { id: string; name: string; email: string };
	session: { id: string; activeOrganizationId: string | null };
};
type Middleware = (
	options: {
		context: Ctx;
		next: (options?: {
			context?: object;
		}) => Promise<{ output: unknown; context: object }>;
	},
	input: unknown,
) => Promise<{ output: unknown }>;
type Built = {
	handler: (args: { input: unknown; context: Ctx }) => Promise<unknown>;
	middlewares: Middleware[];
	inputSchema: {
		safeParse(v: unknown): { success: boolean; data?: unknown };
	};
};

const ctx: Ctx = {
	user: { id: "user-1", name: "Example Member", email: "dev@example.com" },
	session: { id: "sess-1", activeOrganizationId: "org-session" },
};

async function call(
	procedure: unknown,
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const built = procedure as Built;
	const parsed = built.inputSchema.safeParse(input);
	if (!parsed.success) {
		throw Object.assign(new Error("input validation failed"), {
			code: "BAD_REQUEST",
		});
	}
	const run = async (
		index: number,
		context: Ctx,
	): Promise<{ output: unknown; context: object }> => {
		const middleware = built.middlewares[index];
		if (!middleware) {
			return {
				output: await built.handler({ input: parsed.data, context }),
				context: {},
			};
		}
		return (await middleware(
			{
				context,
				next: (options) =>
					run(
						index + 1,
						options?.context
							? { ...context, ...options.context }
							: context,
					),
			},
			parsed.data,
		)) as { output: unknown; context: object };
	};
	return (await run(0, { ...ctx })).output as Record<string, unknown>;
}

const callList = (input: Record<string, unknown> = {}) =>
	call(listInstructionRepositoryCommitsProcedure, {
		projectId: "proj-1",
		...input,
	});
const callCompare = (input: Record<string, unknown> = {}) =>
	call(compareInstructionRepositoryCommitsProcedure, {
		projectId: "proj-1",
		from: FROM,
		to: TO,
		...input,
	});
const callFile = (input: Record<string, unknown> = {}) =>
	call(readInstructionRepositoryCommitFileProcedure, {
		projectId: "proj-1",
		sha: TO,
		path: "rules/a.md",
		...input,
	});

const VIEWER = ["instruction:read"];
const WRITER = ["instruction:read", "instruction:create"];
// Distinctive and token-shaped, so a leak assertion cannot pass by accident.
const SECRET_TOKEN = "ghs_example_commits_api_secret";
const FROM = "a".repeat(40);
const TO = "b".repeat(40);
const PARENT = "c".repeat(40);
// Assembled at run time: no token-shaped literal in the tree.
const LEAKED = `${"gh"}${"p_"}${"A".repeat(36)}`;

const integration = {
	id: "int-1",
	projectId: "proj-1",
	provider: "GITHUB",
	authMethod: "OAUTH",
	repositoryUrl: "https://github.com/example-org/instructions",
	repositoryOwner: "example-org",
	repositoryName: "instructions",
	defaultBranch: "main",
	status: "ACTIVE",
	azureOrganization: null,
	encryptedAccessToken: "enc-access",
	encryptedRefreshToken: "enc-refresh",
	encryptedPat: null,
	tokenExpiresAt: null,
	updatedAt: new Date("2026-10-01T00:00:00.000Z"),
};

function commit(over: Record<string, unknown> = {}) {
	return {
		sha: TO,
		authorName: "Pat Example",
		committerName: "Pat Example",
		date: "2026-10-01T09:00:00.000Z",
		message: "Tighten the review skill",
		url: `https://github.com/example-org/instructions/commit/${TO}`,
		parent: PARENT,
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	resetCommitHistoryCache();
	resetCommitSourceCaches();
	m.hasProjectAccess.mockResolvedValue(true);
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: WRITER,
		source: "project-member",
		organizationId: "org-host",
	});
	m.getProjectInstructionSettings.mockResolvedValue({
		sourceOfTruth: "REPOSITORY",
	});
	m.getInstructionRepositorySync.mockResolvedValue({
		id: "sync-1",
		repositoryIntegrationId: "int-1",
		ref: "release/1.2",
		rootPath: "instructions",
	});
	m.getPublishedInstructionSnapshot.mockResolvedValue({
		organizationId: "org-host",
		sourceCommitSha: FROM,
		settingsFrozen: { layer: "default", ignoreGlobs: ["drafts/**"] },
	});
	m.getProjectRepoIntegration.mockResolvedValue(integration);
	m.resolveFreshRepoTokenForRow.mockResolvedValue({ token: SECRET_TOKEN });
	m.getInstructionCommitOverlay.mockResolvedValue({
		published: new Map(),
		refused: new Set(),
	});
	m.listRepositoryCommits.mockResolvedValue({
		ok: true,
		commits: [commit()],
		hasMore: false,
	});
	m.isCommitOnBranch.mockResolvedValue({ ok: true, onBranch: true });
	m.compareRepositoryRefs.mockResolvedValue({
		ok: true,
		files: [],
		truncated: false,
	});
});

describe("what every commit-level read requires", () => {
	it.each([
		["listCommits", () => callList()],
		["compareCommits", () => callCompare()],
		["readCommitFile", () => callFile()],
	])(
		"%s answers a project the caller cannot discover NOT_FOUND before anything is read",
		async (_name, run) => {
			m.hasProjectAccess.mockResolvedValue(false);

			await expect(run()).rejects.toMatchObject({ code: "NOT_FOUND" });

			expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
			expect(m.listRepositoryCommits).not.toHaveBeenCalled();
			expect(m.compareRepositoryRefs).not.toHaveBeenCalled();
			expect(m.readRepositoryFileAtCommit).not.toHaveBeenCalled();
		},
	);

	it.each([
		["listCommits", () => callList()],
		["compareCommits", () => callCompare()],
		["readCommitFile", () => callFile()],
	])("%s refuses a caller without INSTRUCTION_READ", async (_name, run) => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
	});

	it.each([
		["compareCommits", () => callCompare()],
		["readCommitFile", () => callFile()],
	])(
		"%s refuses a member who can only read: it spends the integration's own credential, so it takes INSTRUCTION_CREATE as listTree does",
		async (_name, run) => {
			m.resolveEffectiveProjectPermissions.mockResolvedValue({
				permissions: VIEWER,
				source: "project-member",
				organizationId: "org-host",
			});

			await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });

			expect(m.getProjectRepoIntegration).not.toHaveBeenCalled();
			expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
			expect(m.isCommitOnBranch).not.toHaveBeenCalled();
			expect(m.compareRepositoryRefs).not.toHaveBeenCalled();
			expect(m.readRepositoryFileAtCommit).not.toHaveBeenCalled();
		},
	);

	it("lists the history for a member who can only read: the list is part of the History a reader sees", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: VIEWER,
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(callList()).resolves.toMatchObject({
			nextCursor: null,
		});
	});

	it.each([
		["listCommits", () => callList()],
		["compareCommits", () => callCompare()],
		["readCommitFile", () => callFile()],
	])(
		"%s answers NOT_REPOSITORY_SOURCED for an uploaded project, reading no credential and asking the provider nothing",
		async (_name, run) => {
			m.getProjectInstructionSettings.mockResolvedValue({
				sourceOfTruth: "UPLOAD",
			});

			await expect(run()).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
				data: { reason: "NOT_REPOSITORY_SOURCED" },
			});

			expect(m.resolveFreshRepoTokenForRow).not.toHaveBeenCalled();
			expect(m.listRepositoryCommits).not.toHaveBeenCalled();
			expect(m.isCommitOnBranch).not.toHaveBeenCalled();
		},
	);

	it("reads through the sync's own integration, bound to the project", async () => {
		await callList();

		expect(m.getProjectRepoIntegration).toHaveBeenCalledWith(
			"int-1",
			"proj-1",
		);
		expect(m.getInstructionRepositorySync).toHaveBeenCalledWith(
			"proj-1",
			"org-host",
		);
	});

	it("refuses an organization id in the input other than the host's, before any read", async () => {
		// Fizzy #2904 review: refused by `requireProjectPermission` before the
		// handler body runs, rather than ignored by the handler.
		await expect(
			callList({ organizationId: "org-attacker" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.getInstructionRepositorySync).not.toHaveBeenCalled();
		expect(m.getInstructionCommitOverlay).not.toHaveBeenCalled();
	});

	it("acts in the project's host when no organization is named, never the session's", async () => {
		await callList({});

		expect(m.getInstructionRepositorySync).toHaveBeenCalledWith(
			"proj-1",
			"org-host",
		);
		expect(m.getInstructionCommitOverlay).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-host" }),
		);
	});
});

describe("listCommits", () => {
	it("asks the provider for the sync's branch and folder, and lays Fabric's overlay on the rows", async () => {
		m.listRepositoryCommits.mockResolvedValue({
			ok: true,
			hasMore: true,
			commits: [
				commit({ sha: TO }),
				commit({
					sha: FROM,
					committerName: "Fabric",
					message: "Revert it",
					parent: null,
				}),
				commit({
					sha: PARENT,
					message: "Add a rule\n\nFabric-Commit: snap_1",
				}),
			],
		});
		m.getInstructionCommitOverlay.mockResolvedValue({
			published: new Map([[TO, 7]]),
			refused: new Set([PARENT]),
		});

		const answer = await callList({ cursor: 2 });

		expect(m.listRepositoryCommits).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "GITHUB",
				token: SECRET_TOKEN,
				owner: "example-org",
				repo: "instructions",
				branch: "release/1.2",
				path: "instructions",
				page: 2,
			}),
		);
		expect(m.getInstructionCommitOverlay).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-host",
			shas: [TO, FROM, PARENT],
		});
		expect(answer).toEqual({
			nextCursor: 3,
			commits: [
				{
					sha: TO,
					author: { name: "Pat Example" },
					date: "2026-10-01T09:00:00.000Z",
					message: "Tighten the review skill",
					messageWithheld: false,
					url: `https://github.com/example-org/instructions/commit/${TO}`,
					parent: PARENT,
					published: 7,
					refused: false,
					isFabric: false,
				},
				{
					sha: FROM,
					author: { name: "Pat Example" },
					date: "2026-10-01T09:00:00.000Z",
					message: "Revert it",
					messageWithheld: false,
					url: `https://github.com/example-org/instructions/commit/${TO}`,
					parent: null,
					published: null,
					refused: false,
					isFabric: true,
				},
				{
					sha: PARENT,
					author: { name: "Pat Example" },
					date: "2026-10-01T09:00:00.000Z",
					message: "Add a rule\n\nFabric-Commit: snap_1",
					messageWithheld: false,
					url: `https://github.com/example-org/instructions/commit/${TO}`,
					parent: PARENT,
					published: null,
					refused: true,
					isFabric: true,
				},
			],
		});
	});

	it("starts at page one and ends the cursor on the last page", async () => {
		const answer = await callList();

		expect(m.listRepositoryCommits).toHaveBeenCalledWith(
			expect.objectContaining({ page: 1 }),
		);
		expect(answer.nextCursor).toBeNull();
	});

	it.each([0, -1, 1.5, 5000])("refuses a cursor of %s", async (cursor) => {
		await expect(callList({ cursor })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("returns no address and no token", async () => {
		const answer = await callList();

		expect(JSON.stringify(answer)).not.toContain(SECRET_TOKEN);
		expect(JSON.stringify(answer)).not.toContain("@");
	});

	it("withholds a commit message that holds a credential, keeping the commit listed and saying so", async () => {
		m.listRepositoryCommits.mockResolvedValue({
			ok: true,
			hasMore: false,
			commits: [
				commit({ sha: TO, message: `Rotate ${LEAKED} for the deploy` }),
				commit({ sha: FROM, message: "Tighten the review skill" }),
			],
		});

		const answer = await callList();

		const rows = answer.commits as Array<Record<string, unknown>>;
		expect(rows[0]).toMatchObject({
			sha: TO,
			message: null,
			messageWithheld: true,
			author: { name: "Pat Example" },
		});
		expect(rows[1]).toMatchObject({
			sha: FROM,
			message: "Tighten the review skill",
			messageWithheld: false,
		});
		expect(JSON.stringify(answer)).not.toContain(LEAKED);
	});

	it("replaces an author name that holds a credential with the name Fabric gives an unnamed member", async () => {
		m.listRepositoryCommits.mockResolvedValue({
			ok: true,
			hasMore: false,
			commits: [commit({ authorName: LEAKED })],
		});

		const answer = await callList();

		expect(
			(answer.commits as Array<{ author: unknown }>)[0]?.author,
		).toEqual({ name: "a Fabric user" });
		expect(JSON.stringify(answer)).not.toContain(LEAKED);
	});

	it("scans every call, not only the one that read the provider: a cached page is withheld too", async () => {
		m.listRepositoryCommits.mockResolvedValue({
			ok: true,
			hasMore: false,
			commits: [commit({ message: `token ${LEAKED}` })],
		});

		await callList();
		const again = await callList();

		expect(m.listRepositoryCommits).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(again)).not.toContain(LEAKED);
	});

	it("serves a repeated page from the cache for a minute, and reads the overlay fresh each time", async () => {
		await callList();
		await callList();

		expect(m.listRepositoryCommits).toHaveBeenCalledTimes(1);
		expect(m.getInstructionCommitOverlay).toHaveBeenCalledTimes(2);
	});

	it("misses the cache for another page and once the published commit moved", async () => {
		await callList();
		await callList({ cursor: 2 });
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			organizationId: "org-host",
			sourceCommitSha: TO,
			settingsFrozen: null,
		});
		await callList();

		expect(m.listRepositoryCommits).toHaveBeenCalledTimes(3);
	});

	it.each([
		["unauthorized", "REPOSITORY_CREDENTIALS_EXPIRED"],
		["not-found", "BRANCH_NOT_FOUND"],
		["unreachable", "REPOSITORY_UNREACHABLE"],
	])(
		"answers a provider %s as %s, never an empty history, and caches nothing",
		async (outcome, code) => {
			m.listRepositoryCommits.mockResolvedValue({ ok: false, outcome });

			await expect(callList()).rejects.toMatchObject({ data: { code } });
			await expect(callList()).rejects.toMatchObject({ data: { code } });

			expect(m.listRepositoryCommits).toHaveBeenCalledTimes(2);
		},
	);

	// The branch is there but the synced folder is not (Azure DevOps answers a
	// folder history that way): retrying cannot help, so the answer names the
	// folder rather than calling the branch missing.
	it("answers a folder that is no longer on the branch as FOLDER_NOT_FOUND, naming it", async () => {
		m.listRepositoryCommits.mockResolvedValue({
			ok: false,
			outcome: "missing-path",
		});

		await expect(callList()).rejects.toMatchObject({
			data: { code: "FOLDER_NOT_FOUND" },
			message: expect.stringContaining('"instructions/"'),
		});
	});

	it("authenticates a GitLab personal access token with PRIVATE-TOKEN", async () => {
		m.getProjectRepoIntegration.mockResolvedValue({
			...integration,
			provider: "GITLAB",
			authMethod: "PAT",
		});

		await callList();

		expect(m.listRepositoryCommits).toHaveBeenCalledWith(
			expect.objectContaining({ gitlabAuth: "private-token" }),
		);
	});
});

describe("compareCommits", () => {
	it("names only the folder's files, relative to it, with their kind", async () => {
		m.compareRepositoryRefs.mockResolvedValue({
			ok: true,
			truncated: true,
			files: [
				{ path: "instructions/rules/new.md", status: "added" },
				{ path: "instructions/CLAUDE.md", status: "modified" },
				{ path: "instructions/rules/old.md", status: "removed" },
				{ path: "README.md", status: "modified" },
				{ path: "instructions-other/x.md", status: "added" },
			],
		});

		const answer = await callCompare();

		expect(m.compareRepositoryRefs).toHaveBeenCalledWith(
			expect.objectContaining({
				from: FROM,
				to: TO,
				token: SECRET_TOKEN,
			}),
		);
		expect(answer).toEqual({
			from: { sha: FROM },
			to: { sha: TO },
			truncated: true,
			added: [
				{
					path: "rules/new.md",
					kind: expect.any(String),
					isText: true,
				},
			],
			removed: [
				{
					path: "rules/old.md",
					kind: expect.any(String),
					isText: true,
				},
			],
			changed: [
				{ path: "CLAUDE.md", kind: expect.any(String), isText: true },
			],
		});
	});

	it("leaves out what the published version's rules exclude and any credential-shaped name", async () => {
		m.compareRepositoryRefs.mockResolvedValue({
			ok: true,
			truncated: false,
			files: [
				{ path: "instructions/drafts/wip.md", status: "added" },
				{ path: "instructions/.env", status: "added" },
				{
					path: "instructions/.claude/settings.local.json",
					status: "added",
				},
				{
					path: "instructions/nested/CLAUDE.local.md",
					status: "added",
				},
				{ path: "instructions/rules/kept.md", status: "added" },
			],
		});

		const answer = await callCompare();

		expect(answer.added).toEqual([
			{ path: "rules/kept.md", kind: expect.any(String), isText: true },
		]);
		expect(answer.removed).toEqual([]);
		expect(answer.changed).toEqual([]);
	});

	it("compares the whole repository when the sync's folder is the root", async () => {
		m.getInstructionRepositorySync.mockResolvedValue({
			id: "sync-1",
			repositoryIntegrationId: "int-1",
			ref: "main",
			rootPath: "",
		});
		m.compareRepositoryRefs.mockResolvedValue({
			ok: true,
			truncated: false,
			files: [{ path: "AGENTS.md", status: "modified" }],
		});

		const answer = await callCompare();

		expect(answer.changed).toEqual([
			{ path: "AGENTS.md", kind: expect.any(String), isText: true },
		]);
	});

	it.each([
		[
			"a commit that is not on the synced branch (a pull request's head, say)",
			FROM,
		],
		["the other side as well", TO],
	])(
		"answers %s as NOT_FOUND and compares nothing",
		async (_label, offBranch) => {
			m.isCommitOnBranch.mockImplementation(
				async (i: { sha: string }) => ({
					ok: true,
					onBranch: i.sha !== offBranch,
				}),
			);

			await expect(callCompare()).rejects.toMatchObject({
				code: "NOT_FOUND",
				data: { code: "COMMIT_NOT_FOUND" },
			});

			expect(m.compareRepositoryRefs).not.toHaveBeenCalled();
		},
	);

	it("asks the provider whether each commit is on the branch, and remembers a yes", async () => {
		await callCompare();
		await callCompare();

		expect(m.isCommitOnBranch).toHaveBeenCalledTimes(2);
		expect(m.isCommitOnBranch).toHaveBeenCalledWith(
			expect.objectContaining({ branch: "release/1.2", sha: FROM }),
		);
	});

	it("answers a commit the repository does not have exactly as one on another branch: 404 COMMIT_NOT_FOUND", async () => {
		m.isCommitOnBranch.mockResolvedValue({ ok: true, onBranch: false });
		const offBranch = await callCompare().catch((e: unknown) => e);
		m.isCommitOnBranch.mockResolvedValue({
			ok: false,
			outcome: "not-found",
		});

		const unknown = await callCompare().catch((e: unknown) => e);

		expect(unknown).toMatchObject({
			code: "NOT_FOUND",
			data: { code: "COMMIT_NOT_FOUND" },
			message: (offBranch as { message: string }).message,
		});
		expect(m.compareRepositoryRefs).not.toHaveBeenCalled();
	});

	it("answers an unknown commit the same way for the revert and the file read", async () => {
		m.isCommitOnBranch.mockResolvedValue({
			ok: false,
			outcome: "not-found",
		});

		await expect(callFile()).rejects.toMatchObject({
			code: "NOT_FOUND",
			data: { code: "COMMIT_NOT_FOUND" },
		});
		expect(m.readRepositoryFileAtCommit).not.toHaveBeenCalled();
	});

	describe("the memory of a yes", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("lasts a minute and no longer", async () => {
			vi.useFakeTimers();
			await callCompare();
			expect(m.isCommitOnBranch).toHaveBeenCalledTimes(2);

			vi.advanceTimersByTime(59_000);
			await callCompare();
			expect(m.isCommitOnBranch).toHaveBeenCalledTimes(2);

			vi.advanceTimersByTime(2_000);
			await callCompare();
			expect(m.isCommitOnBranch).toHaveBeenCalledTimes(4);
		});

		it("is kept per repository address: an integration pointed at another repository asks again", async () => {
			await callCompare();
			expect(m.isCommitOnBranch).toHaveBeenCalledTimes(2);

			m.getProjectRepoIntegration.mockResolvedValue({
				...integration,
				repositoryUrl: "https://github.com/example-org/another",
				repositoryName: "another",
			});
			await callCompare();

			expect(m.isCommitOnBranch).toHaveBeenCalledTimes(4);
			expect(m.isCommitOnBranch).toHaveBeenLastCalledWith(
				expect.objectContaining({
					repositoryUrl: "https://github.com/example-org/another",
				}),
			);
		});
	});

	it("never remembers a no", async () => {
		m.isCommitOnBranch.mockResolvedValue({ ok: true, onBranch: false });

		await expect(callCompare()).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		m.isCommitOnBranch.mockResolvedValue({ ok: true, onBranch: true });
		await expect(callCompare()).resolves.toMatchObject({
			truncated: false,
		});
	});

	it("takes full object ids only", async () => {
		for (const from of ["main", "abc123", `${FROM}; rm`, "A".repeat(40)]) {
			await expect(callCompare({ from })).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		}
		expect(m.compareRepositoryRefs).not.toHaveBeenCalled();
	});

	it.each([
		["unauthorized", "REPOSITORY_CREDENTIALS_EXPIRED"],
		["unreachable", "REPOSITORY_UNREACHABLE"],
	])("answers a provider %s as %s", async (outcome, code) => {
		m.compareRepositoryRefs.mockResolvedValue({ ok: false, outcome });

		await expect(callCompare()).rejects.toMatchObject({ data: { code } });
	});

	it("answers a failed branch-membership check as the read error it is, never as not-on-branch", async () => {
		m.isCommitOnBranch.mockResolvedValue({
			ok: false,
			outcome: "unreachable",
		});

		await expect(callCompare()).rejects.toMatchObject({
			data: { code: "REPOSITORY_UNREACHABLE" },
		});
	});
});

describe("readCommitFile", () => {
	const found = (text: string) => ({
		ok: true,
		state: "found",
		bytes: new TextEncoder().encode(text),
	});

	it("reads the file under the sync's folder at the commit", async () => {
		m.readRepositoryFileAtCommit.mockResolvedValue(found("alpha\n"));

		const answer = await callFile();

		expect(m.readRepositoryFileAtCommit).toHaveBeenCalledWith(
			expect.objectContaining({
				sha: TO,
				path: "instructions/rules/a.md",
				token: SECRET_TOKEN,
				maxBytes: 262_144,
			}),
		);
		expect(answer).toEqual({ state: "found", content: "alpha\n" });
	});

	it("reads from the repository root when the sync's folder is the root", async () => {
		m.getInstructionRepositorySync.mockResolvedValue({
			id: "sync-1",
			repositoryIntegrationId: "int-1",
			ref: "main",
			rootPath: "",
		});
		m.readRepositoryFileAtCommit.mockResolvedValue(found("alpha\n"));

		await callFile();

		expect(m.readRepositoryFileAtCommit).toHaveBeenCalledWith(
			expect.objectContaining({ path: "rules/a.md" }),
		);
	});

	it.each([
		["a path the published rules exclude", "drafts/wip.md"],
		["a credential-shaped name", ".env"],
		["a path that climbs out", "../secrets.md"],
		["an absolute path", "/etc/passwd"],
	])(
		"answers %s NOT_FOUND without asking the provider",
		async (_label, path) => {
			await expect(callFile({ path })).rejects.toMatchObject({
				code: "NOT_FOUND",
			});

			expect(m.readRepositoryFileAtCommit).not.toHaveBeenCalled();
		},
	);

	it("answers a commit off the synced branch NOT_FOUND and reads nothing", async () => {
		m.isCommitOnBranch.mockResolvedValue({ ok: true, onBranch: false });

		await expect(callFile()).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(m.readRepositoryFileAtCommit).not.toHaveBeenCalled();
	});

	it("withholds everything from a commit the secret scan refused, reading nothing", async () => {
		m.getInstructionCommitOverlay.mockResolvedValue({
			published: new Map(),
			refused: new Set([TO]),
		});

		const answer = await callFile();

		expect(answer).toEqual({ state: "withheld", reason: "refused" });
		expect(m.readRepositoryFileAtCommit).not.toHaveBeenCalled();
	});

	it("withholds a file whose text holds a credential, without a line or a rule", async () => {
		m.readRepositoryFileAtCommit.mockResolvedValue(
			found(`Use this token ${LEAKED} for the deploy\n`),
		);

		const answer = await callFile();

		expect(answer).toEqual({ state: "withheld", reason: "secret" });
		expect(JSON.stringify(answer)).not.toContain(LEAKED);
	});

	it.each([
		[
			"a file the commit does not hold",
			{ ok: true, state: "absent" },
			{ state: "absent" },
		],
		[
			"a file over the cap",
			{ ok: true, state: "tooLarge" },
			{ state: "tooLarge" },
		],
		[
			"bytes that are not text",
			{
				ok: true,
				state: "found",
				bytes: new Uint8Array([0x89, 0x50, 0x00, 0x47]),
			},
			{ state: "binary" },
		],
		[
			"bytes that are not valid UTF-8",
			{
				ok: true,
				state: "found",
				bytes: new Uint8Array([0xff, 0xfe, 0x41]),
			},
			{ state: "binary" },
		],
	])(
		"answers %s as a state, not an error",
		async (_label, read, expected) => {
			m.readRepositoryFileAtCommit.mockResolvedValue(read);

			expect(await callFile()).toEqual(expected);
		},
	);

	it.each([
		["unauthorized", "REPOSITORY_CREDENTIALS_EXPIRED"],
		["unreachable", "REPOSITORY_UNREACHABLE"],
		["unsupported", "REPOSITORY_UNREACHABLE"],
	])("answers a provider %s as %s", async (outcome, code) => {
		m.readRepositoryFileAtCommit.mockResolvedValue({ ok: false, outcome });

		await expect(callFile()).rejects.toMatchObject({ data: { code } });
	});
});
