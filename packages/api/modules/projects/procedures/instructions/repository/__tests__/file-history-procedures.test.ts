import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";

type Args = {
	input: Record<string, unknown>;
	context: { user: { id: string; email: string }; headers: Headers };
	signal?: AbortSignal;
};
type Registration = {
	schema: ZodType<Record<string, unknown>>;
	permissions: string[];
	call: (args: Args) => Promise<unknown>;
};
const m = vi.hoisted(() => ({
	routes: new Map<string, Registration>(),
	permission: vi.fn(),
	visible: vi.fn(),
	preview: vi.fn(),
	restore: vi.fn(),
	load: vi.fn(),
	pin: vi.fn(),
	fence: vi.fn(),
	head: vi.fn(),
	commits: vi.fn(),
	ignore: vi.fn(),
}));

vi.mock("../../../../../../orpc/middleware/project-visibility", () => ({
	projectNotFoundUnlessVisible: (args: Args) => m.visible(args),
}));
vi.mock("../../../../../../orpc/procedures", () => {
	const builder = (
		middlewares: Array<(args: Args) => unknown> = [],
		permissions: string[] = [],
	) => ({
		use(middleware: ((args: Args) => unknown) & { permission?: string }) {
			return builder(
				[...middlewares, middleware],
				middleware.permission === undefined
					? permissions
					: [...permissions, middleware.permission],
			);
		},
		route(route: { method: string; path: string }) {
			return {
				input(schema: ZodType<Record<string, unknown>>) {
					return {
						handler(handler: (args: Args) => unknown) {
							const call = async (args: Args) => {
								for (const middleware of middlewares)
									await middleware(args);
								return handler({
									...args,
									input: schema.parse(args.input),
								});
							};
							m.routes.set(`${route.method} ${route.path}`, {
								schema,
								permissions,
								call,
							});
							return call;
						},
					};
				},
			};
		},
	});
	return {
		tenantProtectedProcedure: builder(),
		requireProjectPermission(permission: string) {
			return Object.assign(
				(args: Args) => m.permission(permission, args),
				{ permission },
			);
		},
		Permissions: {
			INSTRUCTION_READ: "instruction:read",
			INSTRUCTION_CREATE: "instruction:create",
		},
	};
});
vi.mock("../file-history", () => ({
	previewInstructionFileRestore: m.preview,
	restoreInstructionFile: m.restore,
}));
vi.mock("../direct-source", () => ({
	loadDirectRepositorySource: m.load,
	assertDirectRepositoryPin: m.pin,
	assertDirectRepositorySourceCurrent: m.fence,
	resolveDirectRepositoryHead: m.head,
	resolveDirectRepositoryIgnore: m.ignore,
	directRepositoryPath: (source: { rootPath: string }, path: string) =>
		`${source.rootPath}/${path}`,
	directRepositoryReadError: (_source: unknown, outcome: string) =>
		new ORPCError("BAD_REQUEST", { data: { code: outcome } }),
}));
vi.mock("@repo/connectors", () => ({ listRepositoryCommits: m.commits }));

import "../file-history-procedures";
import "../list-commits";

const context = {
	user: { id: "reader-1", email: "reader@example.com" },
	headers: new Headers(),
};
const base = {
	projectId: "project-1",
	generation: 7,
	path: "AGENTS.md",
	targetCommitSha: "a".repeat(40),
};
const currentCommitSha = "b".repeat(40);
const source = {
	generation: 7,
	rootPath: "instructions",
	repository: {},
	ref: "main",
};
function route(method: "GET" | "POST", suffix: "file-restore" | "commits") {
	const registration = m.routes.get(
		`${method} /projects/:projectId/instructions/repository/${suffix}`,
	);
	if (!registration) throw new Error("Missing procedure registration");
	return registration;
}

beforeEach(() => {
	for (const mock of [
		m.permission,
		m.visible,
		m.preview,
		m.restore,
		m.load,
		m.pin,
		m.fence,
		m.head,
		m.commits,
		m.ignore,
	])
		mock.mockReset();
	m.load.mockResolvedValue(source);
	m.head.mockResolvedValue({ generation: 7, commitSha: currentCommitSha });
	m.ignore.mockResolvedValue({ globs: [], layer: "project" });
	m.commits.mockResolvedValue({ ok: true, commits: [], hasMore: true });
});

