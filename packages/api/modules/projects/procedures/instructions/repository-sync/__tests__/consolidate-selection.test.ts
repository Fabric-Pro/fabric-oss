/**
 * "Move AI files out": the preview groups each plan file as development or
 * product (files that ship with the repository's own plugin stay unselected),
 * and the start moves only the person's selection, refuses paths outside the
 * plan, and records the plan files left behind as kept.
 *
 * The handlers run directly; the middleware chain and the authorization it
 * applies are pinned by `repository-sync-authz.test.ts`. The database,
 * provider reads, GitHub and Temporal are mocked; the plan and the product
 * detection (`@repo/instructions`) are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	listRepositoryTree: vi.fn(),
	readRepositoryFile: vi.fn(),
	createGitHubRepository: vi.fn(),
	createProjectRepoIntegration: vi.fn(),
	createInstructionConsolidation: vi.fn(),
	getKeptInstructionConsolidationPaths: vi.fn(),
	getLatestInstructionConsolidation: vi.fn(),
	getRunningInstructionConsolidation: vi.fn(),
	updateInstructionConsolidation: vi.fn(),
	getGitHubWorkflowCredential: vi.fn(),
	startInstructionConsolidationWorkflow: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/config", () => ({
	config: { mails: { from: "fabric@example.com" } },
}));
vi.mock("@repo/connectors", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/connectors")>(
			"@repo/connectors",
		);
	return {
		GITHUB_REPOSITORY_NAME_PATTERN: actual.GITHUB_REPOSITORY_NAME_PATTERN,
		isRepositoryTreeProvider: actual.isRepositoryTreeProvider,
		listRepositoryTree: m.listRepositoryTree,
		readRepositoryFile: m.readRepositoryFile,
		createGitHubRepository: m.createGitHubRepository,
	};
});
vi.mock("@repo/database", () => ({
	db: {},
	createInstructionConsolidation: m.createInstructionConsolidation,
	createProjectRepoIntegration: m.createProjectRepoIntegration,
	getKeptInstructionConsolidationPaths:
		m.getKeptInstructionConsolidationPaths,
	getLatestInstructionConsolidation: m.getLatestInstructionConsolidation,
	getRunningInstructionConsolidation: m.getRunningInstructionConsolidation,
	updateInstructionConsolidation: m.updateInstructionConsolidation,
}));
vi.mock("@repo/instructions", async () => ({
	...(await vi.importActual<typeof import("@repo/instructions")>(
		"@repo/instructions",
	)),
	renderDirectCommitText: () => ({
		ok: true,
		author: { name: "Fabric", email: "fabric@example.com" },
		committer: { name: "Fabric", email: "fabric@example.com" },
	}),
}));
vi.mock("@repo/integrations/github", () => ({
	getGitHubWorkflowCredential: m.getGitHubWorkflowCredential,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({})),
}));
vi.mock("@repo/temporal/instruction-consolidation-start", () => ({
	startInstructionConsolidationWorkflow:
		m.startInstructionConsolidationWorkflow,
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
	encryptApiKey: (v: string) => `enc:${v}`,
}));
vi.mock("../../../../../../lib/audit", () => ({
	recordAuditFromRequest: m.recordAuditFromRequest,
}));
vi.mock("../../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));
vi.mock("../../../../../../orpc/middleware/project-visibility", () => ({
	projectNotFoundUnlessVisible: vi.fn(),
}));
vi.mock("../../../../../../orpc/procedures", async () => {
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	function builder(schema?: unknown) {
		const b: Record<string, unknown> = {};
		b.use = () => b;
		b.route = () => b;
		b.input = (next: unknown) => builder(next);
		b.handler = (fn: unknown) => ({ handler: fn, inputSchema: schema });
		return b;
	}
	return {
		tenantProtectedProcedure: builder(),
		requireProjectPermission: vi.fn(),
		assertProjectPermission: vi.fn(async () => undefined),
		Permissions,
	};
});
vi.mock("../../hosting-organization", () => ({
	requireHostingOrganizationId: vi.fn(async () => "org-1"),
}));
vi.mock("../../migration-freeze", () => ({
	assertNoOpenMigration: vi.fn(async () => undefined),
}));
vi.mock("../repository", async () => ({
	repositoryReadError: (
		await vi.importActual<typeof import("../repository")>("../repository")
	).repositoryReadError,
	loadInstructionSyncIntegration: vi.fn(async () => ({
		id: "int-code",
		provider: "GITHUB",
		authMethod: "PAT",
		repositoryUrl: "https://github.com/example-org/example-product",
		repositoryOwner: "example-org",
		repositoryName: "example-product",
		defaultBranch: "main",
		azureOrganization: null,
	})),
	resolveInstructionSyncCredential: vi.fn(async () => ({
		token: "token",
		refreshFault: null,
	})),
}));

import {
	chooseConsolidationFiles,
	previewConsolidationProcedure,
	startConsolidationProcedure,
} from "../consolidate";

type Built = {
	handler: (args: { input: unknown; context: unknown }) => Promise<unknown>;
	inputSchema: { parse(v: unknown): unknown };
};
const context = {
	user: { id: "user-1", name: "Example Member", email: "dev@example.com" },
	session: { id: "sess-1", activeOrganizationId: "org-1" },
};
async function call(procedure: unknown, input: Record<string, unknown>) {
	const built = procedure as Built;
	return (await built.handler({
		input: built.inputSchema.parse(input),
		context,
	})) as Record<string, unknown>;
}

const TREE = [
	".claude-plugin/plugin.json",
	".claude-plugin/marketplace.json",
	".claude/skills/example-product-setup/SKILL.md",
	".claude/rules/git.md",
	".agents/skills/example-product-query/SKILL.md",
	"AGENTS.md",
	"CLAUDE.md",
	"ai/build.mjs",
];
const TEXTS: Record<string, string> = {
	".claude-plugin/plugin.json": JSON.stringify({
		name: "example-product",
		skills: ["./.claude/skills/"],
	}),
	".claude-plugin/marketplace.json": JSON.stringify({
		plugins: [{ name: "example-product", source: "./" }],
	}),
	".agents/skills/example-product-query/SKILL.md":
		"<!-- generated by ai/build.mjs; do not edit -->\n# Query\n",
	".claude/rules/git.md": "# Git\n",
	"CLAUDE.md": "# Claude\n",
};

beforeEach(() => {
	vi.clearAllMocks();
	m.listRepositoryTree.mockResolvedValue({
		ok: true,
		truncated: false,
		entries: TREE.map((path) => ({ path, type: "file", mode: "100644" })),
	});
	m.readRepositoryFile.mockImplementation(
		async ({ path }: { path: string }) =>
			path in TEXTS
				? {
						ok: true,
						state: "found",
						bytes: new TextEncoder().encode(TEXTS[path]),
					}
				: { ok: true, state: "absent" },
	);
	m.getKeptInstructionConsolidationPaths.mockResolvedValue([]);
	m.getRunningInstructionConsolidation.mockResolvedValue(null);
	m.getGitHubWorkflowCredential.mockResolvedValue({
		token: "stored",
		kind: "pat",
	});
	m.createGitHubRepository.mockResolvedValue({
		ok: true,
		repository: {
			url: "https://github.com/example-org/example-product-ai-instructions",
			owner: "example-org",
			name: "example-product-ai-instructions",
			defaultBranch: "main",
		},
	});
	m.createProjectRepoIntegration.mockResolvedValue({ id: "int-target" });
	m.createInstructionConsolidation.mockImplementation(async (row) => ({
		id: "run-1",
		status: "RUNNING",
		step: "CREATED",
		fileCount: row.files.length,
		targetRepositoryUrl: row.targetRepositoryUrl,
		cleanupPullRequestUrl: null,
		error: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	}));
});

const startInput = (include: string[]) => ({
	projectId: "proj-1",
	repositoryIntegrationId: "int-code",
	repository: {
		owner: "example-org",
		name: "example-product-ai-instructions",
	},
	include,
});

describe("previewConsolidation", () => {
	it("groups plugin and generated files as product, unselected, with a reason", async () => {
		const result = await call(previewConsolidationProcedure, {
			projectId: "proj-1",
			repositoryIntegrationId: "int-code",
		});
		const files = result.files as Array<{
			path: string;
			group: string;
			selected: boolean;
			reason?: string;
		}>;
		const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
		expect(
			byPath[".claude/skills/example-product-setup/SKILL.md"],
		).toMatchObject({
			group: "product",
			selected: false,
			reason: "used by .claude-plugin/plugin.json (skills)",
		});
		expect(
			byPath[".agents/skills/example-product-query/SKILL.md"],
		).toMatchObject({
			group: "product",
			selected: false,
			reason: expect.stringMatching(/generated by ai\/build\.mjs/),
		});
		expect(byPath["AGENTS.md"]).toMatchObject({
			group: "product",
			selected: false,
		});
		expect(byPath[".claude/rules/git.md"]).toMatchObject({
			group: "development",
			selected: true,
		});
		expect(byPath["CLAUDE.md"]).toMatchObject({
			group: "development",
			selected: true,
		});
		// The manifests themselves are never part of the plan.
		expect(byPath[".claude-plugin/plugin.json"]).toBeUndefined();
	});

	it("offers files kept on an earlier move as product", async () => {
		m.getKeptInstructionConsolidationPaths.mockResolvedValue(["CLAUDE.md"]);
		const result = await call(previewConsolidationProcedure, {
			projectId: "proj-1",
			repositoryIntegrationId: "int-code",
		});
		const claude = (
			result.files as Array<{
				path: string;
				group: string;
				selected: boolean;
			}>
		).find((f) => f.path === "CLAUDE.md");
		expect(claude).toMatchObject({ group: "product", selected: false });
		expect(m.getKeptInstructionConsolidationPaths).toHaveBeenCalledWith(
			"proj-1",
		);
	});

	it("fails rather than guess when a manifest cannot be read", async () => {
		m.readRepositoryFile.mockResolvedValue({
			ok: false,
			outcome: "unreachable",
		});
		await expect(
			call(previewConsolidationProcedure, {
				projectId: "proj-1",
				repositoryIntegrationId: "int-code",
			}),
		).rejects.toMatchObject({
			message: expect.stringMatching(
				/Couldn't read \.claude-plugin\/marketplace\.json/,
			),
		});
	});
});

describe("startConsolidation", () => {
	it("moves only the selection and records the rest as kept", async () => {
		await call(
			startConsolidationProcedure,
			startInput([".claude/rules/git.md", "CLAUDE.md"]),
		);
		const row = m.createInstructionConsolidation.mock.calls[0]?.[0];
		expect(row.files.map((f: { from: string }) => f.from)).toEqual([
			".claude/rules/git.md",
			"CLAUDE.md",
		]);
		expect(row.keptPaths).toEqual([
			".agents/skills/example-product-query/SKILL.md",
			".claude/skills/example-product-setup/SKILL.md",
			"AGENTS.md",
		]);
		expect(m.startInstructionConsolidationWorkflow).toHaveBeenCalledTimes(
			1,
		);
	});

	it("refuses a selection outside the plan and starts nothing", async () => {
		await expect(
			call(
				startConsolidationProcedure,
				startInput([
					".claude/rules/git.md",
					".claude-plugin/plugin.json",
				]),
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "SELECTION_NOT_IN_PLAN" },
		});
		expect(m.createGitHubRepository).not.toHaveBeenCalled();
		expect(m.createInstructionConsolidation).not.toHaveBeenCalled();
	});
});

describe("chooseConsolidationFiles", () => {
	const items = [
		{ from: "a.md", to: "a.md" },
		{ from: "b.md", to: "b.md" },
	] as Parameters<typeof chooseConsolidationFiles>[0];

	it("keeps every unselected plan file", () => {
		expect(chooseConsolidationFiles(items, ["b.md"])).toEqual({
			chosen: [items[1]],
			kept: ["a.md"],
		});
	});
});
