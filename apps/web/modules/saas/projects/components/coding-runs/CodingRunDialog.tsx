"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { CodeIcon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { CodingRunTimeline } from "./CodingRunTimeline";

interface CodingRunDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	codingRunId: string;
	organizationId?: string | null;
	featureTitle?: string | null;
}

export function CodingRunDialog({
	open,
	onOpenChange,
	codingRunId,
	organizationId,
	featureTitle,
}: CodingRunDialogProps) {
	const queryClient = useQueryClient();

	const cancelMutation = useMutation({
		mutationFn: () =>
			orpcClient.codingRuns.cancel({
				id: codingRunId,
				organizationId: organizationId ?? null,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["codingRun", codingRunId],
			});
			toast.success("Coding run cancelled");
		},
		onError: () => {
			toast.error("Failed to cancel coding run");
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader className="space-y-4 text-left">
					<div className="flex items-start gap-3">
						<div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 shadow-sm">
							<CodeIcon className="size-5 text-primary" />
						</div>
						<div className="min-w-0 flex-1 space-y-2 pr-8">
							<div className="flex flex-wrap items-center gap-2">
								<Badge
									variant="outline"
									className="rounded-full border-primary/20 bg-primary/5 px-2.5 py-0.5 text-[11px] uppercase tracking-[0.16em] text-primary"
								>
									<SparklesIcon className="mr-1 size-3" />
									Implementation Session
								</Badge>
							</div>
							<DialogTitle className="text-xl leading-tight sm:text-2xl">
								Implementation session
							</DialogTitle>
							<DialogDescription className="max-w-[48ch] text-sm leading-6">
								Track implementation progress, inspect linked
								runtime metadata, jump into the live session,
								and open the pull request as soon as it is
								ready.
							</DialogDescription>
							{featureTitle && (
								<div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
									<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
										Feature
									</p>
									<p className="mt-1 line-clamp-2 text-sm font-medium text-foreground">
										{featureTitle}
									</p>
								</div>
							)}
							{!featureTitle && (
								<p className="text-xs text-muted-foreground">
									Live status, runtime metadata, and activity
									for the current implementation session.
								</p>
							)}
						</div>
					</div>
				</DialogHeader>

				<div className="rounded-2xl border border-border/60 bg-card/70 p-4 shadow-sm">
					<CodingRunTimeline
						codingRunId={codingRunId}
						organizationId={organizationId}
						onCancel={() => cancelMutation.mutate()}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
