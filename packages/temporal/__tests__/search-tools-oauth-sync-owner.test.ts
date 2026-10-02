/**
 * `ensureToolIndexBuilt` re-ingests GitHub / Microsoft Teams OAuth tools when
 * the caller's connection is out of date. In an organization it must only ever
 * consider the CALLER's own connection: each member's connection is a personal
 * OAuth grant, and ingesting a teammate's integration would index tools the
 * caller cannot use (and that run on the teammate's account).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	connectionRow,
	type FakeWorkflowIntegrationRow,
} from "./helpers/workflow-integration-fake";

const state = vi.hoisted(() => ({
	rows: [] as FakeWorkflowIntegrationRow[],
}));

vi.mock("@repo/database", async () => {
	const { createWorkflowIntegrationFake } = await import(
		"./helpers/workflow-integration-fake"
	);
	return {
		db: {
			get workflowIntegration() {
				return createWorkflowIntegrationFake(state.rows);
			},
		},
	};
});

vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	closeMcpClientSafe: vi.fn(),
}));

vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	// No stored version → every found connection looks out of date.
	getCapabilitiesByTenant: vi.fn().mockResolvedValue([]),
	searchCapabilities: vi.fn().mockResolvedValue([]),
}));

const ingest = vi.hoisted(() => vi.fn());
vi.mock("../src/activities/oauth-tool-ingestion", () => ({
	ingestOAuthIntegrationToolsActivity: ingest,
}));

vi.mock("@repo/mcp-registry", () => ({
	GITHUB_ACCOUNT: { version: "1.0.0" },
	MICROSOFT_TEAMS_ACCOUNT: { version: "1.0.0" },
}));

vi.mock("../src/activities/orchestrator/tools/fabric-ai-tools", () => ({
	getFabricAiTools: vi.fn().mockReturnValue([]),
}));

class StopAfterSync extends Error {}

vi.mock("../src/activities/orchestrator/tools/tool-index", () => ({
	toolIndex: {
		needsRebuild: () => true,
		// The OAuth sync runs before the cache load; stop there.
		loadFromQdrant: () => Promise.reject(new StopAfterSync()),
	},
}));

import { ensureToolIndexBuilt } from "../src/activities/orchestrator/tools/search-tools";

// Teammate rows are seeded FIRST, so a lookup that drops userId in the
// organization arm picks them up.
const teammateRows = [
	connectionRow({
		id: "wi-gh-teammate",
		userId: "user-1",
		provider: "GITHUB",
	}),
	connectionRow({
		id: "wi-ms-teammate",
		userId: "user-1",
		provider: "MICROSOFT_GRAPH",
	}),
];
const callerRows = [
	connectionRow({ id: "wi-gh-caller", userId: "user-2", provider: "GITHUB" }),
	connectionRow({
		id: "wi-ms-caller",
		userId: "user-2",
		provider: "MICROSOFT_GRAPH",
	}),
];

async function sync() {
	await expect(
		ensureToolIndexBuilt("user-2", "org-example"),
	).rejects.toBeInstanceOf(StopAfterSync);
	return ingest.mock.calls.map(
		([input]) => (input as { integrationId: string }).integrationId,
	);
}

beforeEach(() => {
	ingest.mockReset();
	state.rows = [];
});

describe("search-tools OAuth version sync: connection owner", () => {
	it("org context: never ingests a teammate's GitHub or Teams connection", async () => {
		state.rows = [...teammateRows];

		expect(await sync()).toEqual([]);
	});

	it("org context: ingests only the caller's own connections", async () => {
		state.rows = [...teammateRows, ...callerRows];

		expect(await sync()).toEqual(["wi-ms-caller", "wi-gh-caller"]);
	});
});
