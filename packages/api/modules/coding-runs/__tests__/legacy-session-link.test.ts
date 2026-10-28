import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	handler: undefined as unknown as (args: any) => Promise<any>,
	get: vi.fn(),
}));
vi.mock("@repo/database", () => ({ getCodingRun: f.get }));
vi.mock("../../../orpc/procedures", () => {
	const chain: any = {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		handler: (handler: any) => {
			f.handler = handler;
			return {};
		},
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: { AGENT_READ: "agent:read" },
		requireInputOrgPermission: () => vi.fn(),
		resolveOrganizationId: () => "example-org",
	};
});
import "../procedures/get-coding-run";
const run = {
	id: "example-run",
	provider: "BACKGROUND_AGENTS",
	providerSessionId: "example-session",
	externalUrl: null,
	providerMetadata: null,
};
const invoke = () =>
	f.handler({
		input: { id: run.id },
		context: { user: { id: "example-user" }, session: {} },
	});
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", undefined);
	vi.stubEnv("NEXT_PUBLIC_BACKGROUND_AGENTS_URL", "https://example.com");
	f.get.mockResolvedValue(run);
});
afterEach(() => vi.unstubAllEnvs());
it("preserves the configured legacy link for existing unclassified runs before cutover", async () => {
	expect(await invoke()).toMatchObject({
		externalUrl: "https://example.com/session/example-session",
	});
	expect(f.get).toHaveBeenCalledWith(run.id, "example-user", "example-org");
});
it("retains links for newly identified legacy runs", async () => {
	f.get.mockResolvedValue({
		...run,
		providerMetadata: { executionRuntime: "legacy-background-agents" },
	});
	expect(await invoke()).toMatchObject({
		externalUrl: "https://example.com/session/example-session",
	});
});
it("does not guess headless links for an identified native session", async () => {
	f.get.mockResolvedValue({
		...run,
		providerMetadata: { executionRuntime: "fabric-agent-server" },
	});
	expect(await invoke()).toMatchObject({ externalUrl: null });
});
it("does not infer any legacy link after native cutover", async () => {
	vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "true");
	expect(await invoke()).toMatchObject({ externalUrl: null });
});
it("preserves canonical desktop links", async () => {
	const externalUrl =
		"fabricagents://workspace/example-workspace/allSessions/session/example-session";
	f.get.mockResolvedValue({ ...run, externalUrl });
	expect(await invoke()).toMatchObject({ externalUrl });
});
