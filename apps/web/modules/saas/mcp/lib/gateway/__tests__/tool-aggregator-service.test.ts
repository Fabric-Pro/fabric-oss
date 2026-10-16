/**
 * What Fabric's own agent runtime is offered through the gateway: the platform
 * tools its scopes reach, and none of the person's connected servers. It
 * already holds those connections itself, and discovering them here would
 * connect to every one on each chat turn.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listMcpConfigsForTenant: vi.fn(),
	getCachedMcpClientForConfig: vi.fn(),
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", () => ({
	listMcpConfigsForTenant: mocks.listMcpConfigsForTenant,
	updateMcpConfigToolCache: vi.fn(),
}));

vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: mocks.getCachedMcpClientForConfig,
}));

import { getAggregatedTools } from "../tool-aggregator";
import { SERVICE_CREDENTIAL_SCOPES } from "../tool-scope";
import type { GatewaySession } from "../types";

function session(overrides: Partial<GatewaySession> = {}): GatewaySession {
	return {
		sessionId: "session-1",
		userId: "user-1",
		organizationId: "org-example-alpha",
		projectId: null,
		userName: "Dev",
		email: "dev@example.com",
		role: "user",
		credential: "service",
		scopes: [...SERVICE_CREDENTIAL_SCOPES],
		createdAt: new Date("2026-10-04T12:00:00Z"),
		expiresAt: new Date("2026-10-05T12:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("tools offered to the service credential", () => {
	it("are the workflow, frame and page tools, and nothing else", async () => {
		const { tools, servers } = await getAggregatedTools(session());

		const names = tools.map((tool) => tool.name);
		expect(servers).toEqual([]);
		expect(names).toEqual(
			expect.arrayContaining([
				"fabric_list_workflows",
				"fabric_create_workflow",
				"fabric_publish_workflow",
				"fabric_create_frame",
				"fabric_list_frames",
			]),
		);
		expect(
			names.filter((name) => !/workflow|frame|slideshow|page/.test(name)),
		).toEqual([]);
	});

	it("is not offered a read on the person's connected servers, which needs mcp:read", async () => {
		const { tools } = await getAggregatedTools(session());

		expect(tools.map((tool) => tool.name)).not.toContain(
			"fabric_page_read_connected",
		);
	});

	it("never discovers the person's connected servers", async () => {
		await getAggregatedTools(session());

		expect(mocks.listMcpConfigsForTenant).not.toHaveBeenCalled();
		expect(mocks.getCachedMcpClientForConfig).not.toHaveBeenCalled();
	});

	it("is cut to the scopes the session holds", async () => {
		const { tools } = await getAggregatedTools(
			session({ scopes: ["workflows:read"] }),
		);

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"fabric_get_workflow",
			"fabric_get_workflow_execution",
			"fabric_list_workflow_runs",
			"fabric_list_workflows",
		]);
	});
});
