/**
 * `repository.getCommitParent` — the lazily read parent of one selected native
 * history commit — beside `repository.listCommits`, which must keep leaving
 * parents unread. The procedures run their REAL middleware chain (visibility,
 * then `requireProjectPermission`); the source loader and the connector reads
 * are mocked. Every identifier is synthetic.
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	hasProjectAccess: vi.fn(),
	loadSource: vi.fn(),
	assertPin: vi.fn(),
	assertCurrent: vi.fn(),
	readParent: vi.fn(),
	listCommits: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {},
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(),
	hasProjectAccess: m.hasProjectAccess,
	grantProjectAccess: vi.fn(),
}));
vi.mock("@repo/connectors", () => ({
	listRepositoryCommits: m.listCommits,
	readRepositoryCommitParent: m.readParent,
}));
vi.mock("../direct-source", () => ({
	loadDirectRepositorySource: m.loadSource,
	assertDirectRepositoryPin: m.assertPin,
	assertDirectRepositorySourceCurrent: m.assertCurrent,
	directRepositoryReadError: (
		_source: unknown,
		outcome: string,
	): ORPCError<string, unknown> =>
		new ORPCError("BAD_REQUEST", {
			message: outcome,
			data: { code: `READ_${outcome}` },
		}),
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

import { resetDirectRepositoryCaches } from "../direct-cache";
import { getDirectInstructionRepositoryCommitParentProcedure } from "../get-commit-parent";
import { listDirectInstructionRepositoryCommitsProcedure } from "../list-commits";

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

const SHA = "a".repeat(40);
const PARENT = "b".repeat(40);
const PIN = "c".repeat(40);
const repository = { provider: "AZURE_DEVOPS", token: "example-token" };
const source = {
	generation: 7,
	ref: "main",
	rootPath: "agents",
	repository,
};

const callParent = (input: Record<string, unknown> = {}) =>
	call(getDirectInstructionRepositoryCommitParentProcedure, {
		projectId: "proj-1",
		generation: 7,
		sha: SHA,
		...input,
	});

beforeEach(() => {
	vi.resetAllMocks();
	resetDirectRepositoryCaches();
	m.hasProjectAccess.mockResolvedValue(true);
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ["instruction:read"],
		source: "project-member",
		organizationId: "org-host",
	});
	m.loadSource.mockResolvedValue(source);
	m.assertPin.mockResolvedValue(undefined);
	m.assertCurrent.mockResolvedValue(undefined);
	m.readParent.mockResolvedValue({ ok: true, parent: PARENT });
	m.listCommits.mockResolvedValue({ ok: true, commits: [], hasMore: false });
});

describe("repository.getCommitParent", () => {
	it("reads the selected Azure DevOps commit's parent once, after the pin check", async () => {
		const result = await callParent();

		expect(result).toEqual({ sha: SHA, parent: PARENT });
		expect(m.assertPin).toHaveBeenCalledWith(source, {
			generation: 7,
			commitSha: SHA,
		});
		expect(m.readParent).toHaveBeenCalledOnce();
		expect(m.readParent).toHaveBeenCalledWith({ ...repository, sha: SHA });
		expect(m.assertCurrent).toHaveBeenCalledOnce();
	});

	it("answers a root commit with a null parent", async () => {
		m.readParent.mockResolvedValue({ ok: true, parent: null });

		expect(await callParent()).toEqual({ sha: SHA, parent: null });
	});

	it("refuses a reader without instruction read permission before touching the repository", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "project-member",
			organizationId: "org-host",
		});

		await expect(callParent()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.loadSource).not.toHaveBeenCalled();
		expect(m.readParent).not.toHaveBeenCalled();
	});

	it("returns nothing for a commit that is not on the configured branch", async () => {
		m.assertPin.mockRejectedValue(
			new ORPCError("NOT_FOUND", {
				message: "missing",
				data: { code: "COMMIT_NOT_FOUND" },
			}),
		);

		await expect(callParent()).rejects.toMatchObject({
			data: { code: "COMMIT_NOT_FOUND" },
		});
		expect(m.assertCurrent).toHaveBeenCalledOnce();
	});

	it("fences a provider failure with the live source check and reports it", async () => {
		m.readParent.mockResolvedValue({ ok: false, outcome: "unauthorized" });

		await expect(callParent()).rejects.toMatchObject({
			data: { code: "READ_unauthorized" },
		});
		expect(m.assertCurrent).toHaveBeenCalledOnce();
	});

	it("rejects a malformed sha before any repository work", async () => {
		await expect(callParent({ sha: "main" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(m.loadSource).not.toHaveBeenCalled();
	});
});

describe("repository.listCommits", () => {
	it("still lists history without a per-commit parent read, for every provider", async () => {
		await call(listDirectInstructionRepositoryCommitsProcedure, {
			projectId: "proj-1",
			generation: 7,
			commitSha: PIN,
		});

		expect(m.listCommits).toHaveBeenCalledWith(
			expect.objectContaining({ includeParents: false, commitSha: PIN }),
		);
		expect(m.readParent).not.toHaveBeenCalled();
	});
});
