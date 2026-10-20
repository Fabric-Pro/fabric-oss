import { describe, expect, it } from "vitest";
import { buildAgentConfigurable } from "../src/services/agent-configurable";

describe("buildAgentConfigurable", () => {
	it("maps model, tenant and usage fields without granting tool authentication", () => {
		const input = {
			ai_api_key: "test-key",
			ai_model: "example-model",
			ai_provider: "openai",
			ai_base_url: "https://example.com",
			ai_deployment_name: "example-deployment",
			ai_is_reasoning: false,
			tenant_user_id: "example-user",
			tenant_organization_id: "example-org",
			ai_token: "test-token",
			ai_billing_mode: "example-mode",
			ai_billing_customer_id: "example-customer",
			ai_plan_source: "example-plan",
			project_id: "example-project",
			usage_conversation_id: "example-conversation",
		};
		expect(buildAgentConfigurable(input)).toEqual({
			ai_api_key: input.ai_api_key,
			ai_model: input.ai_model,
			ai_provider: input.ai_provider,
			ai_gateway_url: input.ai_base_url,
			ai_deployment_name: input.ai_deployment_name,
			ai_is_reasoning: false,
			tenant_user_id: input.tenant_user_id,
			tenant_organization_id: input.tenant_organization_id,
			usage_conversation_id: input.usage_conversation_id,
			fabric_usage: {
				ai_token: input.ai_token,
				ai_model: input.ai_model,
				ai_provider: input.ai_provider,
				ai_billing_mode: input.ai_billing_mode,
				ai_billing_customer_id: input.ai_billing_customer_id,
				ai_plan_source: input.ai_plan_source,
				project_id: input.project_id,
				usage_conversation_id: input.usage_conversation_id,
			},
		});
	});
	it("prefers runtime values and normalizes runtime base URLs", () => {
		const keys = [
			"ai_api_key",
			"ai_model",
			"ai_provider",
			"ai_deployment_name",
			"tenant_user_id",
			"tenant_organization_id",
			"usage_conversation_id",
			"ai_token",
			"ai_billing_mode",
			"ai_billing_customer_id",
			"ai_plan_source",
			"project_id",
		];
		const input = Object.fromEntries(
			keys.map((key) => [key, "input-example"]),
		);
		const runtime = Object.fromEntries(
			keys.map((key) => [key, "runtime-example"]),
		);
		const result = buildAgentConfigurable(
			{
				...input,
				ai_gateway_url: "https://input.example.com",
				ai_is_reasoning: true,
			},
			{
				...runtime,
				ai_base_url: "https://runtime.example.com",
				ai_is_reasoning: false,
			},
		);
		for (const key of keys.slice(0, 7)) {
			expect(result[key]).toBe("runtime-example");
		}
		expect(result.fabric_usage).toEqual(
			Object.fromEntries(
				keys
					.slice(7)
					.concat([
						"ai_model",
						"ai_provider",
						"usage_conversation_id",
					])
					.map((key) => [key, "runtime-example"]),
			),
		);
		expect(result.ai_gateway_url).toBe("https://runtime.example.com");
		expect(result.ai_is_reasoning).toBe(false);
		expect(result).not.toHaveProperty("ai_token");
	});
	it("omits absent and invalid fields and retains logger config", () => {
		expect(
			buildAgentConfigurable({
				ai_api_key: "",
				ai_model: null,
				ai_provider: 3,
				ai_is_reasoning: undefined,
			}),
		).toEqual({ fabric_usage: {} });
		expect(
			buildAgentConfigurable({
				userId: "example-user",
				organizationId: "example-org",
			}),
		).toEqual({ fabric_usage: {} });
	});
});

it("uses the normalized A2A base URL and ignores untrusted endpoint aliases", () => {
	expect(
		buildAgentConfigurable({
			ai_base_url: "https://resolved.example.com",
			ai_gateway_url: "https://untrusted.example.com",
		}).ai_gateway_url,
	).toBe("https://resolved.example.com");
	expect(
		buildAgentConfigurable({
			ai_gateway_url: "https://untrusted.example.com",
		}),
	).not.toHaveProperty("ai_gateway_url");
});
it("does not fill missing reserved runtime values from invocation input", () => {
	const result = buildAgentConfigurable(
		{
			ai_base_url: "https://untrusted.example.com",
			tenant_user_id: "other-user",
			tenant_organization_id: "other-org",
			ai_deployment_name: "untrusted",
			ai_billing_mode: "untrusted",
		},
		{
			tenant_user_id: undefined,
			tenant_organization_id: undefined,
			ai_gateway_url: undefined,
			ai_deployment_name: undefined,
			ai_billing_mode: undefined,
		},
	);
	expect(result).toEqual({ fabric_usage: {} });
});

it("ignores a gateway-only input alias", () => {
	expect(
		buildAgentConfigurable({
			ai_gateway_url: "https://untrusted.example.com",
		}),
	).not.toHaveProperty("ai_gateway_url");
});

it("carries a sanitized pin and treats supplied runtime context as authoritative", () => {
	expect(buildAgentConfigurable({ ai_model_pinned: true })).toHaveProperty(
		"ai_model_pinned",
		true,
	);
	expect(
		buildAgentConfigurable({ ai_model_pinned: true }, {}),
	).not.toHaveProperty("ai_model_pinned");
	expect(
		buildAgentConfigurable({}, { ai_model_pinned: true }),
	).toHaveProperty("ai_model_pinned", true);
	expect(
		buildAgentConfigurable({ ai_model_pinned: "true" }),
	).not.toHaveProperty("ai_model_pinned");
});

it("carries server-stamped model caps without falling back to input when runtime config exists", () => {
	const input = {
		ai_model_pinned: true,
		ai_max_output_tokens: 8192,
		ai_context_window: 32768,
		ai_is_reasoning: true,
	};
	expect(buildAgentConfigurable(input)).toMatchObject(input);
	const result = buildAgentConfigurable(input, {
		ai_model_pinned: true,
		ai_is_reasoning: false,
	});
	expect(result.ai_is_reasoning).toBe(false);
	expect(result).not.toHaveProperty("ai_max_output_tokens");
	expect(result).not.toHaveProperty("ai_context_window");
});
