import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySession } from "../types";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	search: vi.fn(),
	getStory: vi.fn(),
}));
vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", () => ({
	getProjectAccessContext: mocks.access,
	searchProjectKnowledge: mocks.search,
	getStoryById: mocks.getStory,
}));

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
} from "../platform-tools";

const session: GatewaySession = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	userName: "Example",
	email: "dev@example.com",
	role: "user",
	credential: "organization-key",
	scopes: ["projects:read", "features:read"],
	createdAt: new Date(),
	expiresAt: new Date(),
};
const args = { projectId: "example-project", query: "needle" };
const row = (id = "example-feature", extra = {}) => ({
	sourceKind: "feature",
	sourceId: id,
	parentContextId: null,
	rank: 3,
	title: "Needle",
	excerpt: "body needle",
	excerptField: "body",
	titleTruncated: false,
	excerptTruncated: false,
	identifier: "F-001",
	sourceType: "FEATURE",
	sourceUrl: null,
	...extra,
});
async function call(input: Record<string, unknown> = args, caller = session) {
	const result = await executePlatformTool(
		"fabric_search_project_knowledge",
		input,
		caller,
	);
	return { result, data: JSON.parse(result.content[0].text) };
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.access.mockResolvedValue({ organizationId: "example-org" });
	mocks.search.mockResolvedValue([row()]);
	mocks.getStory.mockResolvedValue({
		id: "example-feature",
		projectId: "example-project",
		title: "Needle",
		tasks: [],
		status: { id: "example-status", name: "Open", isFinal: false },
	});
});

