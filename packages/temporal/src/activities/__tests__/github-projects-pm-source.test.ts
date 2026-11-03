/**
 * GitHub Projects as a PM tool: `resolvePmSource` acts through the caller's
 * own GitHub connection for the `github-remote` PM selection, and
 * `callPmToolWithFallback` routes its logical calls to the GitHub Projects
 * adapter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	getGitHubWorkflowCredential: vi.fn(),
	listGitHubProjectItemsForPM: vi.fn(),
	getGitHubProjectItemForPM: vi.fn(),
	createGitHubProjectItemFromStory: vi.fn(),
	updateGitHubProjectItemFromStory: vi.fn(),
	isProjectReadOnly: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { mCPServer: { findUnique: mocks.findUnique } },
	isProjectReadOnly: mocks.isProjectReadOnly,
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
}));

vi.mock("@repo/integrations/github", () => ({
	getGitHubWorkflowCredential: mocks.getGitHubWorkflowCredential,
}));

vi.mock("@repo/integrations/github/projects-pm-adapter", async () => {
	const actual = await vi.importActual<
		typeof import("@repo/integrations/github/projects-pm-adapter")
	>("@repo/integrations/github/projects-pm-adapter");
	return {
		...actual,
		listGitHubProjectItemsForPM: mocks.listGitHubProjectItemsForPM,
		getGitHubProjectItemForPM: mocks.getGitHubProjectItemForPM,
		createGitHubProjectItemFromStory:
			mocks.createGitHubProjectItemFromStory,
		updateGitHubProjectItemFromStory:
			mocks.updateGitHubProjectItemFromStory,
	};
});

vi.mock("@repo/integrations/gitlab", () => ({
	GITLAB_REST_CAPABILITIES: { hasPMCapabilities: true },
	GitLabPmOriginMismatchError: class extends Error {},
}));
vi.mock("@repo/integrations/gitlab/pm-adapter", () => ({}));

import { PMSourceNotFound, resolvePmSource } from "../pm-source";
import { callPmToolWithFallback } from "../pm-tool-fallback";

const GITHUB_SOURCE = {
	kind: "rest-github" as const,
	token: "tok",
	projectId: "PVT_board",
	repository: "example-org/app",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findUnique.mockResolvedValue({ key: "github-remote" });
	mocks.isProjectReadOnly.mockResolvedValue(false);
});

describe("resolvePmSource — GitHub Projects", () => {
	it("resolves the caller's own connection in the given organization", async () => {
		mocks.getGitHubWorkflowCredential.mockResolvedValue({
			kind: "oauth",
			token: "tok",
		});

		const source = await resolvePmSource({
			mcpServerId: "srv_github",
			mcpConfigId: null,
			userId: "u_1",
			organizationId: "org_1",
			containerId: "PVT_board",
			additionalContext: { githubRepository: "example-org/app" },
		});

		expect(source).toEqual(GITHUB_SOURCE);
		expect(mocks.getGitHubWorkflowCredential).toHaveBeenCalledWith(
			"u_1",
			"org_1",
		);
	});

	it("is not resolvable without a GitHub connection", async () => {
		mocks.getGitHubWorkflowCredential.mockResolvedValue(null);
		await expect(
			resolvePmSource({
				mcpServerId: "srv_github",
				mcpConfigId: null,
				userId: "u_1",
				organizationId: "org_1",
				containerId: "PVT_board",
				additionalContext: null,
			}),
		).rejects.toMatchObject({ reason: "no-integration" });
	});

	it("is not resolvable without a board", async () => {
		const error = await resolvePmSource({
			mcpServerId: "srv_github",
			mcpConfigId: null,
			userId: "u_1",
			organizationId: null,
			containerId: null,
			additionalContext: null,
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(PMSourceNotFound);
		expect(mocks.getGitHubWorkflowCredential).not.toHaveBeenCalled();
	});
});

describe("callPmToolWithFallback — GitHub Projects", () => {
	it("routes each logical call to the GitHub Projects adapter", async () => {
		mocks.listGitHubProjectItemsForPM.mockResolvedValue({ items: [] });
		mocks.getGitHubProjectItemForPM.mockResolvedValue({ title: "x" });
		mocks.createGitHubProjectItemFromStory.mockResolvedValue({
			externalId: "example-org/app#1",
		});
		mocks.updateGitHubProjectItemFromStory.mockResolvedValue({
			externalId: "example-org/app#1",
		});
		const base = {
			source: GITHUB_SOURCE,
			userId: "u_1",
			organizationId: "org_1",
		};

		await callPmToolWithFallback({
			...base,
			call: { tool: "listWorkItems", filters: { page: 2, pageSize: 50 } },
		});
		await callPmToolWithFallback({
			...base,
			call: { tool: "fetchItem", externalId: "example-org/app#1" },
		});
		await callPmToolWithFallback({
			...base,
			fabricProjectId: "p_1",
			call: { tool: "createItem", payload: { title: "New" } },
		});
		await callPmToolWithFallback({
			...base,
			fabricProjectId: "p_1",
			call: {
				tool: "updateItem",
				externalId: "example-org/app#1",
				payload: { title: "Edit" },
			},
		});

		expect(mocks.listGitHubProjectItemsForPM).toHaveBeenCalledWith(
			expect.objectContaining({
				source: GITHUB_SOURCE,
				page: 2,
				pageSize: 50,
			}),
		);
		expect(mocks.getGitHubProjectItemForPM).toHaveBeenCalledWith({
			source: GITHUB_SOURCE,
			externalId: "example-org/app#1",
		});
		expect(mocks.createGitHubProjectItemFromStory).toHaveBeenCalledWith(
			expect.objectContaining({ payload: { title: "New" } }),
		);
		expect(mocks.updateGitHubProjectItemFromStory).toHaveBeenCalledWith(
			expect.objectContaining({
				externalId: "example-org/app#1",
				payload: { title: "Edit" },
			}),
		);
	});

	it("refuses a write on a read-only project before calling GitHub", async () => {
		mocks.isProjectReadOnly.mockResolvedValue(true);
		await expect(
			callPmToolWithFallback({
				source: GITHUB_SOURCE,
				userId: "u_1",
				organizationId: "org_1",
				fabricProjectId: "p_1",
				call: { tool: "createItem", payload: { title: "New" } },
			}),
		).rejects.toThrow();
		expect(mocks.createGitHubProjectItemFromStory).not.toHaveBeenCalled();
	});
});
