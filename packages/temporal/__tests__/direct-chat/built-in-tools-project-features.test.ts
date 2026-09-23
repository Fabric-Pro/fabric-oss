/**
 * Direct chat wiring for the live roadmap reads (Fizzy #2309/#2310):
 * `fabric_list_project_features` and `fabric_get_project_feature` are bound
 * whenever a project is attached — on the default bundle AND, in the
 * interactive chat, alongside an explicit tool list, because the full-page chat
 * sends its Fabric tool toggles, which never name project tools. Agent runtimes
 * get them only through `project-context`. The project comes from the chat,
 * never from the model's arguments.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	listProjectFeatures: vi.fn(),
	getProjectFeature: vi.fn(),
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
	"../../src/activities/shared/project-feature-reads",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../src/activities/shared/project-feature-reads")
		>()),
		listProjectFeatures: h.listProjectFeatures,
		getProjectFeature: h.getProjectFeature,
	}),
);

const { createBuiltInTools } = await import(
	"../../src/activities/direct-chat/built-in-tools"
);

type Executable = {
	execute: (args: Record<string, unknown>) => Promise<unknown>;
};

const CTX = { userId: "user-1", organizationId: "org-1", projectId: "p-1" };
const FEATURE_TOOLS = [
	"fabric_list_project_features",
	"fabric_get_project_feature",
];

beforeEach(() => {
	vi.clearAllMocks();
});

describe("createBuiltInTools — live roadmap reads", () => {
	it("binds both on the default bundle when a project is attached", async () => {
		const tools = await createBuiltInTools(CTX);
		for (const name of FEATURE_TOOLS) {
			expect(tools).toHaveProperty(name);
		}
	});

	it("binds both alongside the interactive chat's explicit tool list", async () => {
		const tools = await createBuiltInTools({
			...CTX,
			enabledFabricToolIds: ["fabric_web_search"],
			includeProjectFeatureReads: true,
		});
		for (const name of FEATURE_TOOLS) {
			expect(tools).toHaveProperty(name);
		}
	});

	// Agent runtimes (a Slack trigger runs as the agent's owner) get the reads
	// only through the project-context capability, never by riding along.
	it("does not add them to an agent runtime's explicit list", async () => {
		const tools = await createBuiltInTools({
			...CTX,
			enabledFabricToolIds: ["fabric_web_search"],
		});
		for (const name of FEATURE_TOOLS) {
			expect(tools).not.toHaveProperty(name);
		}
	});

	it("binds them through the project-context capability ids", async () => {
		const tools = await createBuiltInTools({
			...CTX,
			enabledFabricToolIds: [...FEATURE_TOOLS],
		});
		for (const name of FEATURE_TOOLS) {
			expect(tools).toHaveProperty(name);
		}
	});

	it("binds neither without a project", async () => {
		const tools = await createBuiltInTools({
			userId: "user-1",
			organizationId: "org-1",
			enabledFabricToolIds: ["fabric_web_search"],
			includeProjectFeatureReads: true,
		});
		for (const name of FEATURE_TOOLS) {
			expect(tools).not.toHaveProperty(name);
		}
	});

	it("keeps an explicit empty list meaning no Fabric tools at all", async () => {
		expect(
			await createBuiltInTools({
				...CTX,
				enabledFabricToolIds: [],
				includeProjectFeatureReads: true,
			}),
		).toEqual({});
	});

	it("runs the list read against the chat's project, ignoring a model-supplied one", async () => {
		h.listProjectFeatures.mockResolvedValue({ features: [], total: 0 });
		const tools = await createBuiltInTools(CTX);
		const args = { status: "In Review", projectId: "someone-elses" };

		await (tools.fabric_list_project_features as Executable).execute(args);

		expect(h.listProjectFeatures).toHaveBeenCalledWith(args, {
			projectId: "p-1",
			userId: "user-1",
		});
	});

	it("runs the get read against the chat's project", async () => {
		h.getProjectFeature.mockResolvedValue({ identifier: "F-040" });
		const tools = await createBuiltInTools(CTX);

		const result = await (
			tools.fabric_get_project_feature as Executable
		).execute({ feature: "F-040" });

		expect(h.getProjectFeature).toHaveBeenCalledWith(
			{ feature: "F-040" },
			{ projectId: "p-1", userId: "user-1" },
		);
		expect(result).toEqual({ identifier: "F-040" });
	});

	it("is opted into by the interactive chat activity", () => {
		const source = readFileSync(
			join(__dirname, "../../src/activities/direct-chat/ai-execution.ts"),
			"utf8",
		);
		expect(source).toMatch(
			/createBuiltInTools\(\{[^}]*includeProjectFeatureReads: true,/,
		);
	});
});
