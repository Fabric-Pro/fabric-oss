/**
 * A session bound to one project is offered that project's platform tools and
 * no connected server's, and cannot call one.
 *
 * Connected servers are the person's and the organization's. They have no tie
 * to a project and no scope check, so the bound path never discovers them: it
 * does not read the shared per-user tool cache and does not fill it, which is
 * what keeps an organization-wide session of the same person unaffected.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const listMcpConfigsForTenant = vi.hoisted(() => vi.fn());

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", () => ({ listMcpConfigsForTenant }));

import { PROJECT_BOUND_TOOL_NAMES } from "../project-binding";
import {
	executeConnectedServerTool,
	getAggregatedTools,
} from "../tool-aggregator";
import type { GatewaySession } from "../types";

function session(overrides: Partial<GatewaySession> = {}): GatewaySession {
	return {
		sessionId: "session-1",
		userId: "user-aggregator",
		organizationId: "org-example-alpha",
		projectId: null,
		userName: "Dev",
		email: "dev@example.com",
		role: "user",
		credential: "oauth",
		scopes: ["mcp:read"],
		createdAt: new Date("2026-10-04T12:00:00Z"),
		expiresAt: new Date("2026-10-05T12:00:00Z"),
		...overrides,
	};
}

const bound = () => session({ projectId: "project-example-one" });

beforeEach(() => {
	vi.clearAllMocks();
	listMcpConfigsForTenant.mockResolvedValue([]);
});

describe("the tools offered to a project-bound session", () => {
	it("are the project's platform tools and nothing from a connected server", async () => {
		const { tools, servers } = await getAggregatedTools(bound());

		expect(tools.map((tool) => tool.name).sort()).toEqual(
			[...PROJECT_BOUND_TOOL_NAMES].sort(),
		);
		expect(servers).toEqual([]);
	});

	it("are found without discovering the person's connected servers", async () => {
		await getAggregatedTools(bound());

		expect(listMcpConfigsForTenant).not.toHaveBeenCalled();
	});

	it("leave the shared cache alone, in both directions", async () => {
		const wideSession = session({ userId: "user-cache" });
		const boundSession = session({
			userId: "user-cache",
			projectId: "project-example-one",
		});

		await getAggregatedTools(boundSession);
		expect(listMcpConfigsForTenant).not.toHaveBeenCalled();

		const wide = await getAggregatedTools(wideSession);
		expect(listMcpConfigsForTenant).toHaveBeenCalledOnce();
		expect(wide.tools.length).toBeGreaterThan(
			PROJECT_BOUND_TOOL_NAMES.length,
		);

		const again = await getAggregatedTools(boundSession);
		expect(again.tools.map((tool) => tool.name).sort()).toEqual(
			[...PROJECT_BOUND_TOOL_NAMES].sort(),
		);
		expect(listMcpConfigsForTenant).toHaveBeenCalledOnce();
	});
});

describe("a connected server's tool on a project-bound session", () => {
	it("is refused before any lookup, whatever server the name points at", async () => {
		const result = await executeConnectedServerTool(
			"linear__list_issues",
			{},
			bound(),
			[
				{
					configId: "config-1",
					displayName: "Linear",
					toolPrefix: "linear",
					tools: [{ name: "list_issues" }],
				},
			],
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(
			"not available on a connection to one project",
		);
		expect(listMcpConfigsForTenant).not.toHaveBeenCalled();
	});
});
