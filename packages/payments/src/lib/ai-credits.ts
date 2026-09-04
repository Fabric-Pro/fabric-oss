export type TenantAiBillingMode =
	| "included_credit"
	| "metered_stripe"
	| "platform_unbilled"
	| "external_provider";

/**
 * Which billing mode a resolved model call runs under, and the headers (if
 * any) it must carry.
 *
 * Takes no access/credit argument: the allowance and the metered-overage
 * branches it used to feed describe states that can no longer arise. What is
 * left is the pair a request can actually reach — an external provider the
 * tenant configured, and platform-funded serving, which after the resolver
 * split is reachable only from the background and system paths that use
 * `getSystemAiProviderApiKey`.
 *
 * `TenantAiBillingMode` deliberately keeps the retired names: usage rows
 * already written carry them, and reporting still groups by them.
 */
export function getTenantAiGatewayBillingState(params: {
	provider: string;
	configSource: "user" | "organization" | null;
}) {
	const isPlatformGateway =
		params.provider === "VERCEL_GATEWAY" && params.configSource === null;

	if (!isPlatformGateway) {
		return {
			mode: "external_provider" as const,
			headers: null,
		};
	}

	return {
		mode: "platform_unbilled" as const,
		headers: null,
	};
}
