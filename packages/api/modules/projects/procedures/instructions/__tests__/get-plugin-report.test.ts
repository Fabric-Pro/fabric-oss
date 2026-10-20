/**
 * Tests for `getPluginReportProcedure`: what a coding-tool plugin leaves out
 * of the project's PUBLISHED instructions, computed on the server from the
 * published snapshot (upload and repository-sync projects) or from the
 * repository listing (a project that reads its repository directly), so an
 * admin sees it without any developer running the CLI.
 *
 * The mapping itself is `planPluginFiles` in `@fabricorg/sdk`, which the CLI
 * uses to build the plugin; what is pinned here is the choice of source, the
 * tenant boundary (R11), the cap and the shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	getPublishedInstructionSnapshot: vi.fn(),
	listInstructionFiles: vi.fn(),
	resolveCurrentInstructionSource: vi.fn(),
	listDirectRepositoryFilesForApi: vi.fn(),
	requireHostingOrganizationId: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getPublishedInstructionSnapshot: (...a: unknown[]) =>
		m.getPublishedInstructionSnapshot(...a),
	listInstructionFiles: (...a: unknown[]) => m.listInstructionFiles(...a),
	resolveCurrentInstructionSource: (...a: unknown[]) =>
		m.resolveCurrentInstructionSource(...a),
}));
vi.mock("../repository/direct-query", () => ({
	listDirectRepositoryFilesForApi: (...a: unknown[]) =>
		m.listDirectRepositoryFilesForApi(...a),
}));
vi.mock("../hosting-organization", () => ({
	requireHostingOrganizationId: (...a: unknown[]) =>
		m.requireHostingOrganizationId(...a),
}));
vi.mock("../../../../../orpc/middleware/project-visibility", () => ({
	projectNotFoundUnlessVisible: {},
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder = {
		use: (middleware: unknown) => {
			m.handlers.middlewares = [
				...((m.handlers.middlewares as unknown as unknown[]) ?? []),
				middleware,
			] as never;
			return builder;
		},
		route: () => builder,
		input: () => builder,
		handler: (fn: (...a: unknown[]) => unknown) => {
			m.handlers.report = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: (permission: string) => ({ permission }),
		Permissions: { INSTRUCTION_READ: "instruction:read" },
	};
});

import "../get-plugin-report";

const call = (projectId = "proj-1") =>
	m.handlers.report!({
		input: { projectId },
		context: { user: { id: "user-1" } },
		signal: undefined,
	}) as Promise<{
		state: string;
		mode: string;
		carriedCount: number;
		rulesCount: number;
		leftOutCount: number;
		leftOut: Array<{ path: string; reason: string }>;
		truncated: boolean;
	}>;

const row = (path: string, extra: Record<string, unknown> = {}) => ({
	path,
	size: 10,
	isText: true,
	...extra,
});

beforeEach(() => {
	for (const [key, mock] of Object.entries(m)) {
		if (key !== "handlers") {
			(mock as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	m.requireHostingOrganizationId.mockResolvedValue("org-host");
	m.resolveCurrentInstructionSource.mockResolvedValue({
		sourceOfTruth: "UPLOAD",
		repository: null,
	});
});

describe("projects.instructions.getPluginReport", () => {
	it("requires INSTRUCTION_READ behind the project's visibility, like getPublished", () => {
		expect(m.handlers.middlewares).toEqual([
			{},
			{ permission: "instruction:read" },
		]);
	});

	describe("a project with uploaded or synced instructions", () => {
		beforeEach(() => {
			m.getPublishedInstructionSnapshot.mockResolvedValue({
				id: "snap-1",
				organizationId: "org-host",
			});
		});

		it("counts what the plugin carries and lists what it leaves out, with the reason", async () => {
			m.listInstructionFiles.mockResolvedValue([
				row("CLAUDE.md"),
				row("skills/deploy/SKILL.md"),
				row(".claude/agents/reviewer.md"),
				row("rules/style.md"),
				row("docs/guide.md"),
				row("skills/loose.md"),
				row("skills/deploy/logo.png", { isText: false }),
			]);

			const report = await call();

			expect(m.listInstructionFiles).toHaveBeenCalledWith(
				"snap-1",
				"org-host",
			);
			expect(report).toEqual({
				state: "ready",
				mode: "UPLOAD",
				carriedCount: 3,
				rulesCount: 1,
				leftOutCount: 3,
				leftOut: [
					{ path: "docs/guide.md", reason: "outside-plugin-folders" },
					{ path: "skills/deploy/logo.png", reason: "not-text" },
					{ path: "skills/loose.md", reason: "skill-needs-folder" },
				],
				truncated: false,
			});
		});

		it("does not call a memory file left out because the other tool uses it", async () => {
			m.listInstructionFiles.mockResolvedValue([
				row("CLAUDE.md"),
				row("AGENTS.md"),
			]);

			const report = await call();

			expect(report.leftOut).toEqual([]);
			expect(report.carriedCount).toBe(1);
		});

		it("caps the list at 200 and says it was cut, keeping the true count", async () => {
			m.listInstructionFiles.mockResolvedValue(
				Array.from({ length: 450 }, (_, i) =>
					row(`docs/${String(i).padStart(4, "0")}.md`),
				),
			);

			const report = await call();

			expect(report.leftOut).toHaveLength(200);
			expect(report.leftOutCount).toBe(450);
			expect(report.truncated).toBe(true);
			expect(report.leftOut[0]?.path).toBe("docs/0000.md");
		});

		it("answers nothing-published when there is no snapshot", async () => {
			m.getPublishedInstructionSnapshot.mockResolvedValue(null);

			expect(await call()).toMatchObject({
				state: "nothing-published",
				carriedCount: 0,
				leftOut: [],
			});
			expect(m.listInstructionFiles).not.toHaveBeenCalled();
		});

		it("answers a snapshot of another organization as nothing published, and reads none of its files", async () => {
			m.getPublishedInstructionSnapshot.mockResolvedValue({
				id: "snap-other",
				organizationId: "org-other",
			});

			expect(await call()).toMatchObject({ state: "nothing-published" });
			expect(m.listInstructionFiles).not.toHaveBeenCalled();
		});
	});

	describe("a project that reads its repository directly", () => {
		beforeEach(() => {
			m.resolveCurrentInstructionSource.mockResolvedValue({
				sourceOfTruth: "REPOSITORY",
				repository: {},
			});
		});

		it("reports from the repository listing at the pinned commit, not from a snapshot", async () => {
			m.listDirectRepositoryFilesForApi.mockResolvedValue({
				generation: 1,
				commitSha: "a".repeat(40),
				incomplete: false,
				refusal: null,
				files: [
					{ path: "CLAUDE.md", size: 5 },
					{ path: ".claude/skills/a/SKILL.md", size: 5 },
					{ path: "notes/todo.md", size: 5 },
				],
			});

			const report = await call();

			expect(m.listDirectRepositoryFilesForApi).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "proj-1",
					userId: "user-1",
				}),
			);
			expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
			expect(report).toMatchObject({
				state: "ready",
				mode: "REPOSITORY",
				carriedCount: 2,
				leftOut: [
					{ path: "notes/todo.md", reason: "outside-plugin-folders" },
				],
			});
		});

		it.each([
			["incomplete", { incomplete: true, refusal: null }],
			["refused", { incomplete: false, refusal: "LIMIT" }],
		])(
			"answers unavailable for a listing that is %s, rather than report from part of the tree",
			async (_name, listing) => {
				m.listDirectRepositoryFilesForApi.mockResolvedValue({
					generation: 1,
					commitSha: "a".repeat(40),
					files: [],
					...listing,
				});

				expect(await call()).toMatchObject({
					state: "unavailable",
					mode: "REPOSITORY",
					leftOut: [],
				});
			},
		);
	});
});
