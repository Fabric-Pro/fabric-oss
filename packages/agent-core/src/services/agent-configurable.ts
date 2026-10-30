import { agentUsageConfigFromInput } from "./usage-logging";

/** Model, tenant and logger context for delegated and direct graph invocations. */
export function buildAgentConfigurable(
	input: Record<string, unknown>,
	runtimeConfigurable?: Record<string, unknown>,
): Record<string, unknown> {
	const str = (value: unknown): string | undefined =>
		typeof value === "string" && value.length > 0 ? value : undefined;
	const pick = (key: string): string | undefined =>
		str(runtimeConfigurable?.[key]) ?? str(input[key]);
	// A supplied runtime config is authoritative even when a reserved value is absent.
	const resolved = runtimeConfigurable ?? input;
	const configurable: Record<string, unknown> = {};
	// Unified server sanitizes this reserved field after body spreads.
	if (resolved.ai_model_pinned === true) {
		configurable.ai_model_pinned = true;
		for (const key of ["ai_max_output_tokens", "ai_context_window"]) {
			if (typeof resolved[key] === "number") {
				configurable[key] = resolved[key];
			}
		}
	}
	for (const key of [
		"ai_api_key",
		"ai_model",
		"ai_provider",
		"usage_conversation_id",
		"thread_id",
	]) {
		const value = pick(key);
		if (value !== undefined) {
			configurable[key] = value;
		}
	}
	for (const key of [
		"ai_deployment_name",
		"ai_canonical_model_name",
		"tenant_user_id",
		"tenant_organization_id",
	]) {
		const value = str(resolved[key]);
		if (value !== undefined) {
			configurable[key] = value;
		}
	}
	// A2A input uses the server-normalized base URL. The gateway alias is runtime-only.
	const gatewayUrl = runtimeConfigurable
		? (str(runtimeConfigurable.ai_base_url) ??
			str(runtimeConfigurable.ai_gateway_url))
		: str(input.ai_base_url);
	if (gatewayUrl !== undefined) {
		configurable.ai_gateway_url = gatewayUrl;
	}
	const reasoning =
		resolved.ai_model_pinned === true
			? resolved.ai_is_reasoning
			: (runtimeConfigurable?.ai_is_reasoning ?? input.ai_is_reasoning);
	if (typeof reasoning === "boolean") {
		configurable.ai_is_reasoning = reasoning;
	}
	// Keep the token scoped to usage logging; flat ai_token also authenticates tools.
	return {
		...configurable,
		...agentUsageConfigFromInput({
			...input,
			...runtimeConfigurable,
			ai_billing_mode: resolved.ai_billing_mode,
			ai_billing_customer_id: resolved.ai_billing_customer_id,
			ai_plan_source: resolved.ai_plan_source,
		}),
	};
}
