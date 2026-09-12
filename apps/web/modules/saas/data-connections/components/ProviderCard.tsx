/**
 * ProviderCard
 *
 * One integration as a tile, in the shape cosmos.augmentcode.com uses for
 * its connectors: the mark, the name, a quiet "connected" tick or a plus
 * at the right, and one line of description. The whole tile is the link.
 *
 * Upstream provider health, when known, is a small dot before the name so
 * an incident is visible without a badge crowding the grid.
 */

"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { Check, Plus } from "lucide-react";
import Link from "next/link";
import {
	type DataConnectionProvider,
	getProviderMetadata,
} from "../lib/providers";
import type { ProviderHealthStatusValue } from "./ProviderHealthBadge";
import { ProviderIcon } from "./ProviderIcon";

interface ProviderCardProps {
	provider: DataConnectionProvider;
	href: string;
	hasSearchConnection: boolean;
	hasActionConnection?: boolean;
	actionLabel?: string;
	health?: ProviderHealthStatusValue | null;
}

const HEALTH_PIP_CONFIG: Partial<
	Record<ProviderHealthStatusValue, { class: string; label: string }>
> = {
	DEGRADED: { class: "bg-[var(--fab-warn)]", label: "Degraded" },
	PARTIAL_OUTAGE: { class: "bg-destructive/70", label: "Partial outage" },
	MAJOR_OUTAGE: { class: "bg-destructive", label: "Major outage" },
	MAINTENANCE: { class: "bg-muted-foreground", label: "Maintenance" },
};

/** The tile every integration renders in, shared with the action-only card. */
export function IntegrationTile({
	href,
	icon,
	name,
	description,
	connected,
	partial = false,
	pip,
	testId,
}: {
	href: string;
	icon: React.ReactNode;
	name: string;
	description: string;
	connected: boolean;
	partial?: boolean;
	pip?: { class: string; label: string } | null;
	testId?: string;
}) {
	return (
		<Link
			href={href}
			data-testid={testId}
			className="group flex flex-col gap-2 rounded-[10px] border border-border bg-card px-4 py-3.5 transition-colors hover:bg-accent"
		>
			<div className="flex items-center gap-3">
				<span className="flex size-7 shrink-0 items-center justify-center [&>svg]:size-7 [&>img]:size-7">
					{icon}
				</span>
				<span className="flex min-w-0 flex-1 items-center gap-2">
					<span className="truncate text-[15px] font-medium text-foreground">
						{name}
					</span>
					{pip ? (
						<TooltipProvider delayDuration={150}>
							<Tooltip>
								<TooltipTrigger asChild>
									<span
										role="img"
										aria-label={`${name} provider status: ${pip.label}`}
										className={cn(
											"size-1.5 shrink-0 rounded-full",
											pip.class,
										)}
									/>
								</TooltipTrigger>
								<TooltipContent className="text-xs">
									{name}: {pip.label}
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					) : null}
				</span>
				{connected ? (
					<span className="inline-flex h-5 items-center gap-1 rounded-full bg-muted px-1.5 text-muted-foreground">
						<Check className="size-3" aria-hidden="true" />
						<span className="sr-only">
							{partial ? "Partly connected" : "Connected"}
						</span>
						{partial ? (
							<span className="text-[10px] leading-none">
								Partly
							</span>
						) : null}
					</span>
				) : (
					<>
						<Plus
							className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
							aria-hidden="true"
						/>
						<span className="sr-only">Not connected</span>
					</>
				)}
			</div>
			<p className="truncate text-[13px] text-muted-foreground">
				{description}
			</p>
		</Link>
	);
}

export function ProviderCard({
	provider,
	href,
	hasSearchConnection,
	hasActionConnection = false,
	health,
}: ProviderCardProps) {
	const metadata = getProviderMetadata(provider);
	const isFullyConnected =
		hasSearchConnection && (!metadata.actionable || hasActionConnection);
	const hasAnyConnection = hasSearchConnection || hasActionConnection;
	const pip = health ? (HEALTH_PIP_CONFIG[health] ?? null) : null;

	return (
		<IntegrationTile
			href={href}
			icon={<ProviderIcon provider={provider} bare className="size-7" />}
			name={metadata.name}
			description={metadata.description}
			connected={hasAnyConnection}
			partial={hasAnyConnection && !isFullyConnected}
			pip={pip}
		/>
	);
}
