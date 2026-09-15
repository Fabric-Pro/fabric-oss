"use client";

/**
 * Connections: integrations and MCP servers under one roof, as
 * cosmos.augmentcode.com/connector shows them, so a person adding a
 * capability has one place to look. A segmented control switches between
 * the two; the choice lives in the URL (?tab=mcp) so links and the old
 * /settings/mcp route land on the right panel.
 *
 * The page explains itself twice, on purpose. Once up front, as prose under
 * the title, because a newcomer arrives without knowing that "Integration"
 * and "MCP server" are two answers to the same question. Then again at the
 * segmented control, on demand, because that is where the question is
 * actually asked and the prose has usually been scrolled past by then.
 */

import { PageHeader } from "@saas/shared/components/PageHeader";
import { Button } from "@ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { cn } from "@ui/lib";
import { InfoIcon } from "lucide-react";
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

/**
 * The page's own framing, shown above the two setup paths. Kept as one
 * paragraph rather than a bordered callout: it is orientation, not an alert.
 */
const CONNECTIONS_INTRO =
	"Connections let Fabric agents work with tools and systems outside of Fabric. Integrations are Fabric-native connectors for commonly used apps like GitHub, Slack, Jira, Google Drive, and Teams. MCP servers connect Fabric to custom tools, internal systems, databases, scripts, or niche SaaS apps through the Model Context Protocol. Use an Integration when Fabric already supports the service directly; use an MCP server when you need a custom or protocol-based connection.";

/**
 * The last sentence of the intro, repeated at the control. Deliberately the
 * same words rather than a paraphrase — two wordings of one rule is how a
 * reader ends up unsure there is only one rule.
 */
const CONNECTION_TYPE_HINT =
	"Use an Integration when Fabric already supports the service directly; use an MCP server when you need a custom or protocol-based connection.";

export function ConnectionsTabs({
	addHref,
	settingsBasePath,
	organizationId,
}: {
	addHref: string;
	/** Where provider and action detail pages live (they stay under Settings). */
	settingsBasePath: string;
	organizationId?: string | null;
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
		<div className="flex items-center gap-1">
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
			<Popover>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="shrink-0 text-muted-foreground"
						// Named for what it explains, not "About": the page can
						// carry several info affordances and "About" identifies
						// none of them to a screen-reader user.
						aria-label="Integrations or MCP servers: which to use"
					>
						<InfoIcon className="size-4" aria-hidden="true" />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-80 text-sm">
					<p className="font-medium">Which one do I need?</p>
					<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
						{CONNECTION_TYPE_HINT}
					</p>
				</PopoverContent>
			</Popover>
		</div>
	);

	return (
		<div className="space-y-6">
			<PageHeader title="Connections" getStartedPageId="integrations" />
			<p className="max-w-2xl text-sm leading-6 text-muted-foreground">
				{CONNECTIONS_INTRO}
			</p>
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