describe("project knowledge search", () => {
	it("is discoverable as an explicitly project-scoped read", () => {
		expect(
			PLATFORM_TOOL_DEFINITIONS.find(
				(t) => t.name === "fabric_search_project_knowledge",
			),
		).toMatchObject({
			annotations: { readOnlyHint: true },
			inputSchema: { required: ["projectId", "query"] },
		});
	});
	it("returns feature arguments that the full-read tool can execute unchanged", async () => {
		const { data } = await call();
		const reference = data.results[0];
		const result = await executePlatformTool(
			reference.readTool,
			reference.readArguments,
			session,
		);
		expect(result.isError).toBeUndefined();
		expect(mocks.getStory).toHaveBeenCalledWith(
			"example-feature",
			"example-project",
		);
		expect(JSON.parse(result.content[0].text)).toMatchObject({
			id: "example-feature",
			projectId: "example-project",
		});
	});
	it("searches with the authorized host organization and returns follow-up references", async () => {
		const { result, data } = await call();
		expect(result.isError).toBeUndefined();
		expect(mocks.search).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "example-project",
				organizationId: "example-org",
				query: "needle",
			}),
		);
		expect(data.results[0]).toMatchObject({
			id: "example-feature",
			sourceKind: "feature",
			readTool: "fabric_get_feature",
			readArguments: { featureId: "example-feature" },
		});
	});
	it.each([
		{ scopes: ["projects:read"] },
		{ scopes: ["features:read"] },
		{ scopes: [] },
	])("requires both source ceilings: %j", async ({ scopes }) => {
		const { result, data } = await call(args, { ...session, scopes });
		expect(result.isError).toBe(true);
		expect(data.error).toContain("scope");
		expect(mocks.search).not.toHaveBeenCalled();
	});
	it.each(["mcp:read", "mcp:write", "*"])(
		"accepts the existing %s umbrella",
		async (scope) => {
			expect(
				(await call(args, { ...session, scopes: [scope] })).result
					.isError,
			).toBeUndefined();
		},
	);
	it("rechecks revoked access even for wildcard keys", async () => {
		mocks.access.mockResolvedValue(null);
		expect(
			(await call(args, { ...session, scopes: ["*"] })).data.error,
		).toMatch(/not found or access denied/i);
		expect(mocks.search).not.toHaveBeenCalled();
	});
	it("refuses an unrelated project in the same organization", async () => {
		mocks.access.mockResolvedValue(null);
		expect((await call()).result.isError).toBe(true);
		expect(mocks.search).not.toHaveBeenCalled();
	});
	it.each(["organization-key", "oauth"] as const)(
		"holds %s to its own tenant despite a guest grant",
		async (credential) => {
			mocks.access.mockResolvedValue({ organizationId: "other-org" });
			const { data } = await call(args, { ...session, credential });
			expect(data.error).toMatch(/not found or access denied/i);
			expect(JSON.stringify(data)).not.toContain("other-org");
			expect(mocks.search).not.toHaveBeenCalled();
		},
	);
	it.each(["session", "personal-key"] as const)(
		"allows a valid invited guest via %s and searches host rows",
		async (credential) => {
			mocks.access.mockResolvedValue({ organizationId: "host-org" });
			expect(
				(await call(args, { ...session, credential })).result.isError,
			).toBeUndefined();
			expect(mocks.search).toHaveBeenCalledWith(
				expect.objectContaining({ organizationId: "host-org" }),
			);
		},
	);
	it.each([null, ""])(
		"fails closed for unresolved host organization %j",
		async (organizationId) => {
			mocks.access.mockResolvedValue({ organizationId });
			expect(
				(await call(args, { ...session, credential: "session" })).result
					.isError,
			).toBe(true);
			expect(mocks.search).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ ...args, query: " " },
		{ ...args, projectId: 1 },
		{ ...args, maxBytes: 1 },
		{ ...args, maxBytes: null },
		{ ...args, limit: null },
		{ ...args, maxBytes: 8192.5 },
		{ ...args, limit: 0 },
		{ ...args, cursor: "not-a-cursor" },
	])("rejects malformed input %j before searching", async (input) => {
		expect((await call(input)).result.isError).toBe(true);
		expect(mocks.search).not.toHaveBeenCalled();
	});
	it("enforces actual UTF8 JSON bytes and resumes after the last emitted record", async () => {
		mocks.search.mockResolvedValue(
			Array.from({ length: 51 }, (_, i) =>
				row(`id-${i}`, {
					title: '"\\😀'.repeat(40),
					excerpt: '\n"\\😀'.repeat(140),
				}),
			),
		);
		const { result, data } = await call({ ...args, maxBytes: 8192 });
		expect(
			Buffer.byteLength(result.content[0].text, "utf8"),
		).toBeLessThanOrEqual(8192);
		expect(data.results.length).toBeGreaterThan(0);
		expect(data.results.length).toBeLessThan(50);
		expect(data.omissionReason).toBe("response_budget");
		expect(data.hasMore).toBe(true);
		expect(data.nextCursor).toBeTypeOf("string");
		mocks.search.mockResolvedValue([]);
		await call({ ...args, cursor: data.nextCursor });
		expect(mocks.search).toHaveBeenLastCalledWith(
			expect.objectContaining({
				after: expect.objectContaining({
					sourceId: data.results.at(-1).id,
				}),
			}),
		);
		expect(
			(await call({ ...args, query: "changed", cursor: data.nextCursor }))
				.result.isError,
		).toBe(true);
		expect(
			(
				await call({
					...args,
					projectId: "other-project",
					cursor: data.nextCursor,
				})
			).result.isError,
		).toBe(true);
	});
	it("returns contextual child references and a truthful empty result", async () => {
		mocks.search.mockResolvedValue([
			row("page-id", {
				sourceKind: "context_page",
				parentContextId: "context-id",
				sourceUrl: "https://example.com/page",
			}),
		]);
		const { data } = await call();
		expect(data.results[0]).toMatchObject({
			contextId: "context-id",
			pageId: "page-id",
			readTool: "fabric_get_project_context",
			readArguments: { contextId: "context-id" },
		});
		mocks.search.mockResolvedValue([]);
		expect((await call()).data).toMatchObject({
			results: [],
			returnedCount: 0,
			hasMore: false,
			nextCursor: null,
		});
	});
});
