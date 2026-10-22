/**
 * A document imported from a tagged wizard context while editing a project
 * counts its words as an editor save and a generation run do, so a fenced code
 * block or an image adds nothing to its `wordCount` (Fizzy #2946).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpdateProject = vi.fn();
const mockGetProject = vi.fn();
const mockMoveWizardTempContexts = vi.fn();
const mockProjectContextFindMany = vi.fn();
const mockProjectDocumentCreate = vi.fn();

vi.mock("@repo/database", async () => ({
	engagementProfileSchema: (await import("zod")).z.enum([
		"EXPLORE",
		"PROPOSAL",
		"GOVERNED",
		"DELEGATED",
	]),

	db: {
		project: { findUnique: (...a: unknown[]) => mockGetProject(...a) },
		projectContext: {
			findMany: (...a: unknown[]) => mockProjectContextFindMany(...a),
		},
		projectDocument: {
			findFirst: vi.fn(async () => null),
			create: (...a: unknown[]) => mockProjectDocumentCreate(...a),
		},
		documentVersion: { create: vi.fn() },
	},
	updateProject: (...a: unknown[]) => mockUpdateProject(...a),
	getProjectById: (...a: unknown[]) => mockGetProject(...a),
	seedTerminalStatusesIfEmpty: vi.fn(),
	Prisma: { JsonNull: Symbol("JsonNull") },
	cleanupCodeSearchOnRepoUnlink: vi.fn(async () => ({
		deletedContextQdrantIds: [],
		organizationId: null,
	})),
	moveWizardTempContextsToProject: (...a: unknown[]) =>
		mockMoveWizardTempContexts(...a),
	syncLegacyProjectRepoOnDisconnect: vi.fn(async () => {}),
	setAiUsageRecorder: vi.fn(),
	GATEWAY_PROVIDERS: new Set(["OPENAI", "ANTHROPIC"]),
	DB_GATEWAY_PROVIDERS: ["OPENAI", "ANTHROPIC"],
	AI_PROVIDER_METADATA: {},
}));

vi.mock("../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (o: string | null | undefined) => o ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: { id: string } };
}) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../update-project");
	return (mod.updateProjectProcedure as unknown as { handler: Handler })
		.handler;
}

const BODY = [
	"Scope and goals",
	"",
	"```ts",
	"const answer = 42;",
	"```",
	"",
	"![Flow](https://example.com/flow.png)",
].join("\n");

beforeEach(() => {
	vi.clearAllMocks();
	mockGetProject.mockResolvedValue({
		id: "proj-1",
		userId: "user-1",
		organizationId: "org-1",
	});
	mockUpdateProject.mockResolvedValue({ id: "proj-1" });
	mockMoveWizardTempContexts.mockResolvedValue({
		movedCount: 1,
		contextIds: ["ctx-1"],
		contextIdMapping: {},
		sessionId: "wizard-session-1",
	});
	mockProjectContextFindMany.mockResolvedValue([
		{
			id: "ctx-1",
			content: BODY,
			metadata: { documentTag: "TECHNICAL_SPEC" },
			originalFilename: "spec.md",
			extractionStatus: "COMPLETED",
		},
	]);
	mockProjectDocumentCreate.mockResolvedValue({ id: "doc-1" });
});

describe("updateProjectProcedure — a tagged wizard context's document", () => {
	it("counts the document's words without its code and images", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				id: "proj-1",
				organizationId: null,
				tempSessionId: "wizard-session-1",
			},
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});

		expect(mockProjectDocumentCreate).toHaveBeenCalledTimes(1);
		expect(mockProjectDocumentCreate.mock.calls[0][0].data).toMatchObject({
			type: "TECHNICAL_SPEC",
			sourceContextId: "ctx-1",
			wordCount: 3,
		});
	});
});
