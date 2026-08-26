import { config } from "@repo/config";
import { getAiProviderApiKey, getTenantAiCreditStatus } from "@repo/database";
import { hasPaymentMethod } from "../../provider";
import { getCustomerIdFromEntity } from "./customer";

export class AiCreditLimitExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AiCreditLimitExceededError";
	}
}

export type TenantAiBillingMode =
	| "included_credit"
	| "metered_stripe"
	| "platform_unbilled"
	| "external_provider";

export async function getTenantAiCreditAccess(params: {
	userId: string;
	organizationId?: string;
}) {
	const [creditStatus, customerId, providerConfig] = await Promise.all([
		getTenantAiCreditStatus(
			params.organizationId
				? { organizationId: params.organizationId }
				: { userId: params.userId },
		),
		getCustomerIdFromEntity(
			params.organizationId
				? { organizationId: params.organizationId }
				: { userId: params.userId },
		),
		getAiProviderApiKey({
			userId: params.userId,
			organizationId: params.organizationId,
		}),
	]);

	const hasSavedPaymentMethod = customerId
		? await hasPaymentMethod(customerId)
		: false;

	// Tenant-scoped BYOK check for billing/banner UI.
	// For orgs: only true when the ORG itself has a provider configured
	// (not when the viewer's personal key is used as fallback).
	// For personal: true when the user has their own provider.
	const hasConfiguredProvider = params.organizationId
		? providerConfig.source === "organization"
		: providerConfig.source === "user";

	// Whether THIS USER can use AI in this context.
	// Includes personal key fallback in org context — the user pays with their own key.
	const userHasProvider =
		providerConfig.source === "user" ||
		providerConfig.source === "organization";

	return {
		...creditStatus,
		customerId,
		hasPaymentMethod: hasSavedPaymentMethod,
		hasConfiguredProvider,
		canUseAi:
			hasSavedPaymentMethod ||
			!creditStatus.isLimitReached ||
			userHasProvider,
	};
}

export async function assertTenantCanUseAi(params: {
	userId: string;
	organizationId?: string;
}) {
	const access = await getTenantAiCreditAccess(params);

	if (access.canUseAi) {
		return access;
	}

	throw new AiCreditLimitExceededError(
		"You've used the included $5 in AI credits for this workspace. Add a card in Billing to continue.",
	);
}

export function getTenantAiGatewayBillingState(params: {
	access: Awaited<ReturnType<typeof getTenantAiCreditAccess>>;
	provider: string;
	configSource: "user" | "organization" | null;
}) {
	const isPlatformGateway =
		params.provider === "VERCEL_GATEWAY" && params.configSource === null;
	const stripeRestrictedKey = config.payments.aiMetering?.stripeRestrictedKey;

	if (!isPlatformGateway) {
		return {
			mode: "external_provider" as const,
			headers: null,
		};
	}

	if (!params.access.isLimitReached) {
		return {
			mode: "included_credit" as const,
			headers: null,
		};
	}

	if (
		params.access.hasPaymentMethod &&
		params.access.customerId &&
		stripeRestrictedKey
	) {
		return {
			mode: "metered_stripe" as const,
			headers: {
				"stripe-customer-id": params.access.customerId,
				"stripe-restricted-access-key": stripeRestrictedKey,
			},
		};
	}

	return {
		mode: "platform_unbilled" as const,
		headers: null,
	};
}
