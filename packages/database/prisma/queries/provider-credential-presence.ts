import { getAnthropicFederationConfig } from "./anthropic-federation";

interface ServicePrincipalFields {
	clientId?: string | null;
	encryptedClientSecret?: string | null;
}

export function hasServicePrincipalCredentials(
	row: ServicePrincipalFields,
): boolean {
	return Boolean(row.clientId && row.encryptedClientSecret);
}

/** Whether the selected credential is usable without decrypting or minting it. */
export function hasProviderCredentials(
	row: ServicePrincipalFields & {
		apiKey?: string | null;
		federatedOrganizationId?: string | null;
	},
): boolean {
	if (row.federatedOrganizationId) {
		return Boolean(
			getAnthropicFederationConfig(row.federatedOrganizationId),
		);
	}
	return Boolean(row.apiKey) || hasServicePrincipalCredentials(row);
}
