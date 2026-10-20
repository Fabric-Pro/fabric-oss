/**
 * The Living Memory write tools (ADR-022, phase 3): `fabric_memory_targets`,
 * `fabric_memory_write` and `fabric_memory_write_status`.
 *
 * What is pinned here is the gateway side: the scope each tool needs, the
 * project binding, the caller's live permission, the argument validation and
 * what a write is told to the shared admission (`via: MCP`, the OAuth client).
 * Admission, the receipt and the workflow are the functions the app and the
 * CLI call, covered where they live and mocked here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveProjectAccess: vi.fn(),
	getMemoryWriteTargetsView: vi.fn(),
	getMemoryWriteView: vi.fn(),
	getMemoryFolderFilesView: vi.fn(),
	getMemoryFolderTextView: vi.fn(),
	submitMemoryWriteRequest: vi.fn(),
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isProjectSoftDeleted: vi.fn().mockResolvedValue(false),
	resolveProjectAccess: mocks.resolveProjectAccess,
	hasPermission: (permissions: string[], required: string) =>
		permissions.includes(required),
	Permissions: {
		CONTEXT_READ: "context:read",
		CONTEXT_CREATE: "context:create",
	},
}));

vi.mock(
	"@repo/api/modules/projects/lib/memory-write/memory-write-views",
	() => ({
		getMemoryWriteTargetsView: mocks.getMemoryWriteTargetsView,
		getMemoryWriteView: mocks.getMemoryWriteView,
		getMemoryFolderFilesView: mocks.getMemoryFolderFilesView,
		getMemoryFolderTextView: mocks.getMemoryFolderTextView,
	}),
);

vi.mock(
	"@repo/api/modules/projects/lib/memory-write/submit-memory-write-request",
	() => ({ submitMemoryWriteRequest: mocks.submitMemoryWriteRequest }),
);

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
} from "../platform-tools";
import type { GatewaySession } from "../types";

const PROJECT = "proj-1";
const TARGET = {
	id: "target-1",
	folder: "docs/memory",
	mode: "PULL_REQUEST" as "PULL_REQUEST" | "DIRECT_PUSH",
	version: 1,
};

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org-1",
	projectId: PROJECT,
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	credential: "oauth",
	oauthClientId: "client-row-1",
	scopes: ["memory:write"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

const writeArgs = {
	message: "Add the checkout notes",
	files: [{ path: "docs/memory/notes.md", content: "# Notes\n" }],
};

function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}

function call(
	tool: string,
	args: Record<string, unknown>,
	overrides: Partial<GatewaySession> = {},
) {
	return executePlatformTool(tool, args, { ...session, ...overrides });
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	mocks.resolveProjectAccess.mockResolvedValue({
		organizationId: "org-1",
		source: "project-member",
		isVisible: true,
		permissions: ["context:read", "context:create"],
	});
	mocks.getMemoryWriteTargetsView.mockResolvedValue({
		sync: { ref: "main" },
		targets: [TARGET],
	});
	mocks.submitMemoryWriteRequest.mockResolvedValue({
		kind: "accepted",
		writeId: "write-1",
		status: "PENDING",
		digest: "d".repeat(64),
		deduplicated: false,
	});
	mocks.getMemoryWriteView.mockResolvedValue({
		writeId: "write-1",
		status: "PENDING",
		outcome: null,
	});
	TARGET.mode = "PULL_REQUEST";
});

describe("declarations", () => {
	const definition = (name: string) => {
		const found = PLATFORM_TOOL_DEFINITIONS.find(
			(tool) => tool.name === name,
		);
		if (!found) {
			throw new Error(`missing ${name}`);
		}
		return found;
	};

	it("declares the reads read-only and the write as a write", () => {
		expect(definition("fabric_memory_targets").annotations).toEqual({
			readOnlyHint: true,
		});
		expect(definition("fabric_memory_write_status").annotations).toEqual({
			readOnlyHint: true,
		});
		expect(
			definition("fabric_memory_write").annotations?.readOnlyHint,
		).toBe(false);
	});

	it("tells the agent which folders are searchable and which are stored only", () => {
		const description = definition("fabric_memory_targets").description;

		expect(description).toMatch(/indexMode/);
		expect(description).toMatch(/STORE_ONLY/);
		expect(description).toMatch(/INDEXED/);
	});

	it("tells the agent about create-only, ifMatchOid and both outcomes", () => {
		const description = definition("fabric_memory_write").description;

		expect(description).toMatch(/create-only/i);
		expect(description).toMatch(/ifMatchOid/);
		expect(description).toMatch(/pull request/i);
		expect(description).toMatch(/DIRECT_PUSH/);
		expect(description).toMatch(/invisible to Living Memory until/i);
		expect(description).toMatch(
			/fabric_propose_project_instruction_change/,
		);
	});

	it("states the same file and size bounds admission enforces", async () => {
		const { MAX_MEMORY_WRITE_ENTRIES } = await import(
			"@repo/temporal/memory-write/evaluate"
		);
		const { MAX_INLINE_BYTES_PER_REQUEST } = await import(
			"@repo/api/modules/projects/lib/memory-write/admit-memory-write"
		);
		const description = definition("fabric_memory_write").description;

		expect(description).toContain(
			`At most ${MAX_MEMORY_WRITE_ENTRIES} files`,
		);
		expect(description).toContain(
			`${MAX_INLINE_BYTES_PER_REQUEST / (1024 * 1024)} MiB`,
		);
	});
});

describe("fabric_memory_read", () => {
	const listing = {
		targetId: "target-1",
		folder: "docs/memory",
		files: [{ path: "docs/memory/specs/x/spec.md" }],
		nextCursor: null,
	};
	const TWO_FOLDERS = {
		sync: { ref: "main" },
		targets: [TARGET, { ...TARGET, id: "target-2", folder: "docs/ai" }],
	};

	beforeEach(() => {
		mocks.getMemoryFolderFilesView.mockResolvedValue(listing);
		mocks.getMemoryFolderTextView.mockResolvedValue({
			targetId: "target-1",
			path: "docs/memory/specs/x/spec.md",
			content: "# Spec\n",
			offset: 0,
			nextOffset: null,
			totalBytes: 7,
		});
	});

	it("is a read tool under memory:write, so mcp:read satisfies it", async () => {
		const definition = PLATFORM_TOOL_DEFINITIONS.find(
			(tool) => tool.name === "fabric_memory_read",
		);
		const result = await call(
			"fabric_memory_read",
			{},
			{ scopes: ["mcp:read"] },
		);

		expect(definition?.annotations).toEqual({ readOnlyHint: true });
		expect(result.isError).toBeUndefined();
	});

	it("refuses a credential with neither scope", async () => {
		const result = await call(
			"fabric_memory_read",
			{},
			{ scopes: ["instructions:write"] },
		);

		expect(result.isError).toBe(true);
		expect(mocks.getMemoryFolderFilesView).not.toHaveBeenCalled();
	});

	it("lists a folder under a prefix, by default the only folder", async () => {
		const result = await call("fabric_memory_read", {
			prefix: "docs/memory/specs/x",
			after: "docs/memory/specs/x/a.md",
			limit: 20,
		});

		expect(mocks.getMemoryFolderFilesView).toHaveBeenCalledWith({
			projectId: PROJECT,
			organizationId: "org-1",
			targetId: "target-1",
			prefix: "docs/memory/specs/x",
			after: "docs/memory/specs/x/a.md",
			limit: 20,
		});
		expect(payload(result)).toEqual(listing);
	});

	it("reads one file, paged", async () => {
		const result = await call("fabric_memory_read", {
			path: "docs/memory/specs/x/spec.md",
			offset: 100,
			maxBytes: 5000,
		});

		expect(mocks.getMemoryFolderTextView).toHaveBeenCalledWith({
			projectId: PROJECT,
			organizationId: "org-1",
			targetId: "target-1",
			path: "docs/memory/specs/x/spec.md",
			offset: 100,
			maxBytes: 5000,
		});
		expect(payload(result)).toMatchObject({ content: "# Spec\n" });
	});

	it("picks the folder that holds the path when there are several", async () => {
		mocks.getMemoryWriteTargetsView.mockResolvedValue(TWO_FOLDERS);

		await call("fabric_memory_read", { path: "docs/ai/specs/y/spec.md" });

		expect(mocks.getMemoryFolderTextView).toHaveBeenCalledWith(
			expect.objectContaining({ targetId: "target-2" }),
		);
	});

	it("needs a targetId, path or prefix to tell several folders apart", async () => {
		mocks.getMemoryWriteTargetsView.mockResolvedValue(TWO_FOLDERS);

		const result = await call("fabric_memory_read", {});

		expect(result.isError).toBe(true);
		expect(mocks.getMemoryFolderFilesView).not.toHaveBeenCalled();
	});

	it("explains a project with no write folders", async () => {
		mocks.getMemoryWriteTargetsView.mockResolvedValue({
			sync: null,
			targets: [],
		});

		const result = await call("fabric_memory_read", {});

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/no Living Memory/i);
	});

	it("answers a prefix outside the folder and a missing file as errors", async () => {
		mocks.getMemoryFolderFilesView.mockResolvedValue(null);
		mocks.getMemoryFolderTextView.mockResolvedValue(null);

		const list = await call("fabric_memory_read", { prefix: "src" });
		const file = await call("fabric_memory_read", {
			path: "docs/memory/nope.md",
		});

		expect(list.isError).toBe(true);
		expect(file.isError).toBe(true);
	});

	it("needs only CONTEXT_READ", async () => {
		mocks.resolveProjectAccess.mockResolvedValue({
			organizationId: "org-1",
			source: "project-member",
			isVisible: true,
			permissions: ["context:read"],
		});

		const result = await call("fabric_memory_read", {});

		expect(result.isError).toBeUndefined();
	});

	it("is denied without CONTEXT_READ, for an invisible project, and for a project outside an organization", async () => {
		mocks.resolveProjectAccess.mockResolvedValue({
			organizationId: "org-1",
			source: "project-member",
			isVisible: true,
			permissions: [],
		});
		const denied = await call("fabric_memory_read", {});
		mocks.resolveProjectAccess.mockResolvedValue({
			organizationId: "org-1",
			source: "org",
			isVisible: false,
			permissions: ["context:read"],
		});
		const invisible = await call("fabric_memory_read", {});
		mocks.resolveProjectAccess.mockResolvedValue({
			organizationId: null,
			source: "project-member",
			isVisible: true,
			permissions: ["context:read"],
		});
		const orgLess = await call("fabric_memory_read", {});

		expect(payload(denied).error).toMatch(/permission/i);
		expect(payload(invisible).error).toBe(
			"Project not found or access denied",
		);
		expect(orgLess.isError).toBe(true);
		expect(mocks.getMemoryFolderFilesView).not.toHaveBeenCalled();
	});

	it("refuses another project than the one the session is bound to", async () => {
		const result = await call("fabric_memory_read", {
			projectId: "proj-2",
		});

		expect(payload(result).error).toBe(
			"Project not found or access denied",
		);
	});

	it("rejects bad paging arguments before reading", async () => {
		const result = await call("fabric_memory_read", {
			path: "docs/memory/a.md",
			offset: -1,
		});

		expect(result.isError).toBe(true);
		expect(mocks.getMemoryFolderTextView).not.toHaveBeenCalled();
	});
});

describe("scope", () => {
	it("refuses fabric_memory_write to a credential without memory:write", async () => {
		const result = await call("fabric_memory_write", writeArgs, {
			scopes: ["mcp:read", "instructions:write"],
		});

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/memory:write/);
		expect(mocks.submitMemoryWriteRequest).not.toHaveBeenCalled();
	});

	it("lets mcp:read list the folders and read a receipt, but not write", async () => {
		const scopes = ["mcp:read"];

		const targets = await call("fabric_memory_targets", {}, { scopes });
		const status = await call(
			"fabric_memory_write_status",
			{ writeId: "write-1" },
			{ scopes },
		);
		const write = await call("fabric_memory_write", writeArgs, { scopes });

		expect(targets.isError).toBeUndefined();
		expect(status.isError).toBeUndefined();
		expect(write.isError).toBe(true);
	});

	it("is not granted by the default OAuth scopes", async () => {
		const { OAUTH_DEFAULT_SCOPES } = await import(
			"@repo/auth/lib/oauth-scopes"
		);

		expect(OAUTH_DEFAULT_SCOPES as readonly string[]).not.toContain(
			"memory:write",
		);
	});
});

describe("project binding and the live permission", () => {
	it("refuses a project other than the one the session is bound to", async () => {
		const result = await call("fabric_memory_write", {
			...writeArgs,
			projectId: "proj-2",
		});

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe(
			"Project not found or access denied",
		);
		expect(mocks.submitMemoryWriteRequest).not.toHaveBeenCalled();
	});

	it("defaults projectId to the bound project", async () => {
		await call("fabric_memory_write", writeArgs);

		expect(mocks.submitMemoryWriteRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT,
				organizationId: "org-1",
			}),
		);
	});

	it("needs CONTEXT_CREATE to write and only CONTEXT_READ to read", async () => {
		mocks.resolveProjectAccess.mockResolvedValue({
			organizationId: "org-1",
			source: "project-member",
			isVisible: true,
			permissions: ["context:read"],
		});

		const write = await call("fabric_memory_write", writeArgs);
		const targets = await call("fabric_memory_targets", {});
		const status = await call("fabric_memory_write_status", {
			writeId: "write-1",
		});

		expect(write.isError).toBe(true);
		expect(payload(write).error).toMatch(/permission/i);
		expect(mocks.submitMemoryWriteRequest).not.toHaveBeenCalled();
		expect(targets.isError).toBeUndefined();
		expect(status.isError).toBeUndefined();
	});

	it("answers a project the caller cannot see as not found", async () => {
		mocks.resolveProjectAccess.mockResolvedValue({
			organizationId: "org-1",
			source: "org",
			isVisible: false,
			permissions: ["context:read", "context:create"],
		});

		const result = await call("fabric_memory_targets", {});

		expect(payload(result).error).toBe(
			"Project not found or access denied",
		);
	});

	it("keeps an organization-bound credential to its organization", async () => {
		const result = await call("fabric_memory_write", writeArgs, {
			organizationId: "org-other",
		});

		expect(result.isError).toBe(true);
		expect(mocks.submitMemoryWriteRequest).not.toHaveBeenCalled();
	});
});

describe("fabric_memory_write", () => {
	it("submits through the shared admission as the MCP agent", async () => {
		const result = await call("fabric_memory_write", {
			...writeArgs,
			files: [
				{ path: "docs/memory/notes.md", content: "# Notes\n" },
				{
					path: "docs/memory/old.md",
					delete: true,
					ifMatchOid: "a".repeat(40),
				},
			],
		});

		expect(result.isError).toBeUndefined();
		expect(mocks.submitMemoryWriteRequest).toHaveBeenCalledWith({
			projectId: PROJECT,
			organizationId: "org-1",
			userId: "user-1",
			via: "MCP",
			oauthClientId: "client-row-1",
			targetId: "target-1",
			message: "Add the checkout notes",
			entries: [
				{
					path: "docs/memory/notes.md",
					op: "PUT",
					ifMatchOid: undefined,
					content: "# Notes\n",
				},
				{
					path: "docs/memory/old.md",
					op: "DELETE",
					ifMatchOid: "a".repeat(40),
				},
			],
			audit: {
				user: {
					id: "user-1",
					email: "agent@example.com",
					name: "Example Agent",
				},
			},
		});
	});

	it("passes no OAuth client for a key", async () => {
		await call("fabric_memory_write", writeArgs, {
			credential: "organization-key",
			oauthClientId: undefined,
		});

		expect(mocks.submitMemoryWriteRequest).toHaveBeenCalledWith(
			expect.objectContaining({ oauthClientId: null, via: "MCP" }),
		);
	});

	it("answers the receipt and says where the files land, per mode", async () => {
		const pullRequest = payload(
			await call("fabric_memory_write", writeArgs),
		);
		TARGET.mode = "DIRECT_PUSH";
		const direct = payload(await call("fabric_memory_write", writeArgs));

		expect(pullRequest).toMatchObject({
			writeId: "write-1",
			status: "PENDING",
			mode: "PULL_REQUEST",
			branch: "main",
		});
		expect(pullRequest.note).toMatch(
			/not in Living Memory until a person merges/,
		);
		expect(direct.mode).toBe("DIRECT_PUSH");
		expect(direct.note).toMatch(/committed to the synced branch/);
	});

	it("needs a targetId when the project has several folders, and lists them", async () => {
		mocks.getMemoryWriteTargetsView.mockResolvedValue({
			sync: { ref: "main" },
			targets: [
				TARGET,
				{ ...TARGET, id: "target-2", folder: "docs/specs" },
			],
		});

		const result = await call("fabric_memory_write", writeArgs);
		const named = await call("fabric_memory_write", {
			...writeArgs,
			targetId: "target-2",
		});

		expect(result.isError).toBe(true);
		expect(payload(result).targets).toHaveLength(2);
		expect(named.isError).toBeUndefined();
		expect(mocks.submitMemoryWriteRequest).toHaveBeenCalledTimes(1);
		expect(mocks.submitMemoryWriteRequest).toHaveBeenCalledWith(
			expect.objectContaining({ targetId: "target-2" }),
		);
	});

	it("explains a project with no write folders and an unknown targetId", async () => {
		mocks.getMemoryWriteTargetsView.mockResolvedValue({
			sync: null,
			targets: [],
		});
		expect(
			payload(await call("fabric_memory_write", writeArgs)).error,
		).toMatch(/no Living Memory write folders/);

		mocks.getMemoryWriteTargetsView.mockResolvedValue({
			sync: { ref: "main" },
			targets: [TARGET],
		});
		expect(
			payload(
				await call("fabric_memory_write", {
					...writeArgs,
					targetId: "nope",
				}),
			).error,
		).toBe("Write folder not found");
		expect(mocks.submitMemoryWriteRequest).not.toHaveBeenCalled();
	});

	it.each([
		["no files", { files: [] }],
		[
			"a file with neither content nor delete",
			{ files: [{ path: "a.md" }] },
		],
		[
			"a delete that also carries content",
			{ files: [{ path: "a.md", delete: true, content: "x" }] },
		],
		["no message", { message: "" }],
		[
			"more files than a write may hold",
			{
				files: Array.from({ length: 51 }, (_, i) => ({
					path: `docs/memory/${i}.md`,
					content: "x",
				})),
			},
		],
	])("refuses %s before admission", async (_name, overrides) => {
		const result = await call("fabric_memory_write", {
			...writeArgs,
			...overrides,
		});

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/Invalid arguments/);
		expect(mocks.submitMemoryWriteRequest).not.toHaveBeenCalled();
	});

	it("reports every admission problem and nothing else", async () => {
		mocks.submitMemoryWriteRequest.mockResolvedValue({
			kind: "refused",
			problems: [{ code: "PATH_HIDDEN", path: ".github/x.md" }],
		});

		const result = await call("fabric_memory_write", writeArgs);

		expect(result.isError).toBe(true);
		expect(payload(result)).toMatchObject({
			code: "MEMORY_WRITE_REFUSED",
			problems: [{ code: "PATH_HIDDEN", path: ".github/x.md" }],
		});
	});

	it("tells the agent when it has too many writes pending", async () => {
		mocks.submitMemoryWriteRequest.mockResolvedValue({
			kind: "too-many-pending",
			limit: 5,
		});

		const result = await call("fabric_memory_write", writeArgs);

		expect(payload(result)).toMatchObject({
			code: "TOO_MANY_PENDING_WRITES",
		});
	});
});

describe("fabric_memory_write_status", () => {
	it("reads the receipt of this project and explains a pull request", async () => {
		mocks.getMemoryWriteView.mockResolvedValue({
			writeId: "write-1",
			status: "PULL_REQUEST",
			outcome: {
				status: "PULL_REQUEST",
				url: "https://example.com/pr/1",
			},
		});

		const result = payload(
			await call("fabric_memory_write_status", { writeId: "write-1" }),
		);

		expect(mocks.getMemoryWriteView).toHaveBeenCalledWith({
			writeId: "write-1",
			projectId: PROJECT,
			organizationId: "org-1",
		});
		expect(result.note).toMatch(/not in Living Memory until it is merged/);
	});

	it("needs a writeId and answers an unknown write as not found", async () => {
		expect((await call("fabric_memory_write_status", {})).isError).toBe(
			true,
		);

		mocks.getMemoryWriteView.mockResolvedValue(null);
		const result = await call("fabric_memory_write_status", {
			writeId: "nope",
		});

		expect(payload(result).error).toBe("Write not found");
	});
});
