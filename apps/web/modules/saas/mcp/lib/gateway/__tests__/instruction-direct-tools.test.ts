import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getDirectRepositoryState: vi.fn(),
	listDirectRepositoryFilesForApi: vi.fn(),
	getDirectRepositoryFileForApi: vi.fn(),
	getProjectAccessContext: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	listInstructionFiles: vi.fn(),
	resolveInstructionSnapshotSource: vi.fn(),
	resolveCurrentInstructionRepository: vi.fn(),
	downloadFile: vi.fn(),
	buildInstructionSnapshotZip: vi.fn(),
	verifyOAuthAccessToken: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/api/modules/users/procedures/api-keys", () => ({
	verifyUserApiKey: vi.fn(),
}));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://fabric.example" }));
vi.mock("@saas/mcp/lib/record-cli-reach", () => ({
	recordCliReach: vi.fn(),
	toOAuthClientIdentity: (id: string) => ({ kind: "OAUTH_CLIENT", id }),
	toOrganizationKeyIdentity: (id: string) => ({
		kind: "ORGANIZATION_API_KEY",
		id,
	}),
	toUserKeyIdentity: (id: string) => ({ kind: "USER_API_KEY", id }),
}));
vi.mock("@saas/mcp/lib/record-organization-refusal", () => ({
	recordOrganizationRefusal: vi.fn(),
}));
vi.mock("@saas/mcp/lib/gateway/authority-service", () => ({
	enforceAuthority: vi.fn().mockResolvedValue({ authorized: true }),
	generateRequestFingerprint: vi
		.fn()
		.mockResolvedValue("fixture-fingerprint"),
	resolveProviderKeyFromToolPrefix: vi.fn(),
}));
vi.mock("@saas/mcp/lib/gateway", async () => {
	const store = await import("../session-store");
	const platform = await import("../platform-tools");
	return {
		...store,
		executePlatformTool: platform.executePlatformTool,
		executeConnectedServerTool: vi.fn(),
		getAggregatedTools: async () => ({
			tools: platform.PLATFORM_TOOL_DEFINITIONS,
			servers: [],
		}),
	};
});

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: m.getDirectRepositoryState,
	listDirectRepositoryFilesForApi: m.listDirectRepositoryFilesForApi,
	getDirectRepositoryFileForApi: m.getDirectRepositoryFileForApi,
}));

vi.mock("@repo/api/lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...args: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...args),
}));

vi.mock("@repo/database", () => ({
	verifyOAuthAccessToken: m.verifyOAuthAccessToken,
	isOrganizationLive: async () => true,
	hasPermission: (permissions: readonly string[], permission: string) =>
		permissions.includes(permission),
	Permissions: { INSTRUCTION_READ: "instruction:read" },
	getProjectAccessContext: m.getProjectAccessContext,
	getPublishedInstructionSnapshot: m.getPublishedInstructionSnapshot,
	listInstructionFiles: m.listInstructionFiles,
	resolveInstructionSnapshotSource: m.resolveInstructionSnapshotSource,
	resolveCurrentInstructionRepository: m.resolveCurrentInstructionRepository,
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ downloadFile: m.downloadFile }),
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));

vi.mock("@repo/api/modules/projects/procedures/instructions/build-zip", () => ({
	buildInstructionSnapshotZip: m.buildInstructionSnapshotZip,
}));

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
} from "../platform-tools";
import type { GatewaySession } from "../types";

const PROJECT = "project-1";
const SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);

const session: GatewaySession = {
	sessionId: "session-1",
	userId: "user-1",
	organizationId: "org-1",
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	credential: "organization-key",
	scopes: ["instructions:read"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

const repositoryState = {
	availability: "READY" as const,
	readState: "DIRECT" as const,
	generation: 7,
	currentCommitSha: SHA,
	ref: "main",
	rootPath: "",
	provider: "GITHUB" as const,
	repository: {
		provider: "GITHUB" as const,
		host: "github.com",
		path: "example-org/example-repository",
		cloneUrl: "https://github.com/example-org/example-repository.git",
	},
};

function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0]?.text ?? "{}") as Record<
		string,
		unknown
	>;
}

