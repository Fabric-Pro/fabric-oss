/**
 * `fabric_get_workspace` / `fabric_query_workspace`: an `org_` key reaches only
 * its own organization's workspaces (Fizzy #2629).
 *
 * Workspace access is membership-based and answers only "can this user open
 * the workspace". A key minted in org-a by someone who is also a member of
 * org-b, with a role on one of org-b's workspaces, therefore passed it for
 * org-b's workspace — and the organization the handlers passed alongside was
 * ignored. The key names its tenant, so both tools must refuse it, as
 * not-found, before any read runs. The same person through a personal key
 * keeps what the app gives them.
 *
 * `@repo/database` and `@repo/rag` are mocked — the handlers reach them through
 * dynamic `await import(...)`, so the mock intercepts inside the handler body.
 * The database mocks keep the real layer's shape: `hasWorkspaceAccess` and
 * `getWorkspaceById` answer from the same access query and take no
 * organization, so a handler that fell back to either one would show up here
 * as a leak, not as a crash.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/workspace-tools
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ROW = {
	id: "ws-1",
	name: "Example knowledge base",
	description: "Indexed onboarding notes",
	status: "ACTIVE",
	type: "CUSTOM",
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-02T00:00:00Z"),
};

const mocks = vi.hoisted(() => ({
	getWorkspaceAccessContext: vi.fn(),
	generateEmbedding: vi.fn(),
	generateSparseVector: vi.fn(),
	searchWorkspaceChunks: vi.fn(),
}));

const databaseMocks = vi.hoisted(() => ({
	// Membership-only, like the real wrapper: it never sees an organization.
	hasWorkspaceAccess: vi.fn(
		async (workspaceId: string, userId: string) =>
			(await mocks.getWorkspaceAccessContext(workspaceId, userId)) !==
			null,
	),
	// The real query re-checks the same membership-only access internally.
	getWorkspaceById: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getWorkspaceAccessContext: mocks.getWorkspaceAccessContext,
	hasWorkspaceAccess: databaseMocks.hasWorkspaceAccess,
	getWorkspaceById: databaseMocks.getWorkspaceById,
}));

vi.mock("@repo/rag", () => ({
	generateEmbedding: mocks.generateEmbedding,
	generateSparseVector: mocks.generateSparseVector,
	searchWorkspaceChunks: mocks.searchWorkspaceChunks,
}));

import { executePlatformTool } from "../platform-tools";
import type { GatewaySession } from "../types";

const baseSession: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org-a",
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	credential: "personal-key",
	scopes: ["*"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

const orgKeyInA: GatewaySession = {
	...baseSession,
	credential: "organization-key",
};

const personalKeyInA: GatewaySession = {
	...baseSession,
	credential: "personal-key",
};

/** Parse the JSON payload a platform tool packs into its text content block. */
function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}

/** The workspace's hosting organization, as the access query reports it. */
function workspaceHostedBy(organizationId: string | null) {
	mocks.getWorkspaceAccessContext.mockResolvedValue({ organizationId });
}

beforeEach(() => {
	vi.clearAllMocks();
	databaseMocks.getWorkspaceById.mockImplementation(
		async (workspaceId: string, userId: string) =>
			(await mocks.getWorkspaceAccessContext(workspaceId, userId))
				? WORKSPACE_ROW
				: null,
	);
	mocks.generateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
	mocks.generateSparseVector.mockReturnValue({ indices: [], values: [] });
	mocks.searchWorkspaceChunks.mockResolvedValue([
		{
			documentId: "doc-1",
			filename: "onboarding.md",
			score: 0.91,
			chunkIndex: 0,
			pageNumber: 1,
			headings: ["Getting started"],
		},
	]);
});

