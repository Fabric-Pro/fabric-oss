import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySession } from "../types";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	search: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	read: vi.fn(),
	schedule: vi.fn(),
	audit: vi.fn(),
}));
vi.mock("@repo/api/modules/agent-deployments/lib/run-commands", () => ({
	listAgentRunCommand: m.list,
	getAgentRunCommand: m.get,
	cancelAgentRunCommand: m.cancel,
	readAgentRunScheduleCommand: m.read,
	scheduleAgentRunCommand: m.schedule,
}));
vi.mock("@repo/api/modules/agent-deployments/lib/run-history", () => ({
	searchAgentRunCommand: m.search,
}));
vi.mock("@repo/database", () => ({ recordAudit: m.audit }));

import { createAgentRunTools } from "../tools/agent-run-tools";

const session: GatewaySession = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	userName: "Example",
	email: "dev@example.com",
	role: "user",
	credential: "organization-key",
	scopes: ["agents:read", "agents:execute", "agents:schedule"],
	createdAt: new Date(0),
	expiresAt: new Date(100000),
};
const family = createAgentRunTools();
const invoke = (
	name: string,
	input: Record<string, unknown>,
	override: Partial<GatewaySession> = {},
) => {
	const handler = family.handlers.get(name);
	if (!handler) {
		throw new Error("Missing handler");
	}
	return handler(input, { ...session, ...override });
};
const input = {
	instanceId: "example-instance",
	cronExpression: "0 9 * * *",
	timezone: "UTC",
	input: { message: "Report" },
	enabled: true,
};
beforeEach(() => {
	vi.resetAllMocks();
	for (const fn of [m.search, m.list, m.get, m.cancel, m.read, m.schedule]) {
		fn.mockResolvedValue({ status: "RUNNING" });
	}
});
describe("agent run MCP adapters", () => {
	it.each([
		["fabric_list_agent_runs", { instanceId: input.instanceId }, "list"],
		["fabric_get_agent_run", { executionId: "example-row" }, "get"],
		[
			"fabric_get_agent_run_schedule",
			{ instanceId: input.instanceId },
			"read",
		],
	] as const)(
		"%s uses the shared command and server principal",
		async (name, args, command) => {
			const result = await invoke(name, args);
			expect(result.isError).not.toBe(true);
			expect(m[command]).toHaveBeenCalledWith(
				{
					userId: session.userId,
					organizationId: session.organizationId,
					external: true,
				},
				expect.objectContaining(args),
			);
		},
	);
	it.each([["mcp:write"], ["agents:execute"], ["agents:schedule"]])(
		"does not grant persistent work through legacy or incomplete scopes (%s)",
		async (...scopes) => {
			expect(
				(
					await invoke("fabric_set_agent_run_schedule", input, {
						scopes,
					})
				).isError,
			).toBe(true);
			expect(m.schedule).not.toHaveBeenCalled();
		},
	);
	it("passes wildcard to the live authority service without bypassing its denial", async () => {
		m.schedule.mockRejectedValue(new Error("Denied"));
		expect(
			(
				await invoke("fabric_set_agent_run_schedule", input, {
					scopes: ["*"],
				})
			).isError,
		).toBe(true);
		expect(m.schedule).toHaveBeenCalledOnce();
	});
	it.each([
		{ projectId: "example-project" },
		{ pinnedProjectId: "example-project" },
		{ credential: "service" as const },
		{ organizationId: null },
	])(
		"fails closed for unsupported connection authority",
		async (override) => {
			expect(
				(
					await invoke(
						"fabric_list_agent_runs",
						{ instanceId: input.instanceId },
						override,
					)
				).isError,
			).toBe(true);
			expect(m.list).not.toHaveBeenCalled();
		},
	);
	it("rejects actor or workflow identity injection", async () => {
		expect(
			(
				await invoke("fabric_cancel_agent_run", {
					executionId: "example-row",
					runId: "another-run",
				})
			).isError,
		).toBe(true);
		expect(m.cancel).not.toHaveBeenCalled();
	});
	it("records key authority and keeps cancellation acknowledgement nonterminal", async () => {
		m.cancel.mockImplementation(async (_actor, _input, audit) => {
			await audit({
				action: "org.agent_execution.cancel_requested",
				organizationId: session.organizationId,
			});
			return { requested: true, status: "RUNNING" };
		});
		const result = await invoke("fabric_cancel_agent_run", {
			executionId: "example-row",
		});
		expect(JSON.stringify(result)).toContain("requested");
		expect(m.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				actor: { type: "api_key", userId: session.userId },
				metadata: { via: "mcp" },
			}),
		);
	});
	it("declares recurring-work confirmation and separate schedule scope", () => {
		expect(family.scopes.fabric_set_agent_run_schedule).toEqual({
			scope: "agents:schedule",
			kind: "write",
		});
		expect(
			family.definitions.find((t) => t.name === "fabric_cancel_agent_run")
				?.description,
		).toContain("not undone");
	});
});

