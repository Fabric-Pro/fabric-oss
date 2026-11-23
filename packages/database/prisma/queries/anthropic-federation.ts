export function getAnthropicFederationConfig(organizationId?: string | null) {
	const federationRuleId = process.env.ANTHROPIC_FEDERATION_RULE_ID?.trim();
	const anthropicOrganizationId =
		process.env.ANTHROPIC_ORGANIZATION_ID?.trim();
	const audience = process.env.ANTHROPIC_FEDERATION_AUDIENCE?.trim();
	const allowed =
		process.env.ANTHROPIC_FEDERATION_ALLOWED_ORGANIZATION_IDS?.split(
			",",
		).map((id) => id.trim());

	if (
		!organizationId ||
		!allowed?.includes(organizationId) ||
		!federationRuleId ||
		!anthropicOrganizationId ||
		!audience
	) {
		return null;
	}

	return {
		federationRuleId,
		organizationId: anthropicOrganizationId,
		audience,
		serviceAccountId:
			process.env.ANTHROPIC_SERVICE_ACCOUNT_ID?.trim() || undefined,
		workspaceId: process.env.ANTHROPIC_WORKSPACE_ID?.trim() || undefined,
	};
}

export const ANTHROPIC_FEDERATION_UNAVAILABLE =
	"Anthropic federation is unavailable for this organization.";

export class AnthropicFederationUnavailableError extends Error {
	constructor() {
		super(ANTHROPIC_FEDERATION_UNAVAILABLE);
		this.name = "AnthropicFederationUnavailableError";
	}
}
