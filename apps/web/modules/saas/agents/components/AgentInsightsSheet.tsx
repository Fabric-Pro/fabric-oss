"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { AlertCircle, BarChart3, Check, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

interface AgentInsightsSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agent: {
		id: string;
		displayName: string;
		description?: string | null;
		scope?: string;
		status?: string;
	};
	organizationId?: string | null;
}

export function AgentInsightsSheet({
	open,
	onOpenChange,
	agent,
	organizationId,
}: AgentInsightsSheetProps) {
	const queryClient = useQueryClient();

	const observability = useQuery({
		queryKey: [
			"agents",
			"registry",
			"observability",
			agent.id,
			organizationId,
		],
		queryFn: () =>
			orpcClient.agents.registry.observability.get({
				id: agent.id,
				organizationId,
			}),
		enabled: open,
	});

	const suggestions = useQuery({
		queryKey: [
			"agents",
			"registry",
			"suggestions",
			agent.id,
			organizationId,
		],
		queryFn: () =>
			orpcClient.agents.registry.suggestions.list({
				id: agent.id,
				organizationId,
			}),
		enabled: open,
	});

	const updateSuggestionMutation = useMutation({
		mutationFn: (params: {
			id: string;
			state: "approved" | "rejected" | "outdated";
		}) =>
			orpcClient.agents.registry.suggestions.update({
				id: agent.id,
				organizationId,
				updates: [params],
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: [
					"agents",
					"registry",
					"suggestions",
					agent.id,
					organizationId,
				],
			});
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update suggestion",
			);
		},
	});

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
				<SheetHeader>
					<SheetTitle>{agent.displayName}</SheetTitle>
					<SheetDescription>
						Observability, adoption signals, and curation
						suggestions for this agent.
					</SheetDescription>
				</SheetHeader>

				<div className="mt-6 space-y-6">
					<section className="space-y-4">
						<div className="flex items-center gap-2">
							<BarChart3 className="h-4 w-4 text-primary" />
							<h3 className="font-semibold">Observability</h3>
						</div>

						{observability.isLoading ? (
							<p className="text-sm text-muted-foreground">
								Loading observability summary...
							</p>
						) : observability.data ? (
							<div className="space-y-3">
								<div className="grid gap-3 sm:grid-cols-2">
									<div className="rounded-lg border p-3">
										<p className="text-xs text-muted-foreground">
											Conversations
										</p>
										<p className="text-2xl font-semibold">
											{
												observability.data.metrics
													.conversationCount
											}
										</p>
									</div>
									<div className="rounded-lg border p-3">
										<p className="text-xs text-muted-foreground">
											Messages, last 7 days
										</p>
										<p className="text-2xl font-semibold">
											{
												observability.data.metrics
													.messagesLast7d
											}
										</p>
									</div>
								</div>
								<div className="rounded-lg border bg-muted/20 p-4 text-sm leading-6">
									{observability.data.summaryText}
								</div>
							</div>
						) : (
							<p className="text-sm text-muted-foreground">
								No observability data available yet.
							</p>
						)}
					</section>

					<section className="space-y-4">
						<div className="flex items-center gap-2">
							<Sparkles className="h-4 w-4 text-primary" />
							<h3 className="font-semibold">Suggestions</h3>
						</div>

						{suggestions.isLoading ? (
							<p className="text-sm text-muted-foreground">
								Loading suggestions...
							</p>
						) : suggestions.data?.suggestions?.length ? (
							<div className="space-y-3">
								{!suggestions.data.canReview ? (
									<div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
										Review actions are read-only for this
										agent in your current role.
									</div>
								) : null}
								{suggestions.data.suggestions.map(
									(suggestion) => (
										<div
											key={suggestion.id}
											className="rounded-lg border p-4"
										>
											<div className="flex items-start justify-between gap-3">
												<div className="space-y-2">
													<div className="flex items-center gap-2">
														<p className="font-medium">
															{suggestion.title}
														</p>
														<Badge
															variant="outline"
															className="capitalize"
														>
															{suggestion.state}
														</Badge>
													</div>
													<p className="text-sm text-muted-foreground">
														{suggestion.description}
													</p>
												</div>
												<div className="flex items-center gap-2">
													<Button
														size="sm"
														variant="outline"
														disabled={
															!suggestions.data
																?.canReview
														}
														onClick={() =>
															updateSuggestionMutation.mutate(
																{
																	id: suggestion.id,
																	state: "approved",
																},
															)
														}
													>
														<Check className="mr-1 h-3.5 w-3.5" />
														Approve
													</Button>
													<Button
														size="sm"
														variant="outline"
														disabled={
															!suggestions.data
																?.canReview
														}
														onClick={() =>
															updateSuggestionMutation.mutate(
																{
																	id: suggestion.id,
																	state: "rejected",
																},
															)
														}
													>
														<X className="mr-1 h-3.5 w-3.5" />
														Reject
													</Button>
													<Button
														size="sm"
														variant="outline"
														disabled={
															!suggestions.data
																?.canReview
														}
														onClick={() =>
															updateSuggestionMutation.mutate(
																{
																	id: suggestion.id,
																	state: "outdated",
																},
															)
														}
													>
														<AlertCircle className="mr-1 h-3.5 w-3.5" />
														Outdated
													</Button>
												</div>
											</div>
										</div>
									),
								)}
							</div>
						) : (
							<div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
								<div className="flex items-center gap-2">
									<AlertCircle className="h-4 w-4" />
									No curation suggestions right now.
								</div>
							</div>
						)}
					</section>
				</div>
			</SheetContent>
		</Sheet>
	);
}