function toolDefinition(name: string) {
	const definition = PLATFORM_TOOL_DEFINITIONS.find(
		(tool) => tool.name === name,
	);
	if (!definition) {
		throw new Error(`missing ${name}`);
	}
	return definition;
}

beforeEach(() => {
	for (const fn of Object.values(m)) {
		fn.mockReset();
	}
	m.verifyOAuthAccessToken.mockResolvedValue({
		valid: true,
		tokenId: "token-1",
		clientRowId: "client-1",
		userId: "user-1",
		userName: "Fixture Agent",
		email: "agent@example.invalid",
		role: "user",
		organizationId: "org-1",
		projectId: PROJECT,
		audience: "mcp",
		scopes: ["mcp:read", "instructions:read"],
	});
	m.getProjectAccessContext.mockResolvedValue({ organizationId: "org-1" });
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ["instruction:read"],
		organizationId: "org-1",
	});
	m.getDirectRepositoryState.mockResolvedValue(repositoryState);
	m.listDirectRepositoryFilesForApi.mockResolvedValue({
		commitSha: SHA,
		generation: 7,
		incomplete: false,
		refusal: null,
		files: [
			{
				path: "AGENTS.md",
				kind: "INSTRUCTIONS",
				name: "AGENTS.md",
				description: null,
				size: 12,
			},
		],
	});
	m.getDirectRepositoryFileForApi.mockResolvedValue({
		commitSha: SHA,
		generation: 7,
		read: { state: "found", text: "abcdef", textLength: 6 },
	});
	m.resolveInstructionSnapshotSource.mockResolvedValue({
		source: "UPLOAD",
		repository: null,
	});
	m.resolveCurrentInstructionRepository.mockResolvedValue(null);
});

