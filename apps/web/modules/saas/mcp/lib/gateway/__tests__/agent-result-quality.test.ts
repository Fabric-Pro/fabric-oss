import { SavedEvaluationError } from "@repo/api/modules/context-quality/saved-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentResultQualityTools } from "../tools/agent-result-quality-tools";
import type { GatewaySession, ToolCallResult } from "../types";

const commands = vi.hoisted(() => ({ inspect: vi.fn(), evaluate: vi.fn() }));
vi.mock("@repo/api/modules/context-quality/lib/agent-result", () => ({
	agentResultCommands: async () => commands,
}));
const authorize = vi.fn<
	() => Promise<{ organizationId: string | null } | null>
>(async () => ({ organizationId: "example-org" }));
const tools = createAgentResultQualityTools(authorize);
const session: GatewaySession = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	userName: "Example",
	email: "agent@example.com",
	role: "user",
	credential: "personal-key",
	scopes: ["projects:read", "agents:read"],
	createdAt: new Date(),
	expiresAt: new Date(Date.now() + 60000),
};
const args = { projectId: "example-project", executionId: "example-execution" };
const actor = {
	projectId: args.projectId,
	userId: session.userId,
	organizationId: session.organizationId,
};
const expectations = {
	expectedRevision: "a".repeat(64),
	requiredPhrases: ["Example result"],
	forbiddenPhrases: [],
};
function call(name: string, input = args, current = session) {
	const handler = tools.handlers.get(name);
	if (!handler) {
		throw new Error("Expected registered run-result tool");
	}
	return handler(input, current);
}
const payload = (result: ToolCallResult) => JSON.parse(result.content[0].text);
beforeEach(() => {
	vi.resetAllMocks();
	authorize.mockResolvedValue({ organizationId: "example-org" });
	commands.inspect.mockResolvedValue({
		recordedAnswer: "Example result",
		saved: false,
	});
	commands.evaluate.mockResolvedValue({
		status: "passed",
		origin: { saved: false },
	});
});
describe("actual agent-result Quality MCP boundary", () => {
	it.each([
		"fabric_inspect_agent_run_result",
		"fabric_check_agent_run_result",
	])("declares %s as a read rather than an agent invocation", (name) => {
		expect(
			tools.definitions.find((tool) => tool.name === name)?.annotations
				?.readOnlyHint,
		).toBe(true);
		expect(tools.scopes[name]).toEqual({
			scope: "projects:read",
			kind: "read",
		});
	});
	it("uses the authenticated actor and exact inspected execution", async () => {
		expect(
			(await call("fabric_inspect_agent_run_result")).isError,
		).not.toBe(true);
		expect(commands.inspect).toHaveBeenCalledExactlyOnceWith(actor, {
			executionId: args.executionId,
		});
	});
	it("passes bounded expectations to the shared real-result command without an answer", async () => {
		expect(
			payload(
				await call("fabric_check_agent_run_result", {
					...args,
					...expectations,
				}),
			),
		).toMatchObject({ status: "passed" });
		expect(commands.evaluate).toHaveBeenCalledExactlyOnceWith(actor, {
			executionId: args.executionId,
			...expectations,
		});
	});
	it.each(
		[
			["projects:read"],
			["agents:read"],
			["agents:read", "mcp:read"],
			["projects:read", "mcp:read"],
			["mcp:read"],
		].map((scopes) => ({ scopes })),
	)(
		"requires explicit project and agent scopes beyond $scopes",
		async ({ scopes }) => {
			const result = await call("fabric_inspect_agent_run_result", args, {
				...session,
				scopes,
			});
			expect(payload(result).code).toBe("INSUFFICIENT_SCOPE");
			expect(authorize).not.toHaveBeenCalled();
			expect(commands.inspect).not.toHaveBeenCalled();
		},
	);
	it("wildcard scopes still call current project and owner authorization", async () => {
		commands.inspect.mockRejectedValueOnce(
			new SavedEvaluationError(
				"FORBIDDEN",
				"Current owner access required.",
			),
		);
		const result = await call("fabric_inspect_agent_run_result", args, {
			...session,
			scopes: ["*"],
		});
		expect(payload(result).code).toBe("FORBIDDEN");
		expect(authorize).toHaveBeenCalledWith(
			args.projectId,
			expect.objectContaining({ userId: session.userId }),
		);
		expect(commands.inspect).toHaveBeenCalledWith(actor, {
			executionId: args.executionId,
		});
	});
	it("refuses a foreign project connection before reading results", async () => {
		const result = await call("fabric_inspect_agent_run_result", args, {
			...session,
			projectId: "example-other-project",
			scopes: ["*"],
		});
		expect(payload(result).code).toBe("NOT_FOUND");
		expect(authorize).not.toHaveBeenCalled();
		expect(commands.inspect).not.toHaveBeenCalled();
	});
	it("requires current project authorization even when credential scopes suffice", async () => {
		authorize.mockResolvedValueOnce(null);
		expect(
			payload(await call("fabric_inspect_agent_run_result")).code,
		).toBe("NOT_FOUND");
		expect(commands.inspect).not.toHaveBeenCalled();
	});
	it.each([
		{ userId: "example-other-user" },
		{ organizationId: "example-other-org" },
		{ recordedAnswer: "Fabricated success" },
		{ retrievedSourceIds: ["example-source"] },
	])(
		"rejects client-supplied answer or authority before command execution",
		async (extra) => {
			expect(
				payload(
					await call("fabric_check_agent_run_result", {
						...args,
						...expectations,
						...extra,
					}),
				).code,
			).toBe("BAD_REQUEST");
			expect(authorize).not.toHaveBeenCalled();
			expect(commands.evaluate).not.toHaveBeenCalled();
		},
	);
	it.each([
		"fabric_inspect_agent_run_result",
		"fabric_check_agent_run_result",
	])(
		"refuses model runtime service calls for %s even with wildcard scopes",
		async (name) => {
			const result = await call(
				name,
				{ ...args, ...expectations },
				{ ...session, credential: "service", scopes: ["*"] },
			);
			expect(payload(result).code).toBe("FORBIDDEN");
			expect(authorize).not.toHaveBeenCalled();
			expect(commands.inspect).not.toHaveBeenCalled();
			expect(commands.evaluate).not.toHaveBeenCalled();
		},
	);
	it("preserves stale revision refusals and redacts unknown native errors", async () => {
		commands.evaluate.mockRejectedValueOnce(
			new SavedEvaluationError(
				"CONFLICT",
				"The result changed. Inspect again.",
			),
		);
		expect(
			payload(
				await call("fabric_check_agent_run_result", {
					...args,
					...expectations,
				}),
			).code,
		).toBe("CONFLICT");
		commands.inspect.mockRejectedValueOnce(
			new Error("example private native diagnostic"),
		);
		const result = await call("fabric_inspect_agent_run_result");
		expect(payload(result).code).toBe("SERVICE_UNAVAILABLE");
		expect(JSON.stringify(result)).not.toContain("private native");
	});
});
