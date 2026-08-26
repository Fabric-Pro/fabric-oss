"use client";

import { useTenantContext } from "@shared/hooks/use-tenant-query";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	CheckIcon,
	Loader2Icon,
	RefreshCwIcon,
	RefreshCwOffIcon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

// Client mirror of the server `FABRIC_FEATURE_LIVING_DOCS_REFRESH` flag —
// opt-in, default OFF. Must be read as a literal `process.env.X === "true"`
// expression so Next.js inlines it at build time (see the comment block in
// `@saas/shared/lib/feature-flags`). It deliberately does NOT live in that
// module: that one is for kill switches (default ON), this is opt-in.
const LIVING_DOCS_ENABLED =
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_LIVING_DOCS_REFRESH === "true";

type DocumentRefreshCadence =
	| "ON_DEPLOY"
	| "DAILY"
	| "WEEKLY"
	| "BIWEEKLY"
	| "MONTHLY";

const CADENCE_OPTIONS: { value: DocumentRefreshCadence; label: string }[] = [
	{ value: "ON_DEPLOY", label: "On every deploy" },
	{ value: "DAILY", label: "Daily" },
	{ value: "WEEKLY", label: "Weekly" },
	{ value: "BIWEEKLY", label: "Bi-weekly" },
	{ value: "MONTHLY", label: "Monthly" },
];

const DEFAULT_CADENCE: DocumentRefreshCadence = "BIWEEKLY";

const CADENCE_LABEL: Record<DocumentRefreshCadence, string> = {
	ON_DEPLOY: "On every deploy",
	DAILY: "Daily",
	WEEKLY: "Weekly",
	BIWEEKLY: "Bi-weekly",
	MONTHLY: "Monthly",
};

/**
 * What the last cycle did, in the owner's words.
 *
 * Without this, four very different outcomes are indistinguishable from the
 * document page — they all look like nothing happened. "The AI looked and
 * nothing needed changing" and "the AI could not run at all" are not the same
 * news, and a schedule the owner cannot see the result of is a schedule they
 * cannot trust. `tone: "bad"` is for the outcomes a person should act on.
 */
const REFRESH_STATUS: Record<
	string,
	{ label: string; tone: "good" | "bad" | "neutral" }
> = {
	COMMITTED: { label: "Applied automatically", tone: "good" },
	PROPOSED: { label: "Update drafted for review", tone: "good" },
	NO_CHANGES: { label: "No changes needed", tone: "neutral" },
	REFUSED: {
		label: "Skipped — needs a person",
		tone: "bad",
	},
	SKIPPED_COLLISION: {
		label: "Skipped — the document was being edited",
		tone: "neutral",
	},
	SKIPPED_STALE_ACTOR: {
		label: "Skipped — whoever enabled this lost access to the project",
		tone: "bad",
	},
	FAILED: { label: "Last refresh failed", tone: "bad" },
};

type DocumentAutoRefreshToggleProps = {
	documentId: string;
	projectId: string;
	className?: string;
};

/**
 * Masthead control for Living Documents auto-refresh: an opt-in toggle, a
 * settings popover (cadence + "apply automatically"), and the review surface for
 * a pending proposal.
 *
 * The product rule this UI exists to make true: A REFRESH PROPOSES, IT DOES NOT
 * WRITE. The AI drafts an update, the document owner reads it and decides. The
 * only way a refresh reaches the document unattended is if someone deliberately
 * turned "Apply automatically" on, which is off by default and says plainly what
 * it does. So the pending-proposal affordance is not a subtle badge — it is a
 * labelled, highlight-toned button sitting in the masthead until a human
 * resolves it.
 *
 * Renders nothing when the client feature flag is off. The flag gate lives in
 * the outer component, BEFORE any hook call, so the inner component's hooks are
 * never conditionally executed (same split as `ContextSummaryPanel`).
 */
