/**
 * `ensureToolIndexBuilt` re-indexes the Fabric AI tools when a tenant's cached
 * copy no longer matches the code. It used to compare only the tool count and
 * whether schemas were present, so an edited description or a new schema
 * property (e.g. `code_tree`'s `offset`) never reached a tenant whose cache
 * already held the same number of tools. An unchanged definition — however its
 * schema keys are ordered after a round trip through Qdrant — must not
 * re-index.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeWorkflowIntegrationRow } from "./helpers/workflow-integration-fake";

const h = vi.hoisted(() => ({
	rows: [] as FakeWorkflowIntegrationRow[],
	current: [] as Array<{
		name: string;
		description: string;
		inputSchema: Record<string, unknown>;
	}>,
	cached: [] as Array<{
		toolName: string;
		description: string;
		inputSchema?: Record<string, unknown>;
	}>,
	addServer: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	const { createWorkflowIntegrationFake } = await import(
		"./helpers/workflow-integration-fake"
	);
	return {
		db: {
			get workflowIntegration() {
				return createWorkflowIntegrationFake(h.rows);
			},
		},
	};
});
vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	closeMcpClientSafe: vi.fn(),
}));
vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	getCapabilitiesByTenant: vi.fn().mockResolvedValue([]),
	searchCapabilities: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/activities/oauth-tool-ingestion", () => ({
	ingestOAuthIntegrationToolsActivity: vi.fn(),
}));
vi.mock("@repo/mcp-registry", () => ({
	GITHUB_ACCOUNT: { version: "1.0.0" },
	MICROSOFT_TEAMS_ACCOUNT: { version: "1.0.0" },
}));
vi.mock("../src/activities/orchestrator/tools/fabric-ai-tools", () => ({
	getFabricAiTools: () => h.current,
}));
vi.mock("../src/activities/orchestrator/tools/tool-index", () => ({
	toolIndex: {
		needsRebuild: () => true,
		loadFromQdrant: () => Promise.resolve(true),
		getServerTools: () => h.cached,
		addServer: h.addServer,
	},
}));

import { ensureToolIndexBuilt } from "../src/activities/orchestrator/tools/search-tools";

const CODE_TREE_V2 = {
	name: "code_tree",
	description: "List the directory tree — paths only, not file contents.",
	inputSchema: {
		type: "object",
		properties: {
			directory: { type: "string", description: "Directory filter." },
			repo: { type: "string", description: "owner/name." },
			offset: { type: "number", description: "Entries to skip." },
		},
		required: [],
	},
};
const CODE_FILE_GET = {
	name: "code_file_get",
	description: "Fetch one file.",
	inputSchema: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
};

/** A cached entry as `loadFromQdrant` rebuilds it from the stored payload. */
function cachedFrom(tool: (typeof h.current)[number]) {
	return {
		toolName: tool.name,
		description: tool.description,
		inputSchema: structuredClone(tool.inputSchema),
	};
}

beforeEach(() => {
	h.addServer.mockReset();
	h.rows = [];
	h.current = [CODE_TREE_V2, CODE_FILE_GET];
});

describe("Fabric AI tool cache: re-index on a changed definition", () => {
	it("re-indexes when a cached schema lacks a property the code now has, at the same count", async () => {
		const stale = cachedFrom(CODE_TREE_V2);
		const { offset: _dropped, ...withoutOffset } = (
			stale.inputSchema as { properties: Record<string, unknown> }
		).properties;
		(stale.inputSchema as { properties: unknown }).properties =
			withoutOffset;
		h.cached = [stale, cachedFrom(CODE_FILE_GET)];

		await ensureToolIndexBuilt("user-1", "org-example");

		expect(h.addServer).toHaveBeenCalledTimes(1);
		expect(h.addServer).toHaveBeenCalledWith(
			"fabric-ai-server",
			"Fabric AI",
			h.current,
			expect.objectContaining({ persistToQdrant: true }),
		);
	});

	it("re-indexes when only a description changed", async () => {
		h.cached = [
			{ ...cachedFrom(CODE_TREE_V2), description: "Old description." },
			cachedFrom(CODE_FILE_GET),
		];

		await ensureToolIndexBuilt("user-1", "org-example");

		expect(h.addServer).toHaveBeenCalledTimes(1);
	});

	it("does not re-index an identical cached definition, whatever its key order", async () => {
		const reordered = cachedFrom(CODE_TREE_V2);
		const schema = reordered.inputSchema as {
			properties: Record<string, unknown>;
		};
		// Same content, keys in another order at every level.
		reordered.inputSchema = {
			required: [],
			properties: {
				offset: schema.properties.offset,
				repo: schema.properties.repo,
				directory: schema.properties.directory,
			},
			type: "object",
		};
		h.cached = [cachedFrom(CODE_FILE_GET), reordered];

		await ensureToolIndexBuilt("user-1", "org-example");

		expect(h.addServer).not.toHaveBeenCalled();
	});

	it("does not re-index the real catalog after a JSON round trip (as Qdrant stores it)", async () => {
		const actual = await vi.importActual<
			typeof import("../src/activities/orchestrator/tools/fabric-ai-tools")
		>("../src/activities/orchestrator/tools/fabric-ai-tools");
		const real = actual.getFabricAiTools();
		h.current = real as typeof h.current;
		h.cached = real.map((tool) => ({
			toolName: tool.name,
			description: tool.description || "",
			inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)),
		}));

		await ensureToolIndexBuilt("user-1", "org-example");

		expect(real.length).toBeGreaterThan(0);
		expect(h.addServer).not.toHaveBeenCalled();
	});
});
