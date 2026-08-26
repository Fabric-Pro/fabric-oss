/**
 * ProviderCard Component
 *
 * Displays an available provider — whole card is clickable, matching
 * the ProjectCard aesthetic: group hover, border-t footer with arrow.
 *
 * In the integration-health flow a small 8px corner pip encodes upstream
 * `ProviderHealthStatus` -- a full badge would be too dense in the
 * provider grid. Only renders when `health` is provided (i.e., the
 * feature flag is on and the registry has a row for this provider).
 */

"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { ArrowRightIcon, CheckCircle, Search, Wrench } from "lucide-react";
import Link from "next/link";
import {
	type DataConnectionProvider,
	getProviderMetadata,
} from "../lib/providers";
import { ConnectionModeBadge } from "./ConnectionModeBadge";
import type { ProviderHealthStatusValue } from "./ProviderHealthBadge";
import { ProviderIcon } from "./ProviderIcon";

interface ProviderCardProps {
	provider: DataConnectionProvider;
	href: string;
	hasSearchConnection: boolean;
	hasActionConnection?: boolean;
	actionLabel?: string;
	/**
	 * Upstream provider health. When provided, an 8px corner pip is
	 * rendered to surface global incident state without overwhelming the
	 * dense provider grid.
	 */
	health?: ProviderHealthStatusValue | null;
}

// Partial: statuses without an entry (e.g. NOT_CONFIGURED) render no pip,
// which is the intended quiet treatment for misconfig states.
const HEALTH_PIP_CONFIG: Partial<
	Record<ProviderHealthStatusValue, { class: string; label: string }>
> = {
	OPERATIONAL: { class: "bg-secondary", label: "Operational" },
	DEGRADED: { class: "bg-highlight", label: "Degraded" },
	PARTIAL_OUTAGE: { class: "bg-destructive/70", label: "Partial outage" },
	MAJOR_OUTAGE: { class: "bg-destructive", label: "Major outage" },
	MAINTENANCE: { class: "bg-primary", label: "Maintenance" },
	UNKNOWN: { class: "bg-muted-foreground/40", label: "Status unavailable" },
	NOT_CONFIGURED: {
		class: "bg-muted-foreground/30",
		label: "Not configured",
	},
};

export function ProviderCard({
	provider,
	href,
	hasSearchConnection,
	hasActionConnection = false,
	actionLabel = "Actions",
	health,
}: ProviderCardProps) {
	const metadata = getProviderMetadata(provider);
	const isFullyConnected =
		hasSearchConnection && (!metadata.actionable || hasActionConnection);
	const hasAnyConnection = hasSearchConnection || hasActionConnection;
	const pipConfig = health ? HEALTH_PIP_CONFIG[health] : null;

	return (
		<Link
			href={href}
			className={cn(
				"group relative flex flex-col rounded-xl border bg-card transition-colors hover:border-primary/30 hover:bg-muted/20",
				isFullyConnected && "border-success/30 bg-success/5",
			)}
		>
			{pipConfig ? (
				<TooltipProvider delayDuration={150}>
					<Tooltip>
						<TooltipTrigger asChild>
							<span
								role="status"
								aria-label={`${metadata.name} provider status: ${pipConfig.label}`}
								className={cn(
									"absolute right-2 top-2 h-2 w-2 rounded-full ring-1 ring-background",
									pipConfig.class,
								)}
							/>
						</TooltipTrigger>
						<TooltipContent className="text-xs">
							{metadata.name}: {pipConfig.label}
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			) : null}
			{/* Header */}
			<div className="flex gap-3 p-4 pb-2">
				<div className="shrink-0">
					<ProviderIcon provider={provider} size="sm" />
				</div>
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-1.5">
						<h3 className="font-semibold text-sm leading-snug group-hover:text-primary transition-colors truncate">
							{metadata.name}
						</h3>
						{isFullyConnected && (
							<CheckCircle className="h-3.5 w-3.5 shrink-0 text-success" />
						)}
					</div>
					<p className="mt-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
						{metadata.searchFirstPrompt}
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
					<span
						className={cn(
							"h-1.5 w-1.5 rounded-full",
							hasSearchConnection
								? "bg-success"
								: "bg-muted-foreground/40",
						)}
					/>
				</div>
				<div className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/30 px-2 py-1 text-[11px]">
					<Wrench className="h-3 w-3 text-muted-foreground" />
					<span className="font-medium text-muted-foreground">
						{actionLabel}
					</span>
					<span
						className={cn(
							"h-1.5 w-1.5 rounded-full",
							metadata.actionable
								? hasActionConnection
									? "bg-success"
									: "bg-muted-foreground/40"
								: "bg-muted-foreground/20",
						)}
					/>
				</div>
			</div>

			{/* Footer */}
			<div className="mt-auto flex items-center justify-between border-t px-4 py-2.5">
				<div className="flex items-center gap-2">
					<ConnectionModeBadge mode={metadata.connectionMode} />
					<span className="text-[11px] text-muted-foreground">
						{isFullyConnected
							? "Fully connected"
							: hasAnyConnection
								? "Partially connected"
								: "Not connected"}
					</span>
				</div>
				<ArrowRightIcon className="h-3.5 w-3.5 text-primary opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-[opacity,transform] duration-150" />
			</div>
		</Link>
	);
}
