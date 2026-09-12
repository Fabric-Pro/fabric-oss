"use client";

/**
 * Connections: integrations and MCP servers under one roof, as
 * cosmos.augmentcode.com/connector shows them, so a person adding a
 * capability has one place to look. A segmented control switches between
 * the two; the choice lives in the URL (?tab=mcp) so links and the old
 * /settings/mcp route land on the right panel.
 */

import { PageHeader } from "@saas/shared/components/PageHeader";
import { cn } from "@ui/lib";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ConnectionsPageContent } from "./ConnectionsPageContent";

const McpServersView = dynamic(
	() =>
		import("@saas/mcp/components/McpServersView").then(
			(m) => m.McpServersView,
		),
	{ ssr: false },
);

type Tab = "all" | "integrations" | "mcp";

const TABS: { value: Tab; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "integrations", label: "Integrations" },
	{ value: "mcp", label: "MCP servers" },
];

export function ConnectionsTabs({
	addHref,
	settingsBasePath,
	organizationId,
	description = "Everything Fabric can search, cite and call at runtime: integrations with the tools your team uses, and MCP servers that give agents more tools.",
}: {
	addHref: string;
	/** Where provider and action detail pages live (they stay under Settings). */
	settingsBasePath: string;
	organizationId?: string | null;
	description?: string;
}) {
	const router = useRouter();
	const pathname = usePathname();
	const params = useSearchParams();
	const rawTab = params.get("tab");
	const tab: Tab =
		rawTab === "mcp"
			? "mcp"
			: rawTab === "integrations"
				? "integrations"
				: "all";
	const serverParam = params.get("server") ?? "";

	const select = (next: Tab) => {
		const query = new URLSearchParams(params.toString());
		query.delete("server");
		if (next === "all") {
			query.delete("tab");
		} else {
			query.set("tab", next);
		}
		const qs = query.toString();
		router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
	};

	const typeTabs = (
		<fieldset className="inline-flex rounded-[8px] border border-border bg-background p-0.5">
			<legend className="sr-only">Connection type</legend>
			{TABS.map((t) => (
				<button
					key={t.value}
					type="button"
					aria-pressed={tab === t.value}
					onClick={() => select(t.value)}
					className={cn(
						"rounded-[6px] px-3 py-1 text-sm transition-colors",
						tab === t.value
							? "bg-accent text-foreground"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{t.label}
				</button>
			))}
		</fieldset>
	);

	return (
		<div className="space-y-6">
			<PageHeader
				title="Connections"
				description={description}
				getStartedPageId="integrations"
			/>
			<ConnectionsPageContent
				addHref={addHref}
				settingsBasePath={settingsBasePath}
				basePath={pathname}
				toolbarStart={typeTabs}
				view={tab}
			/>
			{tab === "mcp" ? (
				<div className="border-t border-border pt-8">
					<McpServersView
						organizationId={organizationId}
						embedded
						initialRegistrySearch={serverParam}
					/>
				</div>
			) : null}
		</div>
	);
}
