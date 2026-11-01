import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	handler: undefined as any,
	run: vi.fn(),
	projectAccess: vi.fn(),
	server: vi.fn(),
	messages: vi.fn(),
	provider: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getCodingRun: f.run,
	hasProjectAccess: f.projectAccess,
	db: { projectRemoteAgentServer: { findFirst: f.server } },
	getRemoteAgentServerForActor: vi.fn(),
}));
vi.mock("@repo/temporal/coding-execution", () => ({
	getCodingExecutionProvider: f.provider,
}));
vi.mock("../../../orpc/procedures", () => {
	const chain: any = {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		handler: (fn: any) => {
			f.handler = fn;
			return {};
		},
	};
	return {
		tenantProtectedProcedure: chain,
		requireInputOrgPermission: vi.fn(),
		Permissions: { AGENT_READ: "agent:read" },
		resolveOrganizationId: (id: string) => id,
	};
});
import "../procedures/session-messages";
const request = {
	input: { id: "example-run", organizationId: "example-org" },
	context: { user: { id: "example-user" }, session: {} },
};
beforeEach(() => {
	vi.clearAllMocks();
	f.run.mockResolvedValue({
		id: "example-run",
		projectId: "example-project",
		provider: "BACKGROUND_AGENTS",
		providerSessionId: "example-session",
		providerMetadata: {
			executionRuntime: "fabric-agent-server",
			executionTarget: { connectionId: "example-connection" },
		},
	});
	f.projectAccess.mockResolvedValue(true);
	f.server.mockResolvedValue({ id: "example-connection" });
	f.messages.mockResolvedValue({
		messages: [
			{
				id: "example-message",
				role: "assistant",
				content: "Remote response",
			},
		],
		webUrl: "https://agents.example.com/?route=example-session",
	});
	f.provider.mockReturnValue({ getSessionMessages: f.messages });
});
it("loads the existing run's native conversation and forwards the resolved tenant", async () => {
	expect((await f.handler(request)).available).toBe(true);
	expect(f.run).toHaveBeenCalledWith(
		"example-run",
		"example-user",
		"example-org",
	);
	expect(f.messages).toHaveBeenCalledWith("example-session");
	expect(f.server.mock.calls[0][0].where).toMatchObject({
		id: "example-connection",
		projectId: "example-project",
		OR: [{ userId: "example-user" }, { scope: "TEAM" }],
	});
});
it("denies project outsiders before contacting the execution host", async () => {
	f.projectAccess.mockResolvedValue(false);
	await expect(f.handler(request)).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
	expect(f.provider).not.toHaveBeenCalled();
});
it("denies another developer's private connection even to a project member", async () => {
	f.server.mockResolvedValue(null);
	await expect(f.handler(request)).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(f.provider).not.toHaveBeenCalled();
});