describe("fabric_get_workspace binds an organization key to the workspace's organization", () => {
	it("refuses an org key on another organization's workspace as not found, without reading the row", async () => {
		// The key's creator is a member of org-b with a role on its workspace.
		workspaceHostedBy("org-b");

		const result = await executePlatformTool(
			"fabric_get_workspace",
			{ workspaceId: "ws-1" },
			orgKeyInA,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/not found or access denied/i);
		expect(result.content[0].text).not.toContain("Example knowledge base");
		expect(mocks.getWorkspaceAccessContext).toHaveBeenCalledWith(
			"ws-1",
			"user-1",
		);
		expect(databaseMocks.getWorkspaceById).not.toHaveBeenCalled();
	});

	it("lets the same member read it through a personal key", async () => {
		workspaceHostedBy("org-b");

		const result = await executePlatformTool(
			"fabric_get_workspace",
			{ workspaceId: "ws-1" },
			personalKeyInA,
		);

		expect(result.isError).toBeUndefined();
		expect(payload(result)).toMatchObject({
			id: "ws-1",
			name: "Example knowledge base",
		});
		expect(databaseMocks.getWorkspaceById).toHaveBeenCalledWith(
			"ws-1",
			"user-1",
		);
	});

	it("lets an org key read a workspace in its own organization", async () => {
		workspaceHostedBy("org-a");

		const result = await executePlatformTool(
			"fabric_get_workspace",
			{ workspaceId: "ws-1" },
			orgKeyInA,
		);

		expect(result.isError).toBeUndefined();
		expect(payload(result)).toMatchObject({ id: "ws-1" });
	});

	it("refuses an org key on a personal workspace", async () => {
		workspaceHostedBy(null);

		const result = await executePlatformTool(
			"fabric_get_workspace",
			{ workspaceId: "ws-1" },
			orgKeyInA,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/not found or access denied/i);
		expect(databaseMocks.getWorkspaceById).not.toHaveBeenCalled();
	});

	it("refuses a caller with no access at all, with the same message", async () => {
		mocks.getWorkspaceAccessContext.mockResolvedValue(null);

		const result = await executePlatformTool(
			"fabric_get_workspace",
			{ workspaceId: "ws-1" },
			personalKeyInA,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/not found or access denied/i);
		expect(databaseMocks.getWorkspaceById).not.toHaveBeenCalled();
	});
});

describe("fabric_query_workspace binds an organization key to the workspace's organization", () => {
	it("refuses an org key on another organization's workspace as not found, before embedding or searching", async () => {
		workspaceHostedBy("org-b");

		const result = await executePlatformTool(
			"fabric_query_workspace",
			{ workspaceId: "ws-1", query: "onboarding" },
			orgKeyInA,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/not found or access denied/i);
		expect(mocks.getWorkspaceAccessContext).toHaveBeenCalledWith(
			"ws-1",
			"user-1",
		);
		expect(mocks.generateEmbedding).not.toHaveBeenCalled();
		expect(mocks.searchWorkspaceChunks).not.toHaveBeenCalled();
	});

	it("lets the same member query it through a personal key", async () => {
		workspaceHostedBy("org-b");

		const result = await executePlatformTool(
			"fabric_query_workspace",
			{ workspaceId: "ws-1", query: "onboarding" },
			personalKeyInA,
		);

		expect(result.isError).toBeUndefined();
		expect(payload(result)).toMatchObject({
			query: "onboarding",
			totalResults: 1,
		});
		expect(mocks.searchWorkspaceChunks).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceId: "ws-1", userId: "user-1" }),
		);
	});

	it("lets an org key query a workspace in its own organization", async () => {
		workspaceHostedBy("org-a");

		const result = await executePlatformTool(
			"fabric_query_workspace",
			{ workspaceId: "ws-1", query: "onboarding" },
			orgKeyInA,
		);

		expect(result.isError).toBeUndefined();
		expect(mocks.generateEmbedding).toHaveBeenCalledWith("onboarding", {
			userId: "user-1",
			organizationId: "org-a",
		});
		expect(mocks.searchWorkspaceChunks).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "ws-1",
				organizationId: "org-a",
			}),
		);
	});

	it("refuses an org key on a personal workspace", async () => {
		workspaceHostedBy(null);

		const result = await executePlatformTool(
			"fabric_query_workspace",
			{ workspaceId: "ws-1", query: "onboarding" },
			orgKeyInA,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/not found or access denied/i);
		expect(mocks.generateEmbedding).not.toHaveBeenCalled();
		expect(mocks.searchWorkspaceChunks).not.toHaveBeenCalled();
	});

	it("refuses a caller with no access at all, with the same message", async () => {
		mocks.getWorkspaceAccessContext.mockResolvedValue(null);

		const result = await executePlatformTool(
			"fabric_query_workspace",
			{ workspaceId: "ws-1", query: "onboarding" },
			personalKeyInA,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/not found or access denied/i);
		expect(mocks.generateEmbedding).not.toHaveBeenCalled();
		expect(mocks.searchWorkspaceChunks).not.toHaveBeenCalled();
	});
});
