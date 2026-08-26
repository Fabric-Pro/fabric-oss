/**
 * User MCP Settings Form
 *
 * This component has been refactored into a modular structure.
 * See ./mcp/ for the new implementation.
 *
 * This file re-exports from the new location for backwards compatibility.
 */

"use client";

import { MCPServersHero } from "@saas/mcp/components/MCPServersHero";
import { McpSettingsFormBase } from "./mcp/McpSettingsFormBase";

export function UserMcpSettingsForm() {
	return (
		<McpSettingsFormBase
			scope="user"
			showHero={<MCPServersHero />}
			serverListTitle="Available MCP Servers"
			serverListDescription="Registry of built-in MCP servers. Configure to use."
			configListTitle="Your MCP Configurations"
			configListDescription="Personal configurations scoped to your user."
		/>
	);
}
