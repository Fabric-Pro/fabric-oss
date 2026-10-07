/**
 * What a direct repository read costs, and what the commit-addressed caches
 * must never change. The database, the credential resolver and the
 * `@repo/connectors` reads are mocked and counted; `direct-source`,
 * `direct-read`, `direct-query` and `direct-cache` are real. Every
 * identifier is synthetic.
 */
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	hasProjectAccess: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	getInstructionRepositorySync: vi.fn(),
	getProjectRepoIntegration: vi.fn(),
	resolveFreshRepoTokenForRow: vi.fn(),
	requireHostingOrganizationId: vi.fn(),
	assertProjectPermission: vi.fn(),
	resolveRepositoryBranchHead: vi.fn(),
	isCommitOnBranch: vi.fn(),
	readRepositoryFileAtCommit: vi.fn(),
	listRepositoryTreeAtCommit: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(),
	getProjectInstructionSettings: m.getProjectInstructionSettings,
	getInstructionRepositorySync: m.getInstructionRepositorySync,
	getProjectRepoIntegration: m.getProjectRepoIntegration,
	hasProjectAccess: m.hasProjectAccess,
}));
vi.mock("@repo/connectors", () => ({
	resolveRepositoryBranchHead: m.resolveRepositoryBranchHead,
	isCommitOnBranch: m.isCommitOnBranch,
	readRepositoryFileAtCommit: m.readRepositoryFileAtCommit,
	listRepositoryTreeAtCommit: m.listRepositoryTreeAtCommit,
}));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: m.resolveFreshRepoTokenForRow,
}));
vi.mock("../../hosting-organization", () => ({
	requireHostingOrganizationId: m.requireHostingOrganizationId,
}));
vi.mock("../../../../../../orpc/procedures", () => ({
	assertProjectPermission: m.assertProjectPermission,
	Permissions: { INSTRUCTION_READ: "instruction:read" },
}));

import { resetDirectRepositoryCaches } from "../direct-cache";
import {
	getDirectRepositoryFileForApi,
	listDirectRepositoryFilesForApi,
} from "../direct-query";

const SHA = "a".repeat(40);
const TOKEN = "token-for-direct-cache-test";

const integration = {
	id: "integration-1",
	projectId: "project-1",
	status: "ACTIVE",
	provider: "GITHUB",
	authMethod: "PAT",
	encryptedAccessToken: null,
	encryptedRefreshToken: null,
	encryptedPat: "ciphertext",
	tokenExpiresAt: null,
	updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	repositoryUrl: "https://github.com/example-org/instructions",
	repositoryOwner: "example-org",
	repositoryName: "instructions",
	azureOrganization: null,
};

const sync = {
	repositoryIntegrationId: integration.id,
	generation: 7,
	ref: "main",
	rootPath: "",
};

const read = {
	projectId: "project-1",
	userId: "user-1",
	generation: 7,
	commitSha: SHA,
};
const fileRead = { ...read, path: "AGENTS.md" };

const providerCalls = () =>
	m.isCommitOnBranch.mock.calls.length +
	m.readRepositoryFileAtCommit.mock.calls.length +
	m.listRepositoryTreeAtCommit.mock.calls.length;

