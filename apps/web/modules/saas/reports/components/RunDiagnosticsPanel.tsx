"use client";
import type { ReportConnectionDiagnostic } from "@repo/database/prisma/queries/lib/report-public-diagnostics";
import { useOrganizationSlug } from "@saas/organizations/hooks/use-organization-context";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import Link from "next/link";
export type { ReportConnectionDiagnostic };
const labels: Record<ReportConnectionDiagnostic["status"], string> = {
	connected: "Connected",
	auth_failed: "Authentication expired",
	unreachable: "Unreachable",
	zero_tools: "No tools",
	no_read_only_tools: "No read-only tools",
	error: "Connection error",
	unavailable: "Details unavailable",
};
const providers: Record<ReportConnectionDiagnostic["providerType"], string> = {
	azure_devops: "Azure DevOps",
	github: "GitHub",
	gitlab: "GitLab",
	linear: "Linear",
	fizzy: "Fizzy",
	microsoft_graph: "Microsoft 365",
	slack: "Slack",
	teams: "Teams",
	notion: "Notion",
	confluence: "Confluence",
	google_drive: "Google Drive",
	sharepoint: "SharePoint",
	fabric: "Fabric",
	other: "Connection",
};
export function RunDiagnosticsPanel({
	diagnostics,
}: {
	diagnostics: ReportConnectionDiagnostic[];
}) {
	const orgSlug = useOrganizationSlug();
	const path = orgSlug ? `/app/${orgSlug}/settings/mcp` : "/app/settings/mcp";
	if (!diagnostics.length) {
		return null;
	}
	return (
		<ul
			className="mt-2 flex flex-col gap-1.5"
			aria-label="Data source diagnostics"
		>
			{diagnostics.map((diagnostic, index) => (
				<li
					key={`${diagnostic.providerType}:${diagnostic.status}:${index}`}
					className="flex flex-wrap items-center gap-2 text-xs"
				>
					<Badge
						variant={
							diagnostic.status === "connected"
								? "secondary"
								: diagnostic.status === "auth_failed" ||
										diagnostic.status === "unreachable" ||
										diagnostic.status === "error"
									? "destructive"
									: "outline"
						}
					>
						{diagnostic.reasonCode === "DIAGNOSTICS_TRUNCATED"
							? "Additional source details omitted"
							: labels[diagnostic.status]}
					</Badge>
					<span className="font-medium">
						{diagnostic.displayLabel}
					</span>
					{diagnostic.providerType !== "other" && (
						<span className="text-muted-foreground">
							{providers[diagnostic.providerType]}
						</span>
					)}
					<span className="text-muted-foreground">
						{diagnostic.toolCount === null ||
						diagnostic.readOnlyToolCount === null
							? "Tool counts unavailable"
							: `${diagnostic.readOnlyToolCount}/${diagnostic.toolCount} read-only tools`}
					</span>
					{(diagnostic.status === "auth_failed" ||
						diagnostic.status === "unreachable") && (
						<Button
							asChild
							size="sm"
							variant="outline"
							className="h-6 px-2"
						>
							<Link
								href={path}
								aria-label={`Reconnect ${diagnostic.displayLabel}`}
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
