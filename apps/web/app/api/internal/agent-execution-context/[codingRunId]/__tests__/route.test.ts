/**
 * The coding agent's project snippets carry each source's guidance, and a
 * file imported from a document folder carries its folder's description when
 * it has none of its own.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	codingRun: vi.fn(),
	documents: vi.fn(),
	contexts: vi.fn(),
	folderGuidance: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		codingRun: { findUnique: h.codingRun },
		projectDocument: { findMany: h.documents },
		projectContext: { findMany: h.contexts },
	},
	resolveModel: vi.fn(async () => {
		throw new Error("no provider");
	}),
	withInheritedSourceGuidance: h.folderGuidance,
}));
vi.mock("@repo/database/prisma/ai-model-catalog", () => ({
	DEFAULT_FABRIC_AI_MODEL: "example-model",
}));
// The formatter's own tests live in @repo/rag; this stands in for its guidance line.
vi.mock("@repo/rag", () => ({
	contextMetaHeader: (ctx: { aiInstructions?: string | null }) =>
		ctx.aiInstructions ? `[Source guidance: ${ctx.aiInstructions}]\n` : "",
}));

import { GET } from "../route";

const SECRET = "example-secret";

function call() {
	return GET(
		new Request(
			"https://example.com/api/internal/agent-execution-context/run-1",
			{
				headers: { "X-Agent-Service-Token": SECRET },
			},
		) as never,
		{ params: Promise.resolve({ codingRunId: "run-1" }) },
	);
}

const row = (
	id: string,
	metadata: Record<string, unknown>,
	aiInstructions: string | null,
) => ({
	id,
	content: `Checkout redesign notes from ${id}`,
	type: "DOCUMENT",
	metadata,
	sourceTitle: `${id}.docx`,
	sourceType: null,
	aiInstructions,
});

beforeEach(() => {
	vi.clearAllMocks();
	process.env.AGENT_SERVICE_SECRET = SECRET;
	h.codingRun.mockResolvedValue({
		id: "run-1",
		project: { organization: { deletedAt: null } },
		provider: "example",
		userId: "user-1",
		organizationId: "org-1",
		storyTaskId: null,
		weaveExecutionId: null,
		workflowId: null,
		story: {
			id: "story-1",
			identifier: "S-1",
			title: "Checkout redesign",
			description: "Rebuild the checkout flow",
			acceptanceCriteria: null,
			priority: "HIGH",
			tasks: [],
			project: { id: "project-1", name: "Example" },
		},
	});
	h.documents.mockResolvedValue([]);
	h.contexts.mockResolvedValue([]);
	h.folderGuidance.mockImplementation(
		async ({
			rows,
		}: {
			rows: Array<{ id: string; aiInstructions: string | null }>;
		}) =>
			rows.map((r) =>
				r.id === "folder-file" && !r.aiInstructions
					? { ...r, aiInstructions: "Signed case studies" }
					: r,
			),
	);
});

describe("GET /api/internal/agent-execution-context/[codingRunId]", () => {
	it("refuses a deleted project organization before loading execution context", async () => {
		h.codingRun.mockResolvedValueOnce({
			id: "run-1",
			project: { organization: { deletedAt: new Date() } },
		});
		expect((await call()).status).toBe(403);
		expect(h.documents).not.toHaveBeenCalled();
		expect(h.contexts).not.toHaveBeenCalled();
	});

	it("refuses a deleted story project organization before loading its context", async () => {
		h.codingRun.mockResolvedValueOnce({
			id: "run-1",
			project: { organization: { deletedAt: null } },
			story: {
				tasks: [],
				project: {
					id: "example-project",
					organization: { deletedAt: new Date() },
				},
			},
		});
		expect((await call()).status).toBe(403);
		expect(h.documents).not.toHaveBeenCalled();
		expect(h.contexts).not.toHaveBeenCalled();
	});

	it("heads a document-folder snippet with its folder's description, and keeps a file's own guidance", async () => {
		h.contexts.mockResolvedValue([
			row("folder-file", { provider: "onedrive-documents" }, null),
			row("own-guidance", {}, "Only the 2026 pricing applies"),
		]);

		const body = await (await call()).json();

		expect(body.rag.snippets.map((s: { text: string }) => s.text)).toEqual([
			"[Source guidance: Signed case studies]\nCheckout redesign notes from folder-file",
			"[Source guidance: Only the 2026 pricing applies]\nCheckout redesign notes from own-guidance",
		]);
		expect(h.folderGuidance).toHaveBeenCalledTimes(1);
		expect(h.folderGuidance.mock.calls[0]?.[0].projectId).toBe("project-1");
		expect(h.contexts.mock.calls[0]?.[0].select).toMatchObject({
			id: true,
			metadata: true,
		});
	});
});