describe("file history portal contracts", () => {
	it("requires read permission for preview and create permission for restore", () => {
		expect(route("GET", "file-restore").permissions).toEqual([
			"instruction:read",
		]);
		expect(route("POST", "file-restore").permissions).toEqual([
			"instruction:create",
		]);
	});

	it("injects the authenticated actor and ignores client-supplied content and tenant", async () => {
		await route("POST", "file-restore").call({
			input: {
				...base,
				currentCommitSha,
				userId: "other-user",
				organizationId: "other-org",
				content: "injected",
			},
			context,
		});
		expect(m.restore).toHaveBeenCalledExactlyOnceWith({
			...base,
			currentCommitSha,
			userId: context.user.id,
			audit: context,
			signal: undefined,
		});
	});

	it("refuses a viewer's restore and a hidden project before executing its handler", async () => {
		m.permission.mockRejectedValueOnce(new ORPCError("FORBIDDEN"));
		await expect(
			route("POST", "file-restore").call({
				input: { ...base, currentCommitSha },
				context,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.restore).not.toHaveBeenCalled();
		m.visible.mockRejectedValueOnce(new ORPCError("NOT_FOUND"));
		await expect(
			route("GET", "file-restore").call({ input: base, context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.preview).not.toHaveBeenCalled();
	});

	it("requires a full current base for mutation and rejects invalid paths and target pins", () => {
		expect(
			route("POST", "file-restore").schema.safeParse(base).success,
		).toBe(false);
		for (const override of [
			{ path: "../outside.md" },
			{ targetCommitSha: "short" },
			{ generation: 0 },
		]) {
			expect(
				route("GET", "file-restore").schema.safeParse({
					...base,
					...override,
				}).success,
			).toBe(false);
		}
	});

	it("uses the exact file path and stable pin for one provider history page", async () => {
		await expect(
			route("GET", "commits").call({
				input: {
					projectId: base.projectId,
					generation: 7,
					commitSha: currentCommitSha,
					path: "AGENTS.md",
					cursor: 2,
				},
				context,
			}),
		).resolves.toMatchObject({
			nextCursor: 3,
			hasMore: true,
			historyLimitReached: false,
		});
		expect(m.commits).toHaveBeenCalledExactlyOnceWith({
			branch: "main",
			commitSha: currentCommitSha,
			path: "instructions/AGENTS.md",
			page: 2,
			includeParents: false,
		});
		expect(m.fence).toHaveBeenCalledOnce();
	});

	it("preserves existing root-history callers and exposes the paging cap", async () => {
		await expect(
			route("GET", "commits").call({
				input: {
					projectId: base.projectId,
					generation: 7,
					commitSha: currentCommitSha,
					cursor: 1000,
				},
				context,
			}),
		).resolves.toMatchObject({
			nextCursor: null,
			hasMore: true,
			historyLimitReached: true,
		});
		expect(m.commits).toHaveBeenCalledWith(
			expect.objectContaining({ path: "instructions" }),
		);
		expect(m.head).not.toHaveBeenCalled();
	});

	it("keeps missing-path/provider errors distinct from confirmed empty history", async () => {
		m.commits.mockResolvedValue({ ok: false, outcome: "missing-path" });
		await expect(
			route("GET", "commits").call({
				input: {
					projectId: base.projectId,
					generation: 7,
					commitSha: currentCommitSha,
					path: "deleted.md",
				},
				context,
			}),
		).rejects.toMatchObject({ data: { code: "missing-path" } });
		expect(m.fence).toHaveBeenCalledOnce();
	});

	it("fences history after provider I/O when access is revoked", async () => {
		m.fence.mockRejectedValue(new ORPCError("NOT_FOUND"));
		await expect(
			route("GET", "commits").call({
				input: {
					projectId: base.projectId,
					generation: 7,
					commitSha: currentCommitSha,
					path: "AGENTS.md",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
