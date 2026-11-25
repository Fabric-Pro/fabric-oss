import { beforeEach, expect, it, vi } from "vitest";
import { POST as search } from "../../project-context-search/route";
import { POST } from "../route";

const h = vi.hoisted(() => ({
	token: vi.fn(),
	project: vi.fn(),
	projectMember: vi.fn(),
	organizationMember: vi.fn(),
	source: vi.fn(),
	page: vi.fn(),
	retrieve: vi.fn(),
	format: vi.fn(),
	confidential: vi.fn(),
}));
vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	verifyAIToken: h.token,
}));
vi.mock("@repo/database", () => ({
	findConfidentialTranscriptContextIds: h.confidential,
	db: {
		project: { findUnique: h.project },
		projectMember: { findUnique: h.projectMember },
		member: { findFirst: h.organizationMember },
	},
	getContextById: h.source,
	readProjectContextBodyPage: h.page,
}));
vi.mock("@repo/rag", async () => ({
	...(await import(
		"@repo/rag/lib/project-contexts/project-context-passages"
	)),
	contextMetaHeader: () => "",
	retrieveProjectContexts: h.retrieve,
	formatContextsForPrompt: h.format,
}));

function request(body: Record<string, unknown> = {}, token = "example-token") {
	return new Request("https://example.com/api/internal/project-source", {
		method: "POST",
		headers: token ? { "X-AI-Token": token } : {},
		body: JSON.stringify({
			projectId: "example-project",
			sourceId: "example-source",
			query: "detail",
			...body,
		}),
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	h.token.mockResolvedValue({
		valid: true,
		claims: { sub: "example-user", org: "example-org" },
	});
	h.project.mockResolvedValue({
		id: "example-project",
		userId: "example-owner",
		organizationId: "example-org",
		organization: { deletedAt: null },
	});
	h.projectMember.mockResolvedValue({
		role: "VIEWER",
		acceptedAt: new Date(),
		expiresAt: null,
	});
	h.organizationMember.mockResolvedValue(null);
	h.source.mockResolvedValue({
		id: "example-source",
		projectId: "example-project",
		type: "TEXT",
		title: "Example source",
	});
	h.page.mockResolvedValue({
		content: "page",
		contentLength: 30000,
		offset: 0,
		returnedLength: 4,
		truncated: true,
		nextOffset: 4,
		hasReadableText: true,
	});
	h.retrieve.mockResolvedValue([
		{
			id: "example-source",
			type: "TEXT",
			score: 1,
			content: "whole".repeat(20000),
			matchedPassages: [{ content: "match".repeat(14000), score: 1 }],
		},
	]);
	h.format.mockReturnValue("legacy whole document");
	h.confidential.mockResolvedValue(new Set());
});
it("rejects a missing token", async () => {
	expect((await POST(request({}, ""))).status).toBe(401);
	expect(h.source).not.toHaveBeenCalled();
});
it("rejects an invalid token", async () => {
	h.token.mockResolvedValue({ valid: false });
	expect((await POST(request())).status).toBe(401);
});
it("rejects no project access", async () => {
	h.projectMember.mockResolvedValue(null);
	expect((await POST(request())).status).toBe(403);
});
it("rejects a different token organization", async () => {
	h.project.mockResolvedValue({ organizationId: "other-org" });
	expect((await POST(request())).status).toBe(403);
	expect(h.source).not.toHaveBeenCalled();
});
it.each([
	["reading", POST],
	["searching", search],
])(
	"refuses a deleted hosting organization before %s project sources",
	async (_, handle) => {
		h.project.mockResolvedValue({
			organizationId: "example-org",
			organization: { deletedAt: new Date() },
		});
		expect((await handle(request())).status).toBe(403);
		expect(h.source).not.toHaveBeenCalled();
		expect(h.retrieve).not.toHaveBeenCalled();
	},
);
it("hides a source belonging to another project", async () => {
	h.source.mockResolvedValue({ projectId: "other-project" });
	expect((await POST(request())).status).toBe(404);
	expect(h.page).not.toHaveBeenCalled();
});
it("pages with trusted identity and ignores body userId", async () => {
	const response = await POST(
		request({
			userId: "impersonated-user",
			organizationId: "other-org",
			offset: 4,
			maxChars: 999999,
		}),
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		content: "page",
		nextOffset: 4,
		truncated: true,
		contentAvailable: true,
	});
	expect(h.projectMember).toHaveBeenCalledWith(
		expect.objectContaining({
			where: {
				projectId_userId: {
					projectId: "example-project",
					userId: "example-user",
				},
			},
		}),
	);
	expect(h.page).toHaveBeenCalledWith(
		expect.anything(),
		{ userId: "example-user", organizationId: "example-org" },
		{ offset: 4, maxLength: 40000 },
	);
});
it("defaults to 24000 and normalizes invalid windows", async () => {
	await POST(request({ offset: -9 }));
	expect(h.page).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.anything(),
		{ offset: 0, maxLength: 24000 },
	);
});
it("refuses a Parlume or confidential-series transcript without reading it", async () => {
	h.confidential.mockResolvedValue(new Set(["example-source"]));
	const response = await POST(request());
	expect(response.status).toBe(403);
	expect(h.confidential).toHaveBeenCalledWith({
		projectId: "example-project",
		contextIds: ["example-source"],
	});
	expect(h.page).not.toHaveBeenCalled();
});
it("returns an unavailable reason", async () => {
	h.page.mockResolvedValue({
		hasReadableText: false,
		content: "",
		contentLength: 0,
		offset: 0,
		returnedLength: 0,
		truncated: false,
	});
	const result = await (await POST(request())).json();
	expect(result.contentAvailable).toBe(false);
	expect(result.unavailableReason).toBeTruthy();
	expect(result.nextOffset).toBeUndefined();
});
it("keeps legacy search formatting without maxChars", async () => {
	const result = await (await search(request())).json();
	expect(result.formatted).toBe("legacy whole document");
	expect(result.totalCount).toBe(1);
	expect(h.retrieve.mock.calls[0][0]).not.toHaveProperty(
		"includeMatchedPassages",
	);
});
it.each([1, 24000, 999999])(
	"requests passages and clamps a %s search budget",
	async (budget) => {
		const result = await (
			await search(request({ maxChars: budget }))
		).json();
		expect(result.formatted.length).toBeLessThanOrEqual(
			Math.min(60000, Math.max(4000, budget)),
		);
		expect(result.formatted).toContain("read_project_source");
		expect(result.formatted).not.toContain("wholewhole");
		expect(h.retrieve).toHaveBeenCalledWith({
			projectId: "example-project",
			query: "detail",
			userId: "example-user",
			organizationId: "example-org",
			topK: undefined,
			includeMatchedPassages: true,
		});
		expect(result.totalCount).toBe(1);
		expect(h.format).not.toHaveBeenCalled();
	},
);
