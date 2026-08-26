/**
 * RAG Providers Router
 * Handles RAG extraction provider configuration at organization and user levels
 */

import { getOrganizationProviders } from "./procedures/get-organization-providers";
import { getUserProviders } from "./procedures/get-user-providers";
import { listAvailableProviders } from "./procedures/list-available-providers";
import { testProviderConnection } from "./procedures/test-provider-connection";
import { updateOrganizationProvider } from "./procedures/update-organization-provider";
import { updateUserProvider } from "./procedures/update-user-provider";

export const ragProvidersRouter = {
	// Public endpoints
	listAvailableProviders,

	// Organization-level endpoints
	getOrganizationProviders,
	updateOrganizationProvider,

	// User-level endpoints
	getUserProviders,
	updateUserProvider,

	// Utility endpoints
	testProviderConnection,
};
