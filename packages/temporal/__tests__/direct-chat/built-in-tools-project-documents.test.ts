/**
 * Direct chat wiring for the live document and Context-tab source reads
 * (Fizzy #2578). Bound wherever the roadmap reads are: on the default bundle
 * with a project attached and, in the interactive chat, alongside an explicit
 * tool list. Agent runtimes get them only through `project-context`. The
 * project comes from the chat, never from the model's arguments, and the
 * descriptions are the catalog's — the ones that tell the model to list
 * rather than search.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	listProjectDocuments: vi.fn(),
	getProjectDocument: vi.fn(),
	listProjectSources: vi.fn(),
	getProjectSource: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	tool: (def: unknown) => def,
}));

vi.mock("@repo/database", () => ({
	canCreateProjectStory: vi.fn(),
	db: {
		organization: { findUnique: vi.fn() },
		userStory: { update: vi.fn() },
	},
	getMergedSearchProviderConfigs: vi.fn().mockResolvedValue([]),
	getSearchProviderConfig: vi.fn(),
}));

vi.mock("@repo/search", () => ({ createProvider: vi.fn() }));
vi.mock("@repo/storage", () => ({ uploadFile: vi.fn() }));
vi.mock("../../src/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: vi.fn(),
}));
vi.mock("../../src/activities/orchestrator/utils", () => ({
	jsonSchemaToZod: () => ({}),
}));
vi.mock("../../src/activities/shared/frame-service", () => ({
	createFirstClassFrame: vi.fn(),
	getFirstClassFrame: vi.fn(),
	listFirstClassFrames: vi.fn(),
	shareFirstClassFrame: vi.fn(),
	updateFirstClassFrame: vi.fn(),
}));
vi.mock("../../src/activities/direct-chat/rag-retrieval", () => ({
	retrieveWorkspaceDocumentsActivity: vi.fn(),
}));
vi.mock("../../src/activities/project-metadata", () => ({
	retrieveProjectContextsActivity: vi.fn(),
}));
vi.mock(
	"../../src/activities/shared/project-document-reads",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../src/activities/shared/project-document-reads")
		>()),
		...h,
	}),
);

const { createBuiltInTools } = await import(
	"../../src/activities/direct-chat/built-in-tools"
);
const { PROJECT_DOCUMENT_LIST_DESCRIPTION, PROJECT_SOURCE_LIST_DESCRIPTION } =
	await import(
		"../../src/workflows/orchestrator/project-document-tool-schemas"
	);

type Executable = {
	description: string;
	execute: (args: Record<string, unknown>) => Promise<unknown>;
};

const CTX = { userId: "user-1", organizationId: "org-1", projectId: "p-1" };
const TOOLS = {
	fabric_list_project_documents: h.listProjectDocuments,
	fabric_get_project_document: h.getProjectDocument,
	fabric_list_project_sources: h.listProjectSources,
	fabric_get_project_source: h.getProjectSource,
};
const NAMES = Object.keys(TOOLS) as Array<keyof typeof TOOLS>;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("createBuiltInTools — document and source reads", () => {
	it("binds all four on the default bundle when a project is attached", async () => {
		const tools = await createBuiltInTools(CTX);
		for (const name of NAMES) {
			expect(tools).toHaveProperty(name);
		}
	});

	it("binds them alongside the interactive chat's explicit tool list", async () => {
		const tools = await createBuiltInTools({
			...CTX,
			enabledFabricToolIds: ["fabric_web_search"],
			includeProjectFeatureReads: true,
		});
		for (const name of NAMES) {
			expect(tools).toHaveProperty(name);
		}
	});

	it("does not add them to an agent runtime's explicit list", async () => {
		const tools = await createBuiltInTools({
			...CTX,
			enabledFabricToolIds: ["fabric_web_search"],
		});
		for (const name of NAMES) {
			expect(tools).not.toHaveProperty(name);
		}
	});

	it("binds none without a project", async () => {
		const tools = await createBuiltInTools({
			userId: "user-1",
			organizationId: "org-1",
			enabledFabricToolIds: ["fabric_web_search"],
			includeProjectFeatureReads: true,
		});
		for (const name of NAMES) {
			expect(tools).not.toHaveProperty(name);
		}
	});

	it("describes the list tools as the way to answer what exists", async () => {
		const tools = await createBuiltInTools(CTX);
		expect(
			(tools.fabric_list_project_documents as Executable).description,
		).toContain(PROJECT_DOCUMENT_LIST_DESCRIPTION);
		expect(
			(tools.fabric_list_project_sources as Executable).description,
		).toContain(PROJECT_SOURCE_LIST_DESCRIPTION);
		expect((tools.project_rag_query as Executable).description).toContain(
			"fabric_list_project_documents",
		);
	});

	it.each(NAMES)(
		"%s runs against the chat's project, ignoring a model-supplied one",
		async (name) => {
			TOOLS[name].mockResolvedValue({ ok: name });
			const tools = await createBuiltInTools(CTX);
			const args = { document: "d-1", projectId: "someone-elses" };

			const result = await (tools[name] as Executable).execute(args);

			expect(TOOLS[name]).toHaveBeenCalledWith(args, {
				projectId: "p-1",
				userId: "user-1",
			});
			expect(result).toEqual({ ok: name });
		},
	);
});
