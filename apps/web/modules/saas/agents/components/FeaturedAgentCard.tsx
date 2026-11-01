"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

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
 * Compact Databricks Genie One style horizontal banner for showcasing the
 * primary workspace orchestrator agent with quick launch CTA.
 */
export function FeaturedAgentCard({
	name,
	description,
	href,
	icon,
	badge,
	badgeVariant = "default",
	isPrimary = false,
	ctaLabel = "Explore Advisor",
}: FeaturedAgentCardProps) {
	const [dismissed, setDismissed] = useState(false);

	if (dismissed) {
		return null;
	}

	return (
		<div
			className={cn(
				"relative flex flex-col gap-3 rounded-xl border px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between",
				isPrimary
					? "border-border bg-muted/40 dark:bg-muted/25"
					: "border-border bg-card",
			)}
		>
			{/* Left: icon badge + title + description */}
			<div className="flex min-w-0 items-center gap-3.5">
				<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-card text-primary shadow-2xs">
					{icon || <Sparkles className="h-5 w-5 text-primary" />}
				</div>
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="text-[13px] font-semibold leading-5 text-foreground">
							Take your agents further in {name}
						</h3>
						{badge && (
							<Badge
								variant={badgeVariant}
								className="h-5 shrink-0 px-1.5 text-[11px] font-normal"
							>
								{badge}
							</Badge>
						)}
					</div>
					<p className="mt-0.5 line-clamp-1 text-[13px] leading-5 text-muted-foreground">
						{description}
					</p>
				</div>
			</div>

			{/* Right: Pill CTA + Dismiss button */}
			<div className="flex shrink-0 items-center gap-2">
				<Button
					asChild
					size="sm"
					variant={isPrimary ? "default" : "outline"}
					className="h-8 rounded-full px-4 text-xs font-medium"
				>
					<Link href={href}>{ctaLabel}</Link>
				</Button>
				<button
					type="button"
					onClick={() => setDismissed(true)}
					aria-label="Dismiss banner"
					className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
				>
					<X className="h-4 w-4" />
				</button>
			</div>
		</div>
	);
}
