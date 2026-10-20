import { expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	invoke: vi.fn().mockResolvedValue({ messages: [] }),
	run: undefined as
		| ((input: Record<string, unknown>) => Promise<unknown>)
		| undefined,
}));
vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
vi.mock("@repo/agent-core", () => ({
	A2AServer: class {
		createHandlers() {
			return {};
		}
	},
	createLangGraphA2AExecutor: (run: typeof captured.run) => {
		captured.run = run;
		return {};
	},
}));
vi.mock("../agent.js", () => ({ apiAgentGraph: { invoke: captured.invoke } }));
import "../a2a-server";
it("does not use reserved body fields in the unauthenticated legacy server", async () => {
	const reserved = {
		tenant_user_id: "other-user",
		tenant_organization_id: "other-org",
		ai_gateway_url: "https://untrusted.example.com",
		ai_base_url: "https://untrusted.example.com",
		ai_deployment_name: "untrusted",
		ai_billing_mode: "untrusted",
		ai_billing_customer_id: "untrusted",
		ai_plan_source: "untrusted",
		user_id: "other-user",
		organization_id: "other-org",
	};
	await captured.run?.({
		messages: [],
		...reserved,
		userId: "other-user",
		organizationId: "other-org",
	});
	expect(captured.invoke).toHaveBeenCalledTimes(1);
	const config = captured.invoke.mock.calls[0][1].configurable;
	for (const key of Object.keys(reserved)) {
		expect(config[key], key).toBeUndefined();
	}
});