export function DocumentAutoRefreshToggle(
	props: DocumentAutoRefreshToggleProps,
) {
	if (!LIVING_DOCS_ENABLED) {
		return null;
	}
	return <DocumentAutoRefreshToggleInner {...props} />;
}

function DocumentAutoRefreshToggleInner({
	documentId,
	projectId,
	className,
}: DocumentAutoRefreshToggleProps) {
	const queryClient = useQueryClient();
	const { queryKeyPrefix, organizationId } = useTenantContext();
	const key = [...queryKeyPrefix, "documents", "auto-refresh", documentId];
	const [proposalOpen, setProposalOpen] = useState(false);

	const query = useQuery({
		queryKey: key,
		queryFn: () =>
			orpcClient.projects.documents.getAutoRefresh({
				id: documentId,
				projectId,
				organizationId,
			}),
	});

	const enabled = query.data?.enabled ?? false;
	const autoApply = query.data?.autoApply ?? false;
	const cadence = (query.data?.cadence ??
		DEFAULT_CADENCE) as DocumentRefreshCadence;
	const pending = query.data?.pending ?? null;

	// A proposal has its own affordance, so repeating "Update drafted for review"
	// in the settings popover would be noise. Every other outcome has nowhere else
	// to be seen.
	const lastStatus =
		query.data?.lastRefreshStatus &&
		query.data.lastRefreshStatus !== "PROPOSED"
			? (REFRESH_STATUS[query.data.lastRefreshStatus] ?? null)
			: null;
	// A completed cycle stamps `lastRefreshedAt`; a failed one only ever stamps
	// `lastAttemptAt`. Prefer the attempt time when it is the later of the two, so
	// a failure after a success does not get labelled with the success's date.
	const lastRefreshedAt = query.data?.lastRefreshedAt
		? new Date(query.data.lastRefreshedAt)
		: null;
	const lastAttemptAt = query.data?.lastAttemptAt
		? new Date(query.data.lastAttemptAt)
		: null;
	const lastRanAt =
		lastAttemptAt && (!lastRefreshedAt || lastAttemptAt > lastRefreshedAt)
			? lastAttemptAt
			: lastRefreshedAt;

	const mutation = useMutation({
		mutationFn: (next: {
			enabled: boolean;
			cadence: DocumentRefreshCadence;
			autoApply: boolean;
		}) =>
			orpcClient.projects.documents.setAutoRefresh({
				id: documentId,
				projectId,
				organizationId,
				enabled: next.enabled,
				cadence: next.cadence,
				autoApply: next.autoApply,
			}),
		// Optimistic so the button flips instantly and rolls back on error —
		// mirrors `useSubscription`.
		onMutate: async (next) => {
			await queryClient.cancelQueries({ queryKey: key });
			const previous = queryClient.getQueryData(key);
			queryClient.setQueryData(key, (old: unknown) => ({
				...(old as Record<string, unknown> | undefined),
				enabled: next.enabled,
				cadence: next.cadence,
				autoApply: next.autoApply,
			}));
			return { previous };
		},
		onError: (_err, _next, context) => {
			if (context?.previous !== undefined) {
				queryClient.setQueryData(key, context.previous);
			}
			toast.error("Could not update auto-refresh for this document.");
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: key });
		},
	});

	/**
	 * The document's body and its version list are both stale the moment a
	 * proposal is committed — the editor is showing the pre-refresh content and
	 * the history is missing the version the accept just created.
	 */
	const invalidateDocument = () => {
		queryClient.invalidateQueries({
			queryKey: orpc.projects.documents.get.queryKey({
				input: { id: documentId, projectId },
			}),
		});
		queryClient.invalidateQueries({
			queryKey: orpc.projects.documents.versions.list.queryKey({
				input: { projectId, documentId, organizationId },
			}),
		});
	};

	const applyMutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.documents.applyAutoRefreshProposal({
				id: documentId,
				projectId,
				organizationId,
			}),
		onSuccess: (result) => {
			setProposalOpen(false);
			// The server clears the proposal on BOTH paths, so the settings query is
			// refetched either way — the proposal affordance disappears regardless.
			queryClient.invalidateQueries({ queryKey: key });

			if (result.applied) {
				invalidateDocument();
				toast.success("Update applied to this document.");
				return;
			}

			// Stale: the document moved after the AI drafted this, so nothing was
			// written. Say exactly that — the alternative (applying anyway) would
			// have silently reverted whoever edited in between.
			toast.error(
				"This document changed after the update was drafted, so it was not applied. The next refresh will start from the current version.",
			);
		},
		onError: () => {
			toast.error("Could not apply the proposed update.");
		},
	});

	const discardMutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.documents.discardAutoRefreshProposal({
				id: documentId,
				projectId,
				organizationId,
			}),
		onSuccess: () => {
			setProposalOpen(false);
			queryClient.invalidateQueries({ queryKey: key });
			toast.success("Proposed update discarded.");
		},
		onError: () => {
			toast.error("Could not discard the proposed update.");
		},
	});

	const isResolving = applyMutation.isPending || discardMutation.isPending;
	const isBusy = query.isLoading || mutation.isPending;
	const label = enabled
		? "Turn off scheduled auto-refresh"
		: "Turn on scheduled auto-refresh";
	const Icon = mutation.isPending
		? Loader2Icon
		: enabled
			? RefreshCwIcon
			: RefreshCwOffIcon;

	const proposedAt = pending?.proposedAt
		? new Date(pending.proposedAt)
		: null;

	return (
		<TooltipProvider>
			<div className={cn("flex items-center gap-1", className)}>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={() =>
								mutation.mutate({
									enabled: !enabled,
									cadence,
									autoApply,
								})
							}
							disabled={isBusy}
							aria-label={label}
							aria-pressed={enabled}
							className={cn(
								"shrink-0 size-8 text-muted-foreground transition-colors hover:text-foreground",
								enabled && "text-primary hover:text-primary",
							)}
						>
							<Icon
								className={cn(
									"size-4",
									mutation.isPending &&
										"motion-safe:animate-spin",
								)}
							/>
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p className="font-medium">{label}</p>
						<p className="text-xs text-muted-foreground">
							Fabric reviews recent project context on a schedule
							and drafts an update for you to review.
						</p>
					</TooltipContent>
				</Tooltip>

				{enabled && (
					<Popover>
						<PopoverTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={mutation.isPending}
								aria-label={
									lastStatus?.tone === "bad"
										? `Auto-refresh settings — ${lastStatus.label}`
										: "Auto-refresh settings"
								}
								className={cn(
									"h-8 gap-1 px-2 text-muted-foreground text-xs transition-colors hover:text-foreground",
									// A failed cycle must be legible without opening the
									// popover first — nobody goes looking for bad news.
									lastStatus?.tone === "bad" &&
										"text-destructive hover:text-destructive",
								)}
							>
								{CADENCE_LABEL[cadence]}
							</Button>
						</PopoverTrigger>
						<PopoverContent align="end" className="w-80 space-y-4">
							<div className="space-y-2">
								<Label
									htmlFor="auto-refresh-cadence"
									className="font-medium text-xs"
								>
									Refresh cadence
								</Label>
								<Select
									value={cadence}
									disabled={mutation.isPending}
									onValueChange={(value) =>
										mutation.mutate({
											enabled: true,
											cadence:
												value as DocumentRefreshCadence,
											autoApply,
										})
									}
								>
									<SelectTrigger
										id="auto-refresh-cadence"
										aria-label="Auto-refresh cadence"
										className="h-8 text-xs"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{CADENCE_OPTIONS.map((option) => (
											<SelectItem
												key={option.value}
												value={option.value}
											>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							<div className="space-y-2 border-border border-t pt-3">
								<div className="flex items-center justify-between gap-3">
									<Label
										htmlFor="auto-refresh-auto-apply"
										className="font-medium text-xs"
									>
										Apply automatically
									</Label>
									<Switch
										id="auto-refresh-auto-apply"
										checked={autoApply}
										disabled={mutation.isPending}
										onCheckedChange={(checked) =>
											mutation.mutate({
												enabled: true,
												cadence,
												autoApply: checked,
											})
										}
									/>
								</div>
								{/* The honest description of what each position of this
								    switch actually does. It is the difference between
								    "an AI drafts something for you" and "an AI edits
								    your document while you are not looking". */}
								<p className="text-muted-foreground text-xs leading-relaxed">
									{autoApply
										? "Fabric writes each refresh straight to this document. A new version is created and attributed to the AI — you are not asked first."
										: "Fabric drafts each refresh and waits. Nothing is written to this document until you review it and choose Apply."}
								</p>
							</div>

							{lastStatus && (
								<div className="space-y-1 border-border border-t pt-3">
									<p className="font-medium text-xs">
										Last refresh
									</p>
									<p
										className={cn(
											"text-xs",
											lastStatus.tone === "bad"
												? "text-destructive"
												: "text-muted-foreground",
										)}
									>
										{lastStatus.label}
										{lastRanAt && (
											<time
												className="text-muted-foreground"
												dateTime={lastRanAt.toISOString()}
												title={lastRanAt.toLocaleString()}
											>
												{" · "}
												{formatDistanceToNow(
													lastRanAt,
													{
														addSuffix: true,
													},
												)}
											</time>
										)}
									</p>
									{query.data?.lastRefreshSummary && (
										<p className="text-muted-foreground text-xs leading-relaxed">
											{query.data.lastRefreshSummary}
										</p>
									)}
								</div>
							)}
						</PopoverContent>
					</Popover>
				)}

				{pending && (
					<Popover open={proposalOpen} onOpenChange={setProposalOpen}>
						<PopoverTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-8 gap-1.5 border border-highlight/40 bg-highlight/10 px-2 text-highlight text-xs transition-colors hover:bg-highlight/20 hover:text-highlight"
							>
								<SparklesIcon
									className="size-3.5"
									aria-hidden
								/>
								Review update
							</Button>
						</PopoverTrigger>
						<PopoverContent align="end" className="w-96 space-y-3">
							<div className="space-y-1">
								<p className="font-medium text-sm">
									Proposed update
								</p>
								{proposedAt && (
									<p className="text-muted-foreground text-xs">
										Drafted{" "}
										<time
											dateTime={proposedAt.toISOString()}
											title={proposedAt.toLocaleString()}
										>
											{formatDistanceToNow(proposedAt, {
												addSuffix: true,
											})}
										</time>
									</p>
								)}
							</div>

							<p className="text-foreground text-xs leading-relaxed">
								{pending.summary ??
									"Fabric drafted an update to this document based on recent project context."}
							</p>

							<p className="text-muted-foreground text-xs leading-relaxed">
								Applying creates a new version of this document,
								authored by you.
							</p>

							<div className="flex items-center justify-end gap-2 border-border border-t pt-3">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-8 gap-1.5 text-xs"
									disabled={isResolving}
									onClick={() => discardMutation.mutate()}
								>
									{discardMutation.isPending ? (
										<Loader2Icon className="size-3.5 motion-safe:animate-spin" />
									) : (
										<XIcon
											className="size-3.5"
											aria-hidden
										/>
									)}
									Discard
								</Button>
								<Button
									type="button"
									variant="primary"
									size="sm"
									className="h-8 gap-1.5 text-xs"
									disabled={isResolving}
									onClick={() => applyMutation.mutate()}
								>
									{applyMutation.isPending ? (
										<Loader2Icon className="size-3.5 motion-safe:animate-spin" />
									) : (
										<CheckIcon
											className="size-3.5"
											aria-hidden
										/>
									)}
									Apply
								</Button>
							</div>
						</PopoverContent>
					</Popover>
				)}
			</div>
		</TooltipProvider>
	);
}
