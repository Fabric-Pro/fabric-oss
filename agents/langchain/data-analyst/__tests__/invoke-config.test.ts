import { expect, it, vi } from "vitest";
import type { LangGraphExecutor } from "@repo/agent-core/unified-server";
const captured = vi.hoisted(() => ({
	invoke: vi.fn().mockResolvedValue({ messages: [] }),
	run: undefined as LangGraphExecutor | undefined,
}));
vi.mock("@repo/agent-core", () => ({
	createUnifiedServer: (_config: unknown, run: LangGraphExecutor) => {
		captured.run = run;
		return { app: {}, start: vi.fn() };
	},
}));
vi.mock("../lib/agent/graph.js", () => ({
	createDataAnalystGraph: () => ({ invoke: captured.invoke }),
	getGeneratedArtifacts: () => [],
	getConnectionSuggestionArtifacts: () => [],
	clearArtifacts: vi.fn(),
	DEFAULT_RECURSION_LIMIT: 30,
}));
import "../unified-server";
it("preserves the existing tool credential boundary during model config migration", async () => {
	await captured.run?.({
		messages: [{ role: "user", content: "hello" }],
		ai_api_key: "test-key",
		ai_model: "example-model",
		tenant_user_id: "example-user",
		ai_token: "test-token",
		ai_base_url: "https://base.example.com",
		ai_gateway_url: "https://gateway.example.com",
	});
	expect(captured.invoke).toHaveBeenCalledTimes(1);
	const config = captured.invoke.mock.calls[0][1].configurable;
	expect(config).toMatchObject({
		ai_api_key: "test-key",
		ai_model: "example-model",
		tenant_user_id: "example-user",
		fabric_usage: { ai_token: "test-token", ai_model: "example-model" },
	});
	expect(config.ai_token).toBe("test-token");
	expect(config.ai_gateway_url).toBe("https://base.example.com");
});
