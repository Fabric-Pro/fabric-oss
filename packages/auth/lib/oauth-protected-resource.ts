/**
 * Protected-resource metadata (RFC 9728) for the MCP gateway.
 *
 * This is the document an MCP client reads after the gateway answers 401 with a
 * `WWW-Authenticate: Bearer resource_metadata=...` challenge. It names the
 * resource, the scopes it understands and the authorization server to sign in
 * through. `authorization_servers[0]` must equal the `issuer` the server's own
 * metadata reports, character for character — a client compares them, and a
 * trailing slash is enough to make it refuse to sign in — which is why the
 * issuer is passed in from the provider rather than rebuilt here.
 */

import {
	buildProjectResource,
	OAUTH_GATEWAY_RESOURCE_PATH,
} from "@repo/utils/oauth-project-resource";
import { OAUTH_SCOPES } from "./oauth-scopes";

export interface ProtectedResourceMetadata {
	resource: string;
	authorization_servers: string[];
	scopes_supported: string[];
	bearer_methods_supported: string[];
	resource_name: string;
}

/**
 * The document for the organization-wide gateway, or for one project's gateway
 * URL when `projectId` is given. A project URL is its own resource: a client
 * compares `resource` with the URL it was configured with, and asks for exactly
 * that value when it signs in.
 */
export function buildGatewayProtectedResourceMetadata(params: {
	appUrl: string;
	issuer: string;
	projectId?: string;
}): ProtectedResourceMetadata {
	return {
		resource: params.projectId
			? buildProjectResource(params.appUrl, "mcp", params.projectId)
			: `${params.appUrl.replace(/\/+$/, "")}${OAUTH_GATEWAY_RESOURCE_PATH}`,
		authorization_servers: [params.issuer],
		scopes_supported: [...OAUTH_SCOPES],
		bearer_methods_supported: ["header"],
		resource_name: "Fabric",
	};
}
