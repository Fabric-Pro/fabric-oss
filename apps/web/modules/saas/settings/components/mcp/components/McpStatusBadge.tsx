/**
 * MCP Status Badge
 *
 * Displays connection status for MCP configurations.
 */

import type { OAuthStatus } from "../types";

export interface McpStatusBadgeProps {
	status: string | null;
	authType: string;
	oauthStatus?: OAuthStatus;
}

export function McpStatusBadge({
	status,
	authType,
	oauthStatus,
}: McpStatusBadgeProps) {
	// For OAuth configs, show OAuth-specific status
	if (authType === "OAUTH2" && oauthStatus) {
		if (oauthStatus.authenticated && !oauthStatus.tokenExpired) {
			return (
				<span className="rounded-sm bg-success/10 px-2 py-0.5 text-xs text-success">
					Connected
				</span>
			);
		}
		if (oauthStatus.tokenExpired && oauthStatus.hasRefreshToken) {
			return (
				<span className="rounded-sm bg-highlight/10 px-2 py-0.5 text-xs text-highlight">
					Token Expired
				</span>
			);
		}
		return (
			<span className="rounded-sm bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
				Not Connected
			</span>
		);
	}

	// For non-OAuth configs, show user-friendly status text
	const colorClass =
		status === "HEALTHY"
			? "bg-success/10 text-success"
			: status === "DEGRADED"
				? "bg-highlight/10 text-highlight"
				: "bg-destructive/10 text-destructive";

	// Use "Connected" instead of "HEALTHY" for better UX
	const displayText =
		status === "HEALTHY" ? "Connected" : (status ?? "UNKNOWN");

	return (
		<span className={`rounded-sm px-2 py-0.5 text-xs ${colorClass}`}>
			{displayText}
		</span>
	);
}
