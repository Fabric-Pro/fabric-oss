import { expect, it, vi } from "vitest";
import { createInvokeAgent } from "../invoke-agent";

it("forwards delegated model, tenant and logger-only usage config to the graph", async () => {
	const invoke = vi.fn().mockResolvedValue({ messages: [] });
	const run = createInvokeAgent({ invoke });
	await run({
		messages: [{ role: "user", content: "hello" }],
		ai_api_key: "test-key",
		ai_model: "example-model",
		tenant_user_id: "example-user",
		tenant_organization_id: "example-org",
		ai_token: "test-token",
		ai_provider: "openai",
	});
	expect(invoke).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			configurable: expect.objectContaining({
				ai_api_key: "test-key",
				ai_model: "example-model",
				tenant_user_id: "example-user",
				tenant_organization_id: "example-org",
				fabric_usage: expect.objectContaining({
					ai_token: "test-token",
				}),
			}),
		}),
	);
	expect(invoke.mock.calls[0][1].configurable).not.toHaveProperty("ai_token");
});

it("prefers the exchanged runtime model and tenant on direct-chat fallbacks", async () => {
	const invoke = vi.fn().mockResolvedValue({ messages: [] });
	const run = createInvokeAgent({ invoke });
	await run(
		{
			messages: [],
			ai_api_key: "input-key",
			ai_model: "input-model",
			tenant_user_id: "input-user",
		},
		{
			configurable: {
				ai_api_key: "test-key",
				ai_model: "example-model",
				tenant_user_id: "example-user",
				ai_token: "test-token",
				ai_provider: "openai",
			},
		},
	);
	expect(invoke.mock.calls[0][1].configurable).toMatchObject({
		ai_api_key: "test-key",
		ai_model: "example-model",
		tenant_user_id: "example-user",
		fabric_usage: {
			ai_token: "test-token",
			ai_provider: "openai",
			ai_model: "example-model",
		},
	});
	expect(invoke.mock.calls[0][1].configurable).not.toHaveProperty("ai_token");
});

it("preserves a terminal graph error for the A2A transform", async () => {
	const run = createInvokeAgent({
		invoke: vi.fn().mockResolvedValue({
			messages: [],
			error: "Unable to enhance prompt",
		}),
	});
	expect(await run({ messages: [] })).toMatchObject({
		error: "Unable to enhance prompt",
	});
});
