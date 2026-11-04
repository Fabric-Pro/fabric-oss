/**
 * `repositorySync.getConsolidationCleanupPullRequest` and
 * `mergeConsolidationCleanupPullRequest`: the cleanup pull request a
 * consolidation opens in the code repository, read live and merged from
 * Fabric after a confirmation.
 *
 * Each call runs the procedure's REAL middleware chain (visibility, the real
 * `requireProjectPermission`) and the handler's real `assertProjectPermission`.
 * The database, the credential resolver and the provider adapter are mocked;
 * the repository identity helpers are small GitHub-only stand-ins. Every
 * identifier is synthetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	getLatestInstructionConsolidation: vi.fn(),
	getProjectRepoIntegration: vi.fn(),
	markMerged: vi.fn(),
	resolveFreshRepoToken: vi.fn(),
	adapter: {
		get: vi.fn(),
		findOperation: vi.fn(),
		merge: vi.fn(),
	},
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {},
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(),
	grantProjectAccess: vi.fn(),
	hasProjectAccess: m.hasProjectAccess,
	getLatestInstructionConsolidation: m.getLatestInstructionConsolidation,
	getProjectRepoIntegration: m.getProjectRepoIntegration,
	markInstructionConsolidationCleanupMerged: m.markMerged,
}));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoToken: m.resolveFreshRepoToken,
}));
vi.mock("@repo/integrations/instruction-pull-requests", () => ({
	adapterFor: () => m.adapter,
	// GitHub only, the shape the real helpers return.
	repositoryIdentity: (provider: string, url: string) => {
		const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(url);
		return provider === "GITHUB" && match
			? { provider: "GITHUB", owner: match[1], repo: match[2] }
			: null;
	},
	sameRepository: (
		a: { owner: string; repo: string },
		b: { owner: string; repo: string },
	) =>
		a.owner.toLowerCase() === b.owner.toLowerCase() &&
		a.repo.toLowerCase() === b.repo.toLowerCase(),
}));
vi.mock("../../../../../../lib/audit", () => ({
	recordAuditFromRequest: m.recordAuditFromRequest,
}));
vi.mock("../../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.resolveEffectiveProjectPermissions,
}));
vi.mock("../../../../../../orpc/procedures", async () => {
	const { assertProjectPermission, requireProjectPermission } =
		await vi.importActual<
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
		assertProjectPermission,
		requireProjectPermission,
		Permissions,
	};
});

import {
	getConsolidationCleanupPullRequestProcedure,
	mergeConsolidationCleanupPullRequestProcedure,
} from "../consolidation-cleanup";

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

const callGet = () =>
	call(getConsolidationCleanupPullRequestProcedure, { projectId: "proj-1" });
const callMerge = (pullRequestNumber = "7") =>
	call(mergeConsolidationCleanupPullRequestProcedure, {
		projectId: "proj-1",
		pullRequestNumber,
	});

const MOVER = [
	"instruction:read",
	"instruction:create",
	"project:settings:edit",
];
const READER = ["instruction:read"];
const HEAD = "a".repeat(40);
const SECRET_TOKEN = "ghs_example_cleanup_secret";
const PR_URL = "https://github.com/example-org/example-app/pull/7";
const BRANCH = "fabric/move-ai-instructions-run1";

function run(over: Record<string, unknown> = {}) {
	return {
		id: "run-1",
		projectId: "proj-1",
		organizationId: "org-host",
		status: "COMPLETED",
		sourceIntegrationId: "int-code",
		cleanupPullRequestUrl: PR_URL,
		cleanupPullRequestId: "7",
		cleanupHeadSha: HEAD,
		cleanupMergedAt: null,
		fileCount: 4,
		...over,
	};
}

const integration = {
	id: "int-code",
	projectId: "proj-1",
	provider: "GITHUB",
	authMethod: "OAUTH",
	repositoryUrl: "https://github.com/example-org/example-app",
	repositoryOwner: "example-org",
	repositoryName: "example-app",
	defaultBranch: "main",
};

function observation(over: Record<string, unknown> = {}) {
	return {
		externalId: "7",
		url: PR_URL,
		state: "OPEN",
		sourceRef: BRANCH,
		targetRef: "main",
		sourceRepository: {
			provider: "GITHUB",
			owner: "example-org",
			repo: "example-app",
		},
		headSha: HEAD,
		...over,
	};
}

function permissions(list: string[], organizationId = "org-host") {
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: list,
		source: "project-member",
		organizationId,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	m.hasProjectAccess.mockResolvedValue(true);
	permissions(MOVER);
	m.getLatestInstructionConsolidation.mockResolvedValue(run());
	m.getProjectRepoIntegration.mockResolvedValue(integration);
	m.resolveFreshRepoToken.mockResolvedValue({
		token: SECRET_TOKEN,
		authMethod: "OAUTH",
	});
	m.adapter.get.mockResolvedValue(observation());
	m.adapter.merge.mockResolvedValue({
		kind: "MERGED",
		mergeCommitSha: "b".repeat(40),
	});
});

describe("getConsolidationCleanupPullRequest", () => {
	it("reads the pull request live and says the mover may merge it", async () => {
		const out = await callGet();
		expect(out.pullRequest).toMatchObject({
			state: "OPEN",
			number: "7",
			url: PR_URL,
			repository: "example-org/example-app",
			defaultBranch: "main",
			fileCount: 4,
			canMerge: true,
		});
		expect(m.resolveFreshRepoToken).toHaveBeenCalledWith(
			expect.objectContaining({
				integrationId: "int-code",
				projectId: "proj-1",
				organizationId: "org-host",
			}),
		);
		expect(JSON.stringify(out)).not.toContain(SECRET_TOKEN);
	});

	it("a reader sees the state but may not merge", async () => {
		permissions(READER);
		const out = await callGet();
		expect(out.pullRequest).toMatchObject({
			state: "OPEN",
			canMerge: false,
		});
	});

	it("records a merge it sees, and answers later reads from the row", async () => {
		m.adapter.get.mockResolvedValue(
			observation({ state: "MERGED", mergedAt: "2026-11-04T10:00:00Z" }),
		);
		const out = await callGet();
		expect(out.pullRequest).toMatchObject({
			state: "MERGED",
			canMerge: false,
		});
		expect(m.markMerged).toHaveBeenCalledWith(
			"run-1",
			"proj-1",
			new Date("2026-11-04T10:00:00Z"),
		);

		m.adapter.get.mockClear();
		m.getLatestInstructionConsolidation.mockResolvedValue(
			run({ cleanupMergedAt: new Date("2026-11-04T10:00:00Z") }),
		);
		const again = await callGet();
		expect(again.pullRequest).toMatchObject({ state: "MERGED" });
		expect(m.adapter.get).not.toHaveBeenCalled();
	});

	it("never shows another branch's pull request as the cleanup one", async () => {
		m.adapter.get.mockResolvedValue(
			observation({ sourceRef: "feature/other" }),
		);
		const out = await callGet();
		expect(out.pullRequest).toMatchObject({
			state: "UNKNOWN",
			canMerge: false,
		});
	});

	it("a run of another organization is not this project's", async () => {
		m.getLatestInstructionConsolidation.mockResolvedValue(
			run({ organizationId: "org-other" }),
		);
		expect(await callGet()).toEqual({ pullRequest: null });
		expect(m.resolveFreshRepoToken).not.toHaveBeenCalled();
	});

	it("an invisible project is NOT_FOUND before any read", async () => {
		m.hasProjectAccess.mockResolvedValue(false);
		await expect(callGet()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.getLatestInstructionConsolidation).not.toHaveBeenCalled();
	});
});

describe("mergeConsolidationCleanupPullRequest", () => {
	it("merges with the head Fabric pushed, records it and audits without secrets", async () => {
		const out = await callMerge();
		expect(m.adapter.merge).toHaveBeenCalledWith(
			expect.objectContaining({
				externalId: "7",
				expectedHeadSha: HEAD,
				method: "squash",
			}),
		);
		expect(m.markMerged).toHaveBeenCalledWith(
			"run-1",
			"proj-1",
			expect.any(Date),
		);
		expect(out.pullRequest).toMatchObject({ state: "MERGED" });
		expect(m.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		const audit = m.recordAuditFromRequest.mock.calls[0]?.[1];
		expect(audit).toMatchObject({
			action: "project.instructions.consolidation_cleanup_merged",
			organizationId: "org-host",
			projectId: "proj-1",
			resource: { id: "int-code", name: "example-org/example-app" },
			metadata: { pullRequest: 7, mergeMethod: "squash", fileCount: 4 },
		});
		expect(JSON.stringify(audit)).not.toContain(SECRET_TOKEN);
	});

	it("a member without settings edit may not merge", async () => {
		permissions(["instruction:read", "instruction:create"]);
		await expect(callMerge()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.adapter.merge).not.toHaveBeenCalled();
	});

	it("a reader is refused by the middleware", async () => {
		permissions(READER);
		await expect(callMerge()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.adapter.merge).not.toHaveBeenCalled();
	});

	it("a run of another organization has nothing to merge", async () => {
		m.getLatestInstructionConsolidation.mockResolvedValue(
			run({ organizationId: "org-other" }),
		);
		await expect(callMerge()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.adapter.merge).not.toHaveBeenCalled();
	});

	it("refuses a pull request number that is not the run's", async () => {
		await expect(callMerge("8")).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "WRONG_PULL_REQUEST" },
		});
		expect(m.adapter.merge).not.toHaveBeenCalled();
	});

	it("refuses a pull request on another branch", async () => {
		m.adapter.get.mockResolvedValue(
			observation({ sourceRef: "feature/other" }),
		);
		await expect(callMerge()).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
		expect(m.adapter.merge).not.toHaveBeenCalled();
	});

	it("refuses a closed pull request", async () => {
		m.adapter.get.mockResolvedValue(observation({ state: "CLOSED" }));
		await expect(callMerge()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "PULL_REQUEST_CLOSED" },
		});
		expect(m.adapter.merge).not.toHaveBeenCalled();
	});

	it("refuses an already merged pull request and records it", async () => {
		m.adapter.get.mockResolvedValue(observation({ state: "MERGED" }));
		await expect(callMerge()).rejects.toMatchObject({
			data: { code: "ALREADY_MERGED" },
		});
		expect(m.markMerged).toHaveBeenCalled();
		expect(m.adapter.merge).not.toHaveBeenCalled();
	});

	it("does not merge a branch whose head moved", async () => {
		m.adapter.get.mockResolvedValue(
			observation({ headSha: "c".repeat(40) }),
		);
		await expect(callMerge()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "HEAD_MOVED" },
		});
		expect(m.adapter.merge).not.toHaveBeenCalled();
	});

	it("does not merge when Fabric never recorded the head it pushed", async () => {
		m.getLatestInstructionConsolidation.mockResolvedValue(
			run({ cleanupHeadSha: null }),
		);
		await expect(callMerge()).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { code: "HEAD_UNKNOWN" },
		});
		expect(m.adapter.merge).not.toHaveBeenCalled();
	});

	it("explains a missing permission with GitHub's accepted permissions, and does not audit", async () => {
		m.adapter.merge.mockResolvedValue({
			kind: "REFUSED",
			reason: "permission",
			acceptedPermissions: "contents=write; pull_requests=write",
		});
		const error = await callMerge().catch((e: unknown) => e);
		expect(error).toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "MERGE_FORBIDDEN" },
		});
		expect((error as Error).message).toContain(
			"contents=write; pull_requests=write",
		);
		expect((error as Error).message).not.toContain(SECRET_TOKEN);
		expect(m.markMerged).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it.each([
		["not_mergeable", "CONFLICT", "NOT_MERGEABLE"],
		["head_moved", "CONFLICT", "HEAD_MOVED"],
		["auth", "BAD_REQUEST", "AUTHENTICATION_FAILED"],
		["rate_limit", "TOO_MANY_REQUESTS", "PROVIDER_RATE_LIMITED"],
		["transient", "SERVICE_UNAVAILABLE", "PROVIDER_UNAVAILABLE"],
	])("maps a %s refusal to %s", async (reason, code, dataCode) => {
		m.adapter.merge.mockResolvedValue({ kind: "REFUSED", reason });
		await expect(callMerge()).rejects.toMatchObject({
			code,
			data: { code: dataCode },
		});
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});
