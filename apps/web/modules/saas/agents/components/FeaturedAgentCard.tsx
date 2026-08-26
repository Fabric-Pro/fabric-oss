"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";

interface AgentCapability {
	icon: React.ReactNode;
	label: string;
	description: string;
}

interface FeaturedAgentCardProps {
	/** Agent name/title */
	name: string;
	/** Short description */
	description: string;
	/** Link to the agent chat/page */
	href: string;
	/** Icon component to display */
	icon: React.ReactNode;
	/** Badge text (e.g., "Smart", "Pro") */
	badge?: string;
	/** Badge variant */
	badgeVariant?: "default" | "secondary" | "outline";
	/** List of capabilities to display */
	capabilities: AgentCapability[];
	/** Status indicators to show at the bottom (excluding "Active" which is always shown) */
	statusItems?: string[];
	/** Whether this is the primary/highlighted agent */
	isPrimary?: boolean;
	/** CTA label */
	ctaLabel?: string;
}

/**
 * Featured Agent Card
 *
 * A prominent card for showcasing featured/important agents
 * with their capabilities and quick access button.
 * Mobile-first layout: stacks vertically on small screens.
 */
export function FeaturedAgentCard({
	name,
	description,
	href,
	icon,
	badge,
	badgeVariant = "default",
	capabilities,
	statusItems = [],
	isPrimary = false,
	ctaLabel = "Start Chat",
}: FeaturedAgentCardProps) {
	return (
		<div
			className={cn(
				"relative overflow-hidden rounded-xl border p-5 sm:p-6",
				isPrimary
					? "border-primary/20 bg-gradient-to-br from-primary/5 via-background to-background"
					: "border-border bg-gradient-to-br from-muted/30 via-background to-background",
			)}
		>
			{/* Gradient blob decoration */}
			<div
				className={cn(
					"pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full blur-3xl",
					isPrimary ? "bg-primary/10" : "bg-muted/20",
				)}
			/>

			{/* ── Header ── */}
			<div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				{/* Left: icon + name + description */}
				<div className="flex min-w-0 gap-3">
					<div
						className={cn(
							"flex h-11 w-11 shrink-0 items-center justify-center rounded-xl sm:h-12 sm:w-12",
							isPrimary ? "bg-primary/10" : "bg-muted",
						)}
					>
						{icon}
					</div>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="text-lg font-semibold leading-tight sm:text-xl">
								{name}
							</h3>
							{badge && (
								<Badge
									variant={badgeVariant}
									className="shrink-0 text-xs"
								>
									{badge}
								</Badge>
							)}
						</div>
						<p className="mt-1 text-sm leading-snug text-muted-foreground sm:text-base">
							{description}
						</p>
					</div>
				</div>

				{/* CTA: full-width on mobile, auto on sm+ */}
				<Link href={href} className="sm:shrink-0">
					<Button
						size="lg"
						variant={isPrimary ? "default" : "outline"}
						className="w-full gap-2 sm:w-auto"
					>
						{ctaLabel}
						<ArrowRightIcon className="h-4 w-4" />
					</Button>
				</Link>
			</div>

			{/* ── Capabilities grid ── */}
			<div className="relative mt-4 grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-4">
				{capabilities.map((cap) => (
					<div
						key={cap.label}
						className="flex items-start gap-2 rounded-lg bg-muted/50 p-2.5 transition-colors hover:bg-muted sm:p-3"
					>
						<div
							className={cn(
								"flex h-7 w-7 shrink-0 items-center justify-center rounded-md sm:h-8 sm:w-8",
								isPrimary ? "bg-primary/10" : "bg-background",
							)}
						>
							{cap.icon}
						</div>
						<div className="min-w-0">
							<div className="text-xs font-medium leading-snug sm:text-sm">
								{cap.label}
							</div>
							<div className="mt-0.5 text-xs leading-snug text-muted-foreground">
								{cap.description}
							</div>
						</div>
					</div>
				))}
			</div>

			{/* ── Status row — wraps gracefully on mobile ── */}
			{statusItems.length > 0 && (
				<div className="relative mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground sm:text-sm">
					<span className="flex items-center gap-1.5">
						<span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
						Active
					</span>
					{statusItems.map((item, index) => (
						<span
							key={`status-${index}`}
							className="flex items-center gap-1.5"
						>
							<span className="text-border">•</span>
							{item}
						</span>
					))}
				</div>
			)}
		</div>
	);
}