describe("MCP paged agent history", () => {
	it("uses the same authorized query and carries only declared filters", async () => {
		const args = {
			instanceId: "example-instance",
			status: "FAILED",
			triggerType: "SCHEDULE",
			query: "progress",
			cursor: "opaque_cursor",
			limit: 25,
		};
		expect(
			(await invoke("fabric_search_agent_runs", args)).isError,
		).not.toBe(true);
		expect(m.search).toHaveBeenCalledWith(
			{
				userId: session.userId,
				organizationId: session.organizationId,
				external: true,
			},
			args,
		);
		expect(family.scopes.fabric_search_agent_runs).toEqual({
			scope: "agents:read",
			kind: "read",
		});
	});
	it.each([
		{ scopes: ["mcp:read"] },
		{ scopes: [] },
		{ projectId: "example-project" },
		{ pinnedProjectId: "example-project" },
		{ credential: "service" as const },
		{ organizationId: null },
	])("refuses unsupported credential authority: %j", async (override) => {
		expect(
			(await invoke("fabric_search_agent_runs", {}, override)).isError,
		).toBe(true);
		expect(m.search).not.toHaveBeenCalled();
	});
	it("passes wildcard only to the live permission service and propagates refusal", async () => {
		m.search.mockRejectedValue(new Error("Denied"));
		expect(
			(await invoke("fabric_search_agent_runs", {}, { scopes: ["*"] }))
				.isError,
		).toBe(true);
		expect(m.search).toHaveBeenCalledOnce();
	});
	it("rejects organization/actor injection and invalid range/bounds", async () => {
		for (const args of [
			{ organizationId: "other-org" },
			{ userId: "other-user" },
			{ limit: 51 },
			{ from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" },
		]) {
			expect(
				(await invoke("fabric_search_agent_runs", args)).isError,
			).toBe(true);
		}
		expect(m.search).not.toHaveBeenCalled();
	});
});

it.each(["example-v1", null])(
	"preserves current and original version IDs in MCP history content (%s)",
	async (originalInstanceId) => {
		const history = {
			executions: [
				{
					id: "example-run",
					instanceId: "example-v2",
					executionInstanceId: originalInstanceId,
					agentName: "Current delivery reporter",
					task: "Report progress",
					status: "COMPLETED",
					lastRecordedStatus: "COMPLETED",
					queuedAt: "2026-01-01T09:00:00Z",
					createdAt: "2026-01-01T09:00:01Z",
					completedAt: "2026-01-01T09:00:04Z",
					duration: 3000,
					triggerType: "MANUAL",
				},
			],
			nextCursor: null,
		};
		m.search.mockResolvedValue(history);
		const result = await invoke("fabric_search_agent_runs", {});
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.content[0].text ?? "{}")).toEqual(history);
	},
);
