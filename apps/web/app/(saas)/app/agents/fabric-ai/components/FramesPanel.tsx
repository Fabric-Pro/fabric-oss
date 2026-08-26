"use client";

import { useOrganizationSlug } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	ExternalLink,
	LayoutGrid,
	Loader2,
	Presentation,
	RefreshCw,
} from "lucide-react";
import Link from "next/link";

interface FramesPanelProps {
	organizationId?: string;
	conversationId?: string | null;
}

export function FramesPanel({
	organizationId,
	conversationId,
}: FramesPanelProps) {
	const orgSlug = useOrganizationSlug();

	const {
		data: frames,
		isLoading,
		refetch,
	} = useQuery({
		queryKey: ["frames", organizationId],
		queryFn: () =>
			orpcClient.frames.list({
				organizationId: organizationId ?? null,
			}),
	});

	const frameUrl = (frameId: string) =>
		orgSlug
			? `/app/${orgSlug}/frames/${frameId}`
			: `/app/frames/${frameId}`;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
				<h3 className="text-sm font-medium text-foreground/80">
					Frames
				</h3>
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={() => refetch()}
					title="Refresh"
				>
					<RefreshCw className="h-3.5 w-3.5" />
				</Button>
			</div>

			<div className="flex-1 overflow-y-auto">
				{isLoading && (
					<div className="flex items-center justify-center py-8 text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin mr-2" />
						<span className="text-sm">Loading frames...</span>
					</div>
				)}

				{!isLoading &&
					(!frames ||
						(Array.isArray(frames) && frames.length === 0)) && (
						<div className="px-4 py-8 text-center text-muted-foreground">
							<LayoutGrid className="mx-auto mb-2 h-8 w-8 opacity-40" />
							<p className="text-sm">No frames yet</p>
							<p className="mt-1 text-xs">
								Ask the agent to create a frame or slideshow
							</p>
						</div>
					)}

				{Array.isArray(frames) &&
					frames.map(
						(frame: {
							id: string;
							title: string;
							kind?: string;
							createdAt: string | Date;
							isPublic?: boolean;
							conversationId?: string | null;
						}) => (
							<Link
								key={frame.id}
								href={frameUrl(frame.id)}
								className="flex items-center gap-3 border-b border-border/40 px-3 py-2.5 transition-colors hover:bg-muted/50"
							>
								<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
									{frame.kind === "slideshow" ? (
										<Presentation className="h-4 w-4 text-primary" />
									) : (
										<LayoutGrid className="h-4 w-4 text-primary" />
									)}
								</div>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium">
										{frame.title}
									</p>
									<p className="text-xs text-muted-foreground">
										{new Date(
											frame.createdAt,
										).toLocaleDateString()}
										{frame.conversationId ===
											conversationId && (
											<span className="ml-1.5 text-primary/70">
												· This conversation
											</span>
										)}
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									{frame.kind === "slideshow" && (
										<Badge
											variant="outline"
											className="px-1.5 py-0 text-[10px]"
										>
											Slides
										</Badge>
									)}
									{frame.isPublic && (
										<Badge
											variant="secondary"
											className="px-1.5 py-0 text-[10px]"
										>
											Shared
										</Badge>
									)}
									<ExternalLink className="h-3 w-3 text-muted-foreground" />
								</div>
							</Link>
						),
					)}
			</div>
		</div>
	);
}
