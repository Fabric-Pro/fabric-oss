"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

export type GitLabTransport =
	| { kind: "official-mcp"; checkedAt: string | null }
	| { kind: "rest"; checkedAt: string | null }
	// Server marked the integration `needsReauth` (refresh-token dead or
	// recheck returned 401). Takes precedence over the transport mode so the
	// badge never says "Connected via REST" when the stored token is known
	// to fail — that wording would directly contradict the toast / inline
	// alert that fires from the same surface.
	| { kind: "reauth-required"; checkedAt: string | null }
	| { kind: "unknown" }; // legacy / pre-probe

type Props = {
	transport: GitLabTransport;
	onRecheck: () => Promise<void> | void;
	isRechecking?: boolean;
};

export function GitLabTransportBadge({
	transport,
	onRecheck,
	isRechecking = false,
}: Props) {
	const [optimisticRechecking, setOptimisticRechecking] = useState(false);
	const recheckPending = isRechecking || optimisticRechecking;
	// Date.now() during render would mismatch between SSR and the first
	// client paint (the few hundred ms gap is enough to flip "just now" to
	// "1m ago"). Gating the relative-time label on a post-mount flag keeps
	// the initial paint deterministic; the label fills in on the next tick.
	const [mounted, setMounted] = useState(false);
	useEffect(() => {
		setMounted(true);
	}, []);

	const handleRecheck = async () => {
		try {
			setOptimisticRechecking(true);
			await onRecheck();
		} finally {
			setOptimisticRechecking(false);
		}
	};

	return (
		<div className="flex items-center gap-2">
			{transport.kind === "official-mcp" && (
				<Badge variant="secondary">Connected via official MCP</Badge>
			)}
			{transport.kind === "rest" && (
				<Badge variant="outline">Connected via REST</Badge>
			)}
			{transport.kind === "reauth-required" && (
				<Badge variant="destructive">Reconnect required</Badge>
			)}
			{transport.kind === "unknown" && (
				<Badge variant="outline">Connection mode unknown</Badge>
			)}
			{transport.kind !== "unknown" && transport.checkedAt && mounted && (
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<span
								className="text-xs text-muted-foreground"
								suppressHydrationWarning
							>
								Checked{" "}
								{formatRelativeShort(transport.checkedAt)}
							</span>
						</TooltipTrigger>
						<TooltipContent suppressHydrationWarning>
							{new Date(transport.checkedAt).toISOString()}
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			)}
			<Button
				variant="ghost"
				size="sm"
				onClick={handleRecheck}
				disabled={recheckPending}
				aria-label="Re-check GitLab capabilities"
			>
				<RefreshCw
					className={
						recheckPending
							? "h-3.5 w-3.5 animate-spin"
							: "h-3.5 w-3.5"
					}
				/>
				<span className="ml-1.5">Re-check</span>
			</Button>
		</div>
	);
}

function formatRelativeShort(iso: string): string {
	const then = new Date(iso).getTime();
	const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
	if (seconds < 60) {
		return "just now";
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
