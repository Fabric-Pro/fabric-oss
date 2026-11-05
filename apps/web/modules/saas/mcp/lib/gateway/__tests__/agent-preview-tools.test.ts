import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySession } from "../types";

const m = vi.hoisted(() => ({
	start: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	audit: vi.fn(),
}));
vi.mock("@repo/api/modules/agents/lib/agent-preview-commands", async () => {
	const { z } = await import("zod");
	return {
		agentPreviewIdentitySchema: z.strictObject({
			workflowId: z.string(),
			runId: z.string().optional(),
		}),
		startAgentPreviewCommand: m.start,
		getAgentPreviewCommand: m.get,
		cancelAgentPreviewCommand: m.cancel,
	};
});
vi.mock("@repo/database", () => ({ recordAudit: m.audit }));

import { createAgentPreviewTools } from "../tools/agent-preview-tools";

const session: GatewaySession = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	userName: "Example",
	email: "dev@example.com",
	role: "user",
	credential: "organization-key",
	scopes: ["agents:read", "agents:execute"],
	createdAt: new Date(0),
	expiresAt: new Date(100000),
};
const family = createAgentPreviewTools();
const invoke = (
	name: string,
	input: Record<string, unknown>,
	override: Partial<GatewaySession> = {},
) => {
	const handler = family.handlers.get(name);
	if (!handler) {
		throw new Error("Missing preview tool handler");
	}
	return handler(input, { ...session, ...override });
};
beforeEach(() => {
	vi.resetAllMocks();
	for (const fn of [m.start, m.get, m.cancel]) {
		fn.mockResolvedValue({ status: "RUNNING" });
	}
});
describe("draft preview MCP transport", () => {
	it.each(["start", "get", "cancel"])(
		"enforces selected workspace scopes for %s",
		async (operation) => {
			const selected = {
				workspaceIds: ["example-workspace"],
				skillIds: [],
			};
			m[operation as "get"].mockImplementation(
				async (...args: unknown[]) => {
					const policy = args[operation === "get" ? 2 : 3] as (
						draft: typeof selected,
					) => unknown;
					await policy(selected);
					return { status: "RUNNING" };
				},
			);
			const input =
				operation === "start"
					? {
							draft: {
								instructions: "Use selected knowledge",
								workspaceIds: ["example-workspace"],
							},
							userMessage: "Summarize",
							idempotencyKey:
								"fe0c414e-0909-4412-848b-41b515273339",
						}
					: { workflowId: "example-preview" };
			const name = `fabric_${operation}_agent_preview`;
			const result = await invoke(name, input);
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result)).toContain("INSUFFICIENT_SCOPE");
			expect(JSON.stringify(result)).toContain("workspaces:read");
			expect(
				(await invoke(name, input, { scopes: ["*"] })).isError,
			).not.toBe(true);
		},
	);
	it.each([
		["fabric_get_agent_preview", "get"],
		["fabric_cancel_agent_preview", "cancel"],
	])("uses the authorized shared command for %s", async (name, method) => {
		await invoke(name, {
			workflowId: "example-preview",
			runId: "example-run",
		});
		expect(m[method as "get"]).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			{ workflowId: "example-preview", runId: "example-run" },
			...(method === "cancel" ? [expect.any(Function)] : []),
			expect.any(Function),
		);
	});
	it("requires declared scope, including legacy write credentials", async () => {
		const result = await invoke(
			"fabric_cancel_agent_preview",
			{ workflowId: "example-preview" },
			{ scopes: ["mcp:write"] },
		);
		expect(result.isError).toBe(true);
		expect(m.cancel).not.toHaveBeenCalled();
	});
	it.each([
		{ projectId: "example-project" },
		{ pinnedProjectId: "example-project" },
		{ credential: "service" as const },
		{ organizationId: undefined },
	])("refuses unsupported connection boundary %j", async (override) => {
		expect(
			(
				await invoke(
					"fabric_get_agent_preview",
					{ workflowId: "example-preview" },
					override,
				)
			).isError,
		).toBe(true);
		expect(m.get).not.toHaveBeenCalled();
	});
	it("does not accept actor and tenant injection", async () => {
		expect(
			(
				await invoke("fabric_get_agent_preview", {
					workflowId: "example-preview",
					organizationId: "other-org",
				})
			).isError,
		).toBe(true);
		expect(m.get).not.toHaveBeenCalled();
	});
	it("does not bypass revoked live authority with wildcard keys", async () => {
		m.get.mockRejectedValue(
			Object.assign(new Error("Current access revoked"), {
				code: "FORBIDDEN",
			}),
		);
		const result = await invoke(
			"fabric_get_agent_preview",
			{ workflowId: "example-preview" },
			{ scopes: ["*"] },
		);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("Current access revoked");
	});
	it("advertises only working start/get/cancel operations", () => {
		expect(family.definitions.map((x) => x.name)).toEqual([
			"fabric_start_agent_preview",
			"fabric_get_agent_preview",
			"fabric_cancel_agent_preview",
		]);
	});
});
