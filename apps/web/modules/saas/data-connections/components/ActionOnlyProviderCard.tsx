/**
 * ActionOnlyProviderCard Component
 *
 * Mirrors `ProviderCard`'s visual language for catalog entries that only
 * exist as workflow/action plugins -- no `DataConnectionProvider` enum
 * value, so `ProviderCard` (which calls `getProviderMetadata`) can't render
 * them. Search/sync is never available for these, so the Search pill always
 * renders in the "not applicable" treatment.
 */

"use client";

import type { IntegrationType } from "@saas/workflows/lib/plugins";
import { cn } from "@ui/lib";
import { ArrowRightIcon, CheckCircle, Search, Wrench } from "lucide-react";
import Link from "next/link";
import { getActionOnlyProviderPlugin } from "../lib/action-only-providers";
import { ConnectionModeBadge } from "./ConnectionModeBadge";

interface ActionOnlyProviderCardProps {
	type: IntegrationType;
	href: string;
	hasConnection: boolean;
}

export function ActionOnlyProviderCard({
	type,
	href,
	hasConnection,
}: ActionOnlyProviderCardProps) {
	const plugin = getActionOnlyProviderPlugin(type);

	if (!plugin) {
		return null;
	}

	// Registry icon is typed as a component, but stay defensive against a
	// mis-registered plugin the same way IntegrationProviderPageContent does.
	const Icon = typeof plugin.icon === "function" ? plugin.icon : Search;

	return (
		<Link
			href={href}
			className={cn(
				"group relative flex flex-col rounded-xl border bg-card transition-colors hover:border-primary/30 hover:bg-muted/20",
				hasConnection && "border-success/30 bg-success/5",
			)}
		>
			{/* Header */}
			<div className="flex gap-3 p-4 pb-2">
				<div className="shrink-0">
					<div
						className={cn(
							"flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-background shadow-sm ring-1 ring-border/60",
							plugin.color,
						)}
					>
						<div className="flex h-full w-full items-center justify-center p-2">
							<Icon className="h-5 w-5 shrink-0" />
						</div>
					</div>
				</div>
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-1.5">
						<h3 className="font-semibold text-sm leading-snug group-hover:text-primary transition-colors truncate">
							{plugin.label}
						</h3>
						{hasConnection && (
							<CheckCircle className="h-3.5 w-3.5 shrink-0 text-success" />
						)}
					</div>
					<p className="mt-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
						{plugin.description}
					</p>
				</div>
			</div>

			{/* Capability pills */}
			<div className="px-4 pb-2 flex flex-wrap gap-1.5">
				<div className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/30 px-2 py-1 text-[11px]">
					<Search className="h-3 w-3 text-muted-foreground" />
					<span className="font-medium text-muted-foreground">
						Search
					</span>
					<span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/20" />
				</div>
				<div className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/30 px-2 py-1 text-[11px]">
					<Wrench className="h-3 w-3 text-muted-foreground" />
					<span className="font-medium text-muted-foreground">
						Actions
					</span>
					<span
						className={cn(
							"h-1.5 w-1.5 rounded-full",
							hasConnection
								? "bg-success"
								: "bg-muted-foreground/40",
						)}
					/>
				</div>
			</div>

			{/* Footer */}
			<div className="mt-auto flex items-center justify-between border-t px-4 py-2.5">
				<div className="flex items-center gap-2">
					<ConnectionModeBadge mode="action" />
					<span className="text-[11px] text-muted-foreground">
						{hasConnection ? "Connected" : "Not connected"}
					</span>
				</div>
				<ArrowRightIcon className="h-3.5 w-3.5 text-primary opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-[opacity,transform] duration-150" />
			</div>
		</Link>
	);
}