describe("direct repository instruction tools", () => {
	it("retrieves pinned repository content through the SDK Streamable HTTP client and actual endpoint", async () => {
		const { handleGatewayPost, handleGatewayGet, handleGatewayDelete } =
			await import("../../gateway-endpoint");
		const methods: string[] = [];
		const transport = new StreamableHTTPClientTransport(
			new URL(
				`https://fabric.example/api/mcp-gateway/projects/${PROJECT}`,
			),
			{
				requestInit: {
					headers: { authorization: "Bearer fat_fixture" },
				},
				fetch: async (resource, init) => {
					const request = new NextRequest(
						resource instanceof Request
							? resource
							: resource.toString(),
						init,
					);
					const binding = { projectId: PROJECT };
					if (request.method === "GET")
						return handleGatewayGet(request, binding);
					if (request.method === "DELETE")
						return handleGatewayDelete(request, binding);
					methods.push((await request.clone().json()).method);
					return handleGatewayPost(request, binding);
				},
			},
		);
		const client = new Client({
			name: "fabric-native-fixture",
			version: "1.0",
		});
		try {
			await client.connect(transport);
			const tools = await client.listTools();
			expect(tools.tools.map((tool) => tool.name)).toContain(
				"fabric_list_project_instructions",
			);
			expect(tools.tools.map((tool) => tool.name)).toContain(
				"fabric_get_project_instruction",
			);
			const list = await client.callTool({
				name: "fabric_list_project_instructions",
				arguments: { projectId: PROJECT },
			});
			const listText = list.content.find((item) => item.type === "text");
			if (!listText || listText.type !== "text")
				throw new Error("Missing instruction list response");
			const listed = JSON.parse(listText.text);
			expect(listed.direct).toMatchObject({
				generation: 7,
				commitSha: SHA,
			});
			const first = await client.callTool({
				name: "fabric_get_project_instruction",
				arguments: {
					projectId: PROJECT,
					path: "AGENTS.md",
					generation: listed.direct.generation,
					commitSha: listed.direct.commitSha,
					offset: 0,
					maxLength: 3,
				},
			});
			m.getDirectRepositoryState.mockResolvedValue({
				...repositoryState,
				currentCommitSha: NEXT_SHA,
			});
			const second = await client.callTool({
				name: "fabric_get_project_instruction",
				arguments: {
					projectId: PROJECT,
					path: "AGENTS.md",
					generation: listed.direct.generation,
					commitSha: listed.direct.commitSha,
					offset: 3,
					maxLength: 3,
				},
			});
			const read = [first, second].map((result) => {
				const text = result.content.find(
					(item) => item.type === "text",
				);
				if (!text || text.type !== "text")
					throw new Error("Missing instruction file response");
				return JSON.parse(text.text);
			});
			expect(read[0].body + read[1].body).toBe("abcdef");
			expect(
				read.every(
					(page) => page.commitSha === SHA && page.generation === 7,
				),
			).toBe(true);
			expect(methods).toEqual([
				"initialize",
				"notifications/initialized",
				"tools/list",
				"tools/call",
				"tools/call",
				"tools/call",
			]);
			expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
			expect(m.listInstructionFiles).not.toHaveBeenCalled();
			expect(m.downloadFile).not.toHaveBeenCalled();
		} finally {
			await transport.terminateSession();
			await client.close();
		}
	});
	it("routes list, file and bundle through direct reads without snapshots, storage or ZIP work", async () => {
		const list = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: PROJECT, generation: 7, commitSha: SHA },
			session,
		);
		expect(list.isError).toBeUndefined();
		expect(payload(list)).toMatchObject({
			snapshot: null,
			direct: { generation: 7, commitSha: SHA },
		});
		expect(m.listDirectRepositoryFilesForApi).toHaveBeenCalledWith({
			projectId: PROJECT,
			userId: "user-1",
			generation: 7,
			commitSha: SHA,
		});

		const file = await executePlatformTool(
			"fabric_get_project_instruction",
			{
				projectId: PROJECT,
				path: "AGENTS.md",
				generation: 7,
				commitSha: SHA,
			},
			session,
		);
		expect(file.isError).toBeUndefined();
		expect(payload(file)).toMatchObject({
			path: "AGENTS.md",
			body: "abcdef",
			generation: 7,
			commitSha: SHA,
		});
		expect(m.getDirectRepositoryFileForApi).toHaveBeenCalledWith({
			projectId: PROJECT,
			userId: "user-1",
			generation: 7,
			commitSha: SHA,
			path: "AGENTS.md",
		});

		const bundle = await executePlatformTool(
			"fabric_get_project_instruction_bundle",
			{ projectId: PROJECT },
			session,
		);
		expect(bundle.isError).toBeUndefined();
		expect(payload(bundle)).toMatchObject({
			snapshot: null,
			direct: { generation: 7, commitSha: SHA },
			checkout: { commitSha: SHA },
		});
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.listInstructionFiles).not.toHaveBeenCalled();
		expect(m.downloadFile).not.toHaveBeenCalled();
		expect(m.buildInstructionSnapshotZip).not.toHaveBeenCalled();
	});

	it("keeps a direct page pinned and refuses an unpinned continuation", async () => {
		const initialList = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: PROJECT },
			session,
		);
		expect(initialList.isError).toBeUndefined();
		expect(m.listDirectRepositoryFilesForApi).toHaveBeenLastCalledWith({
			projectId: PROJECT,
			userId: "user-1",
			generation: 7,
			commitSha: SHA,
		});

		m.getDirectRepositoryFileForApi.mockClear();
		await expect(
			executePlatformTool(
				"fabric_get_project_instruction",
				{ projectId: PROJECT, path: "AGENTS.md", offset: 3 },
				session,
			),
		).resolves.toMatchObject({ isError: true });
		expect(m.getDirectRepositoryFileForApi).not.toHaveBeenCalled();

		m.getDirectRepositoryState.mockResolvedValueOnce(repositoryState);
		m.getDirectRepositoryState.mockResolvedValueOnce({
			...repositoryState,
			currentCommitSha: NEXT_SHA,
		});
		const page = await executePlatformTool(
			"fabric_get_project_instruction",
			{
				projectId: PROJECT,
				path: "AGENTS.md",
				offset: 3,
				generation: 7,
				commitSha: SHA,
			},
			session,
		);
		expect(page.isError).toBeUndefined();
		expect(payload(page)).toMatchObject({ body: "def", commitSha: SHA });
		expect(m.getDirectRepositoryFileForApi).toHaveBeenLastCalledWith({
			projectId: PROJECT,
			userId: "user-1",
			generation: 7,
			commitSha: SHA,
			path: "AGENTS.md",
		});
	});

	it("refuses partial or mutable direct pins before a repository file read", async () => {
		for (const args of [
			{ projectId: PROJECT, path: "AGENTS.md", generation: 7 },
			{
				projectId: PROJECT,
				path: "AGENTS.md",
				generation: 7,
				commitSha: "main",
			},
		]) {
			const result = await executePlatformTool(
				"fabric_get_project_instruction",
				args,
				session,
			);
			expect(result.isError).toBe(true);
			expect(payload(result)).toMatchObject({
				error: "generation and a full lowercase commitSha must be provided together.",
			});
		}
		expect(m.getDirectRepositoryFileForApi).not.toHaveBeenCalled();
	});

	it("does not fall back to a snapshot when the direct repository is unavailable", async () => {
		m.getDirectRepositoryState.mockResolvedValue({
			availability: "CREDENTIALS_EXPIRED",
			readState: "DIRECT",
		});

		const result = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: PROJECT },
			session,
		);
		expect(result.isError).toBeUndefined();
		expect(payload(result)).toMatchObject({
			snapshot: null,
			files: [],
			direct: { availability: "CREDENTIALS_EXPIRED" },
		});
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("refuses if the gateway permission is revoked after the direct read", async () => {
		m.resolveEffectiveProjectPermissions
			.mockResolvedValueOnce({
				permissions: ["instruction:read"],
				organizationId: "org-1",
			})
			.mockResolvedValueOnce({
				permissions: ["instruction:read"],
				organizationId: "org-1",
			})
			.mockResolvedValueOnce(null);

		const result = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: PROJECT },
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result)).toEqual({
			error: "Project not found or access denied",
		});
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("refuses an organization key whose project host is outside its tenant", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org-2",
		});

		const result = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: PROJECT },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result)).toEqual({
			error: "Project not found or access denied",
		});
		expect(m.getDirectRepositoryState).not.toHaveBeenCalled();
		expect(m.listDirectRepositoryFilesForApi).not.toHaveBeenCalled();
	});

	it("allows a personal key to read a project where its owner is a guest", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org-2",
		});
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["instruction:read"],
			organizationId: "org-2",
		});

		const result = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: PROJECT },
			{ ...session, credential: "personal-key", organizationId: null },
		);

		expect(result.isError).toBeUndefined();
		expect(m.listDirectRepositoryFilesForApi).toHaveBeenCalledOnce();
	});

	it("refuses a project-bound credential when its requested project differs", async () => {
		const result = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: PROJECT },
			{ ...session, projectId: "another-project" },
		);

		expect(result.isError).toBe(true);
		expect(payload(result)).toEqual({
			error: "Project not found or access denied",
		});
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
		expect(m.getDirectRepositoryState).not.toHaveBeenCalled();
	});

	it("keeps upload projects on their snapshot contract", async () => {
		m.getDirectRepositoryState.mockResolvedValue({
			availability: "UPLOAD",
			readState: "DIRECT",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			id: "snapshot-1",
			version: 2,
			status: "READY",
			digest: "c".repeat(64),
			fileCount: 1,
			projectId: PROJECT,
			organizationId: "org-1",
		});
		m.listInstructionFiles.mockResolvedValue([
			{
				path: "AGENTS.md",
				kind: "INSTRUCTIONS",
				name: "AGENTS.md",
				description: null,
				size: 12,
				mimeType: "text/markdown",
				isText: true,
				sha256: "d".repeat(64),
			},
		]);

		const result = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: PROJECT },
			session,
		);
		expect(result.isError).toBeUndefined();
		expect(payload(result)).toMatchObject({
			snapshot: { id: "snapshot-1", version: 2 },
		});
		expect(m.listDirectRepositoryFilesForApi).not.toHaveBeenCalled();
		expect(m.listInstructionFiles).toHaveBeenCalledWith(
			"snapshot-1",
			"org-1",
			{ kind: undefined, query: undefined },
		);
	});

	it("advertises paired immutable pins on direct list and file calls", () => {
		for (const name of [
			"fabric_list_project_instructions",
			"fabric_get_project_instruction",
		]) {
			const properties = toolDefinition(name).inputSchema
				.properties as Record<string, Record<string, unknown>>;
			expect(properties.generation).toMatchObject({
				type: "integer",
				minimum: 0,
			});
			expect(properties.commitSha).toMatchObject({
				pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
			});
		}
	});

	it("reports the live repository in checks without reading a historical snapshot", async () => {
		const result = await executePlatformTool(
			"fabric_instruction_checks",
			{ projectId: PROJECT },
			session,
		);
		expect(result.isError).toBeUndefined();
		expect(payload(result)).toMatchObject({
			direct: { availability: "READY", currentCommitSha: SHA },
			checks: expect.arrayContaining([
				expect.objectContaining({ id: "lock", status: "skip" }),
			]),
		});
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.downloadFile).not.toHaveBeenCalled();
	});

	describe("the checkout check compares the agent's checkout with the live branch head", () => {
		const REMOTE = "https://github.com/example-org/example-repository.git";
		const OLD_SHA = "c".repeat(40);

		async function checkoutCheck(checkout?: Record<string, unknown>) {
			const result = await executePlatformTool(
				"fabric_instruction_checks",
				{ projectId: PROJECT, ...(checkout ? { checkout } : {}) },
				session,
			);
			const checks = payload(result).checks as Array<{
				id: string;
				status: string;
				evidence: string;
				detail: string;
			}>;
			const found = checks.find((check) => check.id === "checkout");
			if (!found) {
				throw new Error("no checkout check");
			}
			return found;
		}

		it("skips and says what to pass when the caller reported no checkout", async () => {
			const check = await checkoutCheck();

			expect(check.status).toBe("skip");
			expect(check.detail).toContain("pass checkout");
		});

		it("passes a clean checkout at the branch head", async () => {
			const check = await checkoutCheck({
				remoteUrl: REMOTE,
				headSha: SHA,
				branch: "main",
				clean: true,
			});

			expect(check).toMatchObject({
				status: "pass",
				evidence: "caller-reported",
			});
			expect(check.detail).toContain("published commit");
		});

		it("warns when the checkout at the branch head has uncommitted changes", async () => {
			const check = await checkoutCheck({
				remoteUrl: REMOTE,
				headSha: SHA,
				branch: "main",
				clean: false,
			});

			expect(check.status).toBe("warn");
			expect(check.detail).toContain("uncommitted changes");
		});

		it("warns when the checkout is behind, or has diverged from, the branch head", async () => {
			const check = await checkoutCheck({
				remoteUrl: REMOTE,
				headSha: OLD_SHA,
				branch: "main",
				clean: true,
				containsPublished: false,
			});

			expect(check.status).toBe("warn");
			expect(check.detail).toContain("its history does not contain it");
		});

		it("passes a checkout that is ahead of the branch head", async () => {
			const check = await checkoutCheck({
				remoteUrl: REMOTE,
				headSha: OLD_SHA,
				branch: "main",
				clean: true,
				containsPublished: true,
			});

			expect(check.status).toBe("pass");
			expect(check.detail).toContain("ahead of the published commit");
		});

		it("skips a checkout on another branch", async () => {
			const check = await checkoutCheck({
				remoteUrl: REMOTE,
				headSha: OLD_SHA,
				branch: "feature/x",
				clean: true,
			});

			expect(check.status).toBe("skip");
			expect(check.detail).toContain("not main");
		});

		it("skips a checkout of another repository", async () => {
			const check = await checkoutCheck({
				remoteUrl: "https://github.com/example-org/other.git",
				headSha: SHA,
				branch: "main",
				clean: true,
			});

			expect(check.status).toBe("skip");
			expect(check.detail).toContain("example-org/other");
		});

		it("skips when the configured repository is unavailable", async () => {
			m.getDirectRepositoryState.mockResolvedValue({
				availability: "DISCONNECTED",
				readState: "DIRECT",
			});

			const check = await checkoutCheck({
				remoteUrl: REMOTE,
				headSha: SHA,
				branch: "main",
				clean: true,
			});

			expect(check.status).toBe("skip");
		});
	});
});
