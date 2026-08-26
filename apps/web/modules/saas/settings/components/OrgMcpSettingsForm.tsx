/**
 * Org MCP Settings Form
 *
 * This component has been refactored into a modular structure.
 * See ./mcp/ for the new implementation.
 *
 * This file re-exports from the new location for backwards compatibility.
 */

"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { McpSettingsFormBase } from "./mcp/McpSettingsFormBase";

export function OrgMcpSettingsForm() {
	const { organizationId, isOrganizationAdmin, isOrgContext } =
		useOrganizationContext();

	if (!isOrgContext || !organizationId) {
		return (
			<div className="text-sm text-muted-foreground">
				No organization selected.
			</div>
		);
	}

	return (
		<McpSettingsFormBase
			scope="org"
			organizationId={organizationId}
			disabled={false}
			registryDisabled={!isOrganizationAdmin}
			serverListTitle="Available MCP Servers"
			serverListDescription="Configure MCP servers for your use within this organization."
			configListTitle="Your MCP Configurations"
			configListDescription="Your personal MCP configurations within this organization."
		/>
	);
}