beforeEach(() => {
	vi.resetAllMocks();
	resetDirectRepositoryCaches();
	m.requireHostingOrganizationId.mockResolvedValue("org-1");
	m.hasProjectAccess.mockResolvedValue(true);
	m.assertProjectPermission.mockResolvedValue({ organizationId: "org-1" });
	m.getProjectInstructionSettings.mockResolvedValue({
		sourceOfTruth: "REPOSITORY",
		ignoreGlobs: null,
		migration: null,
	});
	m.getInstructionRepositorySync.mockResolvedValue(sync);
	m.getProjectRepoIntegration.mockResolvedValue(integration);
	m.resolveFreshRepoTokenForRow.mockResolvedValue({
		token: TOKEN,
		refreshFault: null,
		credentialFault: null,
	});
	m.isCommitOnBranch.mockResolvedValue({ ok: true, onBranch: true });
	m.readRepositoryFileAtCommit.mockImplementation(
		async (request: { path: string }) =>
			request.path.endsWith(".fabricignore")
				? { ok: true, state: "absent" }
				: {
						ok: true,
						state: "found",
						bytes: new TextEncoder().encode("rules\n"),
					},
	);
	m.listRepositoryTreeAtCommit.mockResolvedValue({
		ok: true,
		truncated: false,
		entries: [{ type: "file", path: "AGENTS.md", regular: true }],
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("provider calls per direct read", () => {
	it("getFile: three provider calls cold, none warm, with one credential resolution each", async () => {
		await getDirectRepositoryFileForApi(fileRead);
		expect(providerCalls()).toBe(3);
		expect(m.resolveFreshRepoTokenForRow).toHaveBeenCalledTimes(1);

		m.isCommitOnBranch.mockClear();
		m.readRepositoryFileAtCommit.mockClear();
		const warm = await getDirectRepositoryFileForApi(fileRead);

		expect(providerCalls()).toBe(0);
		expect(warm.read).toMatchObject({ state: "found", text: "rules\n" });
		expect(m.resolveFreshRepoTokenForRow).toHaveBeenCalledTimes(2);
	});

	it("listFiles: three provider calls cold, none warm", async () => {
		await listDirectRepositoryFilesForApi(read);
		expect(providerCalls()).toBe(3);

		m.isCommitOnBranch.mockClear();
		m.readRepositoryFileAtCommit.mockClear();
		m.listRepositoryTreeAtCommit.mockClear();
		const warm = await listDirectRepositoryFilesForApi(read);

		expect(providerCalls()).toBe(0);
		expect(warm.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
	});

	it("another file at the same commit costs only its own read", async () => {
		await getDirectRepositoryFileForApi(fileRead);
		m.isCommitOnBranch.mockClear();
		m.readRepositoryFileAtCommit.mockClear();

		await getDirectRepositoryFileForApi({ ...fileRead, path: "CLAUDE.md" });

		expect(m.isCommitOnBranch).not.toHaveBeenCalled();
		expect(m.readRepositoryFileAtCommit).toHaveBeenCalledTimes(1);
	});

	it("asks again after a negative branch answer", async () => {
		m.isCommitOnBranch.mockResolvedValue({ ok: true, onBranch: false });
		await expect(
			getDirectRepositoryFileForApi(fileRead),
		).rejects.toMatchObject({ data: { code: "COMMIT_NOT_FOUND" } });
		m.isCommitOnBranch.mockResolvedValue({ ok: true, onBranch: true });
		m.isCommitOnBranch.mockClear();

		await getDirectRepositoryFileForApi(fileRead);

		expect(m.isCommitOnBranch).toHaveBeenCalledTimes(1);
	});

	it("asks again after a failed read", async () => {
		m.readRepositoryFileAtCommit.mockImplementation(async () => ({
			ok: false,
			outcome: "unreachable",
		}));
		await expect(
			getDirectRepositoryFileForApi(fileRead),
		).rejects.toBeDefined();
		m.readRepositoryFileAtCommit.mockClear();
		m.readRepositoryFileAtCommit.mockResolvedValue({
			ok: true,
			state: "absent",
		});

		await getDirectRepositoryFileForApi(fileRead);

		expect(m.readRepositoryFileAtCommit).toHaveBeenCalledTimes(2);
	});
});

describe("cache keys and authorization", () => {
	it("never reuses one repository's answers for another integration", async () => {
		await listDirectRepositoryFilesForApi(read);
		m.getProjectRepoIntegration.mockResolvedValue({
			...integration,
			id: "integration-2",
			repositoryName: "other",
		});
		m.getInstructionRepositorySync.mockResolvedValue({
			...sync,
			repositoryIntegrationId: "integration-2",
		});
		m.isCommitOnBranch.mockClear();
		m.readRepositoryFileAtCommit.mockClear();
		m.listRepositoryTreeAtCommit.mockClear();

		await listDirectRepositoryFilesForApi({
			...read,
			projectId: "project-2",
		});

		expect(providerCalls()).toBe(3);
	});

	it("never reuses answers across organizations that share an integration id", async () => {
		await listDirectRepositoryFilesForApi(read);
		m.requireHostingOrganizationId.mockResolvedValue("org-2");
		m.isCommitOnBranch.mockClear();
		m.readRepositoryFileAtCommit.mockClear();
		m.listRepositoryTreeAtCommit.mockClear();

		await listDirectRepositoryFilesForApi(read);

		expect(providerCalls()).toBe(3);
	});

	it("refuses a caller who lost read permission even when every answer is cached", async () => {
		await getDirectRepositoryFileForApi(fileRead);
		m.assertProjectPermission.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "No permission" }),
		);
		m.readRepositoryFileAtCommit.mockClear();
		m.isCommitOnBranch.mockClear();

		await expect(
			getDirectRepositoryFileForApi(fileRead),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(providerCalls()).toBe(0);
	});

	it("refuses a caller who lost project visibility on a cache hit", async () => {
		await getDirectRepositoryFileForApi(fileRead);
		m.hasProjectAccess.mockResolvedValue(false);

		await expect(
			getDirectRepositoryFileForApi(fileRead),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("still refuses a stale generation on a cache hit", async () => {
		await getDirectRepositoryFileForApi(fileRead);

		await expect(
			getDirectRepositoryFileForApi({ ...fileRead, generation: 6 }),
		).rejects.toMatchObject({
			data: { code: "REPOSITORY_CONFIGURATION_CHANGED" },
		});
	});
});

describe("concurrent provider calls keep their failure order", () => {
	it("reports a commit that is not on the branch ahead of a failing read", async () => {
		m.isCommitOnBranch.mockResolvedValue({ ok: true, onBranch: false });
		m.readRepositoryFileAtCommit.mockResolvedValue({
			ok: false,
			outcome: "unauthorized",
		});

		await expect(
			getDirectRepositoryFileForApi(fileRead),
		).rejects.toMatchObject({ data: { code: "COMMIT_NOT_FOUND" } });
	});

	it("returns nothing of a commit that is not on the branch, though it was read beside the check", async () => {
		m.isCommitOnBranch.mockResolvedValue({ ok: true, onBranch: false });

		await expect(
			listDirectRepositoryFilesForApi(read),
		).rejects.toMatchObject({ data: { code: "COMMIT_NOT_FOUND" } });
	});

	it("reports an ignore-file failure ahead of the file read's", async () => {
		m.readRepositoryFileAtCommit.mockImplementation(
			async (request: { path: string }) =>
				request.path.endsWith(".fabricignore")
					? { ok: false, outcome: "unreachable" }
					: { ok: false, outcome: "unauthorized" },
		);

		await expect(
			getDirectRepositoryFileForApi(fileRead),
		).rejects.toMatchObject({
			message: expect.stringContaining("reach the repository"),
		});
		expect(m.readRepositoryFileAtCommit).toHaveBeenCalledTimes(2);
	});

	it("does not return a file the ignore rules hide, though it was read beside them", async () => {
		m.readRepositoryFileAtCommit.mockImplementation(
			async (request: { path: string }) =>
				request.path.endsWith(".fabricignore")
					? {
							ok: true,
							state: "found",
							bytes: new TextEncoder().encode("AGENTS.md\n"),
						}
					: {
							ok: true,
							state: "found",
							bytes: new TextEncoder().encode("secret\n"),
						},
		);

		await expect(
			getDirectRepositoryFileForApi(fileRead),
		).rejects.toMatchObject({
			data: { code: "REPOSITORY_FILE_NOT_FOUND" },
		});
	});
});

describe("the end-of-read currency check", () => {
	it("catches a generation change that happens during the read", async () => {
		m.readRepositoryFileAtCommit.mockImplementation(async () => {
			m.getInstructionRepositorySync.mockResolvedValue({
				...sync,
				generation: 8,
			});
			return { ok: true, state: "absent" };
		});

		await expect(
			getDirectRepositoryFileForApi(fileRead),
		).rejects.toMatchObject({
			data: { code: "REPOSITORY_CONFIGURATION_CHANGED" },
		});
	});

	it("catches a replaced integration during the read even when the answers were cached", async () => {
		await getDirectRepositoryFileForApi(fileRead);
		m.getProjectRepoIntegration
			.mockResolvedValueOnce(integration)
			.mockResolvedValue({ ...integration, id: "integration-9" });

		await expect(
			getDirectRepositoryFileForApi(fileRead),
		).rejects.toMatchObject({
			data: { code: "REPOSITORY_CONFIGURATION_CHANGED" },
		});
	});

	it("catches a permission revoked during the read", async () => {
		m.readRepositoryFileAtCommit.mockImplementation(async () => {
			m.hasProjectAccess.mockResolvedValue(false);
			return { ok: true, state: "absent" };
		});

		await expect(
			getDirectRepositoryFileForApi(fileRead),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("does not resolve the credential a second time to check", async () => {
		await listDirectRepositoryFilesForApi(read);

		expect(m.resolveFreshRepoTokenForRow).toHaveBeenCalledTimes(1);
	});
});
