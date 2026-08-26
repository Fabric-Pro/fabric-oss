/**
 * MCP Config List
 *
 * Displays the list of MCP configurations.
 */

import { SettingsItem } from "@saas/shared/components/SettingsItem";
import type { McpConfig, OAuthStatus } from "../types";
import { McpConfigCard } from "./McpConfigCard";

export interface McpConfigListProps {
	configs: McpConfig[];
	oauthStatuses: Record<string, OAuthStatus>;
	isLoading?: boolean;
	disabled?: boolean;
	testingConfigId?: string | null;
	/** Whether the current user can change workspace-level OAuth setup. */
	isAdmin?: boolean;
	onEdit: (config: McpConfig) => void;
	onDelete: (config: McpConfig) => void;
	onTest: (config: McpConfig) => void;
	onToggleEnabled: (config: McpConfig, enabled: boolean) => void;
	title?: string;
	description?: string;
}

export function McpConfigList({
	configs,
	oauthStatuses,
	isLoading = false,
	disabled = false,
	testingConfigId = null,
	isAdmin = false,
	onEdit,
	onDelete,
	onTest,
	onToggleEnabled,
	title = "Your MCP Configurations",
	description = "Personal configurations scoped to your user.",
}: McpConfigListProps) {
	return (
		<SettingsItem title={title} description={description}>
			<div className="space-y-2">
				{isLoading && (
					<div className="text-sm text-muted-foreground">
						Loading...
					</div>
				)}
				{!isLoading && configs.length === 0 && (
					<div className="text-sm text-muted-foreground">
						No configurations yet.
					</div>
				)}
				{configs.map((config) => (
					<McpConfigCard
						key={config.id}
						config={config}
						oauthStatus={oauthStatuses[config.id]}
						disabled={disabled}
						isTesting={testingConfigId === config.id}
						isAdmin={isAdmin}
						onEdit={onEdit}
						onDelete={onDelete}
						onTest={onTest}
						onToggleEnabled={onToggleEnabled}
					/>
				))}
			</div>
		</SettingsItem>
	);
}
