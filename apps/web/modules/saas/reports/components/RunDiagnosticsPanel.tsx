"use client";

import {
	type McpConnectionOutcome,
	type McpServerDiagnostic,
	isRecoverableOutcome,
} from "@repo/temporal/report-diagnostics";
import { useOrganizationSlug } from "@saas/organizations/hooks/use-organization-context";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import Link from "next/link";

// Re-export the canonical diagnostic type so consumers (TemplateInstanceDetail)
// can type the panel's data without re-deriving the shape.
export type { McpServerDiagnostic };

// Record over the shared outcome union: adding a new outcome to the backend
// enum becomes a compile error here instead of silently rendering "Unknown".
const OUTCOME_LABEL: Record<McpConnectionOutcome, string> = {
	connected: "Connected",
	auth_failed: "Authentication expired",
	unreachable: "Unreachable",
	zero_tools: "No tools",
	no_read_only_tools: "No read-only tools",
	error: "Connection error",
};

function variantFor(
	outcome: McpConnectionOutcome,
): "default" | "secondary" | "destructive" | "outline" {
	if (outcome === "connected") {
		return "secondary";
	}
	if (
		outcome === "auth_failed" ||
		outcome === "unreachable" ||
		outcome === "error"
	) {
		return "destructive";
	}
	return "outline";
}

export function RunDiagnosticsPanel({
	diagnostics,
}: {
	diagnostics: McpServerDiagnostic[];
}) {
	const orgSlug = useOrganizationSlug();
	const mcpSettingsUrl = orgSlug
		? `/app/${orgSlug}/settings/mcp`
		: "/app/settings/mcp";

	if (!diagnostics?.length) {
		return null;
	}

	return (
		<ul
			className="mt-2 flex flex-col gap-1.5"
			aria-label="Data source diagnostics"
		>
			{diagnostics.map((d) => (
				<li
					key={d.configId}
					className="flex items-center gap-2 text-xs"
				>
					<Badge variant={variantFor(d.outcome)}>
						{OUTCOME_LABEL[d.outcome] ?? "Unknown"}
					</Badge>
					<span className="font-medium">{d.serverName}</span>
					<span className="text-muted-foreground">
						{d.readOnlyToolCount}/{d.toolCount} read-only tools
					</span>
					{isRecoverableOutcome(d.outcome) && (
						<Button
							asChild
							size="sm"
							variant="outline"
							className="h-6 px-2"
						>
							<Link
								href={mcpSettingsUrl}
								aria-label={`Reconnect ${d.serverName}`}
							>
								Reconnect
							</Link>
						</Button>
					)}
				</li>
			))}
		</ul>
	);
}
