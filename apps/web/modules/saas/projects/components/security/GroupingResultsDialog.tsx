"use client";

/**
 * Review + results dialog for a security/accessibility finding-grouping run.
 *
 * Two modes, driven by the run status:
 *  - AWAITING_REVIEW → REVIEW mode: each proposed ticket is previewable and can
 *    be accepted (with a per-ticket "sync to PM" choice) or declined (declines
 *    persist across runs). Select-all / sync-all in the header; "Create N
 *    tickets" in the footer applies via `scan.grouping.apply`.
 *  - COMPLETED (or "view last run") → RESULTS mode: read-only outcomes
 *    (created / updated / declined / skipped / failed), with the manual
 *    "reattach theme" action on real tickets and "Re-add" on declined ones.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { cn } from "@ui/lib";
import {
	ArrowRightIcon,
	ChevronDownIcon,
	Link2Icon,
	Loader2Icon,
	RotateCcwIcon,
	TicketIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	CATEGORY_LABEL,
	GROUPING_OUTCOME_BADGE_VARIANT,
	GROUPING_OUTCOME_LABEL,
	type GroupingCreatedTheme,
	type GroupingFailedTheme,
	type GroupingProposalCreate,
	type GroupingProposalUpdate,
	type GroupingSkippedTheme,
	type GroupingUpdatedTheme,
	type ScanFindingGrouping,
} from "./lib";
import { buildStoryHref } from "./lib/story-href";

const PRIORITY_LABEL: Record<string, string> = {
	P0_CRITICAL: "Critical",
	P1_HIGH: "High",
	P2_MEDIUM: "Medium",
	P3_LOW: "Low",
};
function priorityLabel(priority: string): string {
	return PRIORITY_LABEL[priority] ?? priority;
}

export function GroupingResultsDialog({
	grouping,
	isOpen,
	onClose,
	projectId,
	organizationId,
}: {
	grouping: ScanFindingGrouping | null;
	isOpen: boolean;
	onClose: () => void;
	projectId?: string;
	organizationId?: string | null;
}) {
	const pathname = usePathname();
	const queryClient = useQueryClient();
	// Build the tenant-aware story route for a grouped ticket's feature. The
	// Security view is a client-side tab, so `pathname` is the project root, not
	// `…/security` — `buildStoryHref` derives the project base and appends
	// `/stories/<id>` (see its doc comment).
	const storyHref = (storyId: string) => buildStoryHref(pathname, storyId);

	const results = grouping?.results ?? null;
	const isReview = grouping?.status === "AWAITING_REVIEW";

	const proposedCreate = useMemo(
		() => results?.proposedCreate ?? [],
		[results],
	);
	const proposedUpdate = useMemo(
		() => results?.proposedUpdate ?? [],
		[results],
	);
	const declinedThemes = useMemo(
		() => results?.declinedThemes ?? [],
		[results],
	);
	const skippedThemes = results?.skippedThemes ?? [];
	const failedThemes = results?.failedThemes ?? [];
	const createdThemes = results?.createdThemes ?? [];
	const updatedThemes = results?.updatedThemes ?? [];

	// PM capability drives whether the per-ticket "sync to PM" control is shown.
	const pmQuery = useQuery(
		orpc.projects.stories.pmCapabilities.queryOptions({
			input: {
				projectId: projectId ?? "",
				organizationId: organizationId ?? null,
			},
			enabled: isOpen && !!projectId,
		}),
	);
	const hasPMTool = pmQuery.data?.configured ?? false;
	const pmToolName = pmQuery.data?.detectedType ?? "PM tool";

	// ---- Review decision state (create + update proposals) ----
	const [acceptedKeys, setAcceptedKeys] = useState<Set<string>>(new Set());
	const [declinedKeys, setDeclinedKeys] = useState<Set<string>>(new Set());
	const [syncByKey, setSyncByKey] = useState<Record<string, boolean>>({});
	const [expandedKey, setExpandedKey] = useState<string | null>(null);

	// Initialize decisions when a review run opens: accept everything by default,
	// sync every create on when a PM tool is connected (user unchecks to skip).
	// Deps intentionally exclude the derived proposal arrays — re-init only when
	// the run id / open state / PM availability changes (those cover the arrays).
	useEffect(() => {
		if (!isOpen || !isReview) {
			return;
		}
		const allKeys = new Set<string>([
			...proposedCreate.map((p) => p.themeKey),
			...proposedUpdate.map((p) => p.themeKey),
		]);
		setAcceptedKeys(allKeys);
		setDeclinedKeys(new Set());
		setSyncByKey(
			Object.fromEntries(
				proposedCreate.map((p) => [p.themeKey, hasPMTool]),
			),
		);
		setExpandedKey(null);
	}, [isOpen, isReview, grouping?.id, hasPMTool]);

	const accept = (key: string) => {
		setAcceptedKeys((s) => new Set(s).add(key));
		setDeclinedKeys((s) => {
			const n = new Set(s);
			n.delete(key);
			return n;
		});
	};
	const unaccept = (key: string) => {
		setAcceptedKeys((s) => {
			const n = new Set(s);
			n.delete(key);
			return n;
		});
	};
	const decline = (key: string) => {
		setDeclinedKeys((s) => new Set(s).add(key));
		unaccept(key);
	};

	const allProposalKeys = useMemo(
		() => [
			...proposedCreate.map((p) => p.themeKey),
			...proposedUpdate.map((p) => p.themeKey),
		],
		[proposedCreate, proposedUpdate],
	);
	const allSelected =
		allProposalKeys.length > 0 &&
		allProposalKeys.every((k) => acceptedKeys.has(k));
	const toggleSelectAll = () => {
		if (allSelected) {
			setAcceptedKeys(new Set());
		} else {
			setAcceptedKeys(new Set(allProposalKeys));
			setDeclinedKeys(new Set());
		}
	};
	const allSynced =
		proposedCreate.length > 0 &&
		proposedCreate.every((p) => syncByKey[p.themeKey]);
	const toggleSyncAll = () => {
		const next = !allSynced;
		setSyncByKey(
			Object.fromEntries(proposedCreate.map((p) => [p.themeKey, next])),
		);
	};

	const applyMutation = useMutation(
		orpc.projects.scan.grouping.apply.mutationOptions({
			onSuccess: (res) => {
				toast.success(
					`Created ${res.createdCount} ticket(s), updated ${res.updatedCount}${res.declinedCount ? `, declined ${res.declinedCount}` : ""}`,
				);
				queryClient.invalidateQueries({
					queryKey: orpc.projects.scan.grouping.latest.key(),
				});
				if (res.createdCount + res.updatedCount > 0) {
					queryClient.invalidateQueries({
						queryKey: orpc.projects.stories.list.key(),
					});
				}
				onClose();
			},
			onError: (error) => {
				toast.error(`Couldn't create tickets: ${error.message}`);
			},
		}),
	);

	const readdMutation = useMutation(
		orpc.projects.scan.grouping.readd.mutationOptions({
			onSuccess: (res) => {
				toast.success(`Re-added as ${res.storyIdentifier}`);
				queryClient.invalidateQueries({
					queryKey: orpc.projects.scan.grouping.latest.key(),
				});
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.list.key(),
				});
			},
			onError: (error) => {
				toast.error(`Couldn't re-add: ${error.message}`);
			},
		}),
	);

	const onApply = () => {
		if (!grouping) {
			return;
		}
		applyMutation.mutate({
			projectId: projectId ?? "",
			organizationId: organizationId ?? null,
			groupingId: grouping.id,
			accepted: allProposalKeys
				.filter((k) => acceptedKeys.has(k))
				.map((k) => ({ themeKey: k, syncToPM: syncByKey[k] ?? false })),
			declinedThemeKeys: [...declinedKeys],
		});
	};

	const onReadd = (themeKey: string) => {
		if (!grouping) {
			return;
		}
		readdMutation.mutate({
			projectId: projectId ?? "",
			organizationId: organizationId ?? null,
			groupingId: grouping.id,
			themeKey,
		});
	};

	const acceptedCount = allProposalKeys.filter((k) =>
		acceptedKeys.has(k),
	).length;
	const nothingToReview =
		proposedCreate.length === 0 &&
		proposedUpdate.length === 0 &&
		declinedThemes.length === 0;

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
				<DialogHeader className="shrink-0 space-y-1.5 border-border border-b px-6 py-4">
					<DialogTitle className="flex items-center gap-2">
						<TicketIcon
							aria-hidden="true"
							className="size-4 text-primary"
						/>
						{isReview ? "Review tickets" : "Grouping results"}
					</DialogTitle>
					<DialogDescription>
						{isReview
							? "Preview each ticket before it's created. Choose which to create, whether each syncs to your PM tool, and decline the ones you don't want (declines are remembered on future runs)."
							: "Open findings grouped into thematic tickets, one per theme. Incremental runs add a comment instead of duplicating a ticket."}
					</DialogDescription>
				</DialogHeader>

				{/* Review toolbar */}
				{isReview && !nothingToReview ? (
					<div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-border border-b bg-muted/30 px-6 py-2.5">
						<label
							htmlFor="grouping-select-all"
							className="inline-flex cursor-pointer items-center gap-2 text-sm"
						>
							<Checkbox
								id="grouping-select-all"
								checked={allSelected}
								onCheckedChange={toggleSelectAll}
								aria-label="Select all tickets"
							/>
							Select all
							<span className="text-muted-foreground">
								({acceptedCount} of {allProposalKeys.length})
							</span>
						</label>
						{hasPMTool && proposedCreate.length > 0 ? (
							<label
								htmlFor="grouping-sync-all"
								className="inline-flex cursor-pointer items-center gap-2 text-muted-foreground text-sm"
							>
								<Checkbox
									id="grouping-sync-all"
									checked={allSynced}
									onCheckedChange={toggleSyncAll}
									aria-label={`Sync all to ${pmToolName}`}
								/>
								Sync all to {pmToolName}
							</label>
						) : null}
					</div>
				) : null}

				<div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
					{isReview ? (
						nothingToReview ? (
							<EmptyResults />
						) : (
							<>
								<Section
									title="To create"
									count={proposedCreate.length}
									hidden={proposedCreate.length === 0}
								>
									{proposedCreate.map((p) => (
										<CreateReviewRow
											key={p.themeKey}
											proposal={p}
											accepted={acceptedKeys.has(
												p.themeKey,
											)}
											declined={declinedKeys.has(
												p.themeKey,
											)}
											sync={
												syncByKey[p.themeKey] ?? false
											}
											hasPMTool={hasPMTool}
											pmToolName={pmToolName}
											expanded={
												expandedKey === p.themeKey
											}
											onToggleExpand={() =>
												setExpandedKey((k) =>
													k === p.themeKey
														? null
														: p.themeKey,
												)
											}
											onAccept={(v) =>
												v
													? accept(p.themeKey)
													: unaccept(p.themeKey)
											}
											onDecline={() =>
												decline(p.themeKey)
											}
											onSync={(v) =>
												setSyncByKey((m) => ({
													...m,
													[p.themeKey]: v,
												}))
											}
										/>
									))}
								</Section>

								<Section
									title="To update (existing tickets)"
									count={proposedUpdate.length}
									hidden={proposedUpdate.length === 0}
								>
									{proposedUpdate.map((p) => (
										<UpdateReviewRow
											key={p.themeKey}
											proposal={p}
											storyHref={storyHref}
											accepted={acceptedKeys.has(
												p.themeKey,
											)}
											declined={declinedKeys.has(
												p.themeKey,
											)}
											expanded={
												expandedKey === p.themeKey
											}
											onToggleExpand={() =>
												setExpandedKey((k) =>
													k === p.themeKey
														? null
														: p.themeKey,
												)
											}
											onAccept={(v) =>
												v
													? accept(p.themeKey)
													: unaccept(p.themeKey)
											}
											onDecline={() =>
												decline(p.themeKey)
											}
										/>
									))}
								</Section>

								<Section
									title="Declined"
									count={declinedThemes.length}
									hidden={declinedThemes.length === 0}
								>
									{declinedThemes.map((p) => (
										<DeclinedRow
											key={p.themeKey}
											proposal={p}
											onReadd={() => onReadd(p.themeKey)}
											readding={readdMutation.isPending}
										/>
									))}
								</Section>

								<InfoSection
									skipped={skippedThemes}
									failed={failedThemes}
								/>
							</>
						)
					) : (
						<ResultsView
							created={createdThemes}
							updated={updatedThemes}
							declined={declinedThemes}
							skipped={skippedThemes}
							failed={failedThemes}
							storyHref={storyHref}
							onReadd={onReadd}
							readding={readdMutation.isPending}
							projectId={projectId}
							organizationId={organizationId ?? null}
						/>
					)}
				</div>

				<DialogFooter className="shrink-0 gap-2 border-border border-t px-6 py-4">
					{isReview ? (
						// Show the apply footer for the whole review — including when it's
						// empty (e.g. every proposal was declined or re-added), so the run
						// can be finished/completed instead of getting stuck awaiting review.
						<>
							<Button variant="ghost" onClick={onClose}>
								Cancel
							</Button>
							<Button
								onClick={onApply}
								disabled={applyMutation.isPending}
								className="gap-2"
							>
								{applyMutation.isPending ? (
									<Loader2Icon
										aria-hidden="true"
										className="size-4 motion-safe:animate-spin"
									/>
								) : null}
								{acceptedCount > 0
									? `Create ${acceptedCount} ticket${acceptedCount === 1 ? "" : "s"}`
									: declinedKeys.size > 0
										? "Apply"
										: "Finish review"}
							</Button>
						</>
					) : (
						<Button onClick={onClose}>Close</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function Section({
	title,
	count,
	hidden,
	children,
}: {
	title: string;
	count: number;
	hidden?: boolean;
	children: React.ReactNode;
}) {
	if (hidden) {
		return null;
	}
	return (
		<section className="space-y-2">
			<h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
				{title}{" "}
				<span className="text-muted-foreground/70">({count})</span>
			</h3>
			<ul className="space-y-2">{children}</ul>
		</section>
	);
}

function PreviewToggle({
	expanded,
	onToggle,
}: {
	expanded: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
			aria-expanded={expanded}
		>
			<ChevronDownIcon
				aria-hidden="true"
				className={cn(
					"size-3.5 transition-transform",
					expanded && "rotate-180",
				)}
			/>
			Preview
		</button>
	);
}

function PreviewBody({ body }: { body: string }) {
	return (
		<div className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-muted-foreground text-xs leading-relaxed">
			{body}
		</div>
	);
}

function CreateReviewRow({
	proposal,
	accepted,
	declined,
	sync,
	hasPMTool,
	pmToolName,
	expanded,
	onToggleExpand,
	onAccept,
	onDecline,
	onSync,
}: {
	proposal: GroupingProposalCreate;
	accepted: boolean;
	declined: boolean;
	sync: boolean;
	hasPMTool: boolean;
	pmToolName: string;
	expanded: boolean;
	onToggleExpand: () => void;
	onAccept: (v: boolean) => void;
	onDecline: () => void;
	onSync: (v: boolean) => void;
}) {
	return (
		<li
			className={cn(
				"rounded-lg border border-border bg-card p-3.5",
				declined && "opacity-60",
			)}
		>
			<div className="flex items-start gap-3">
				<Checkbox
					checked={accepted}
					onCheckedChange={(v) => onAccept(v === true)}
					disabled={declined}
					aria-label={`Create ticket: ${proposal.title}`}
					className="mt-0.5"
				/>
				<div className="min-w-0 flex-1 space-y-1.5">
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="outline" className="font-normal">
							{CATEGORY_LABEL[proposal.category]}
						</Badge>
						<Badge variant="secondary" className="font-normal">
							{priorityLabel(proposal.priority)}
						</Badge>
						{declined ? (
							<Badge variant="secondary" className="font-normal">
								Declined
							</Badge>
						) : null}
					</div>
					<p className="break-words font-medium text-foreground text-sm leading-snug">
						{proposal.title}
					</p>
					<p className="text-muted-foreground text-xs">
						{proposal.findingCount}{" "}
						{proposal.findingCount === 1 ? "finding" : "findings"}
						{proposal.severity ? ` · ${proposal.severity}` : ""}
					</p>
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0.5">
						<PreviewToggle
							expanded={expanded}
							onToggle={onToggleExpand}
						/>
						{hasPMTool ? (
							<label
								htmlFor={`sync-${proposal.themeKey}`}
								className="inline-flex cursor-pointer items-center gap-1.5 text-muted-foreground text-xs"
							>
								<Checkbox
									id={`sync-${proposal.themeKey}`}
									checked={sync}
									onCheckedChange={(v) => onSync(v === true)}
									disabled={declined}
									aria-label={`Sync ${proposal.title} to ${pmToolName}`}
								/>
								Sync to {pmToolName}
							</label>
						) : null}
						{!declined ? (
							<button
								type="button"
								onClick={onDecline}
								className="text-muted-foreground text-xs hover:text-destructive"
							>
								Decline
							</button>
						) : null}
					</div>
					{expanded ? <PreviewBody body={proposal.body} /> : null}
				</div>
			</div>
		</li>
	);
}

function UpdateReviewRow({
	proposal,
	storyHref,
	accepted,
	declined,
	expanded,
	onToggleExpand,
	onAccept,
	onDecline,
}: {
	proposal: GroupingProposalUpdate;
	storyHref: (storyId: string) => string;
	accepted: boolean;
	declined: boolean;
	expanded: boolean;
	onToggleExpand: () => void;
	onAccept: (v: boolean) => void;
	onDecline: () => void;
}) {
	return (
		<li
			className={cn(
				"rounded-lg border border-border bg-card p-3.5",
				declined && "opacity-60",
			)}
		>
			<div className="flex items-start gap-3">
				<Checkbox
					checked={accepted}
					onCheckedChange={(v) => onAccept(v === true)}
					disabled={declined}
					aria-label={`Update ticket ${proposal.storyIdentifier}`}
					className="mt-0.5"
				/>
				<div className="min-w-0 flex-1 space-y-1.5">
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="info" className="font-normal">
							Add comment
						</Badge>
						<Link
							href={storyHref(proposal.storyId)}
							className="inline-flex items-center gap-1 font-medium text-primary text-sm hover:underline"
						>
							{proposal.storyIdentifier}
						</Link>
					</div>
					<p className="break-words text-foreground text-sm leading-snug">
						{proposal.ruleSource}
					</p>
					<p className="text-muted-foreground text-xs">
						{proposal.newFindingCount} new finding
						{proposal.newFindingCount === 1 ? "" : "s"} since the
						last run
					</p>
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0.5">
						<PreviewToggle
							expanded={expanded}
							onToggle={onToggleExpand}
						/>
						{!declined ? (
							<button
								type="button"
								onClick={onDecline}
								className="text-muted-foreground text-xs hover:text-destructive"
							>
								Decline
							</button>
						) : null}
					</div>
					{expanded ? (
						<PreviewBody body={proposal.commentBody} />
					) : null}
				</div>
			</div>
		</li>
	);
}

function DeclinedRow({
	proposal,
	onReadd,
	readding,
}: {
	proposal: GroupingProposalCreate;
	onReadd: () => void;
	readding: boolean;
}) {
	return (
		<li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border border-dashed bg-muted/20 p-3.5">
			<div className="min-w-0 space-y-1">
				<p className="break-words font-medium text-foreground text-sm leading-snug">
					{proposal.title}
				</p>
				<p className="text-muted-foreground text-xs">
					{proposal.findingCount}{" "}
					{proposal.findingCount === 1 ? "finding" : "findings"} ·
					declined
				</p>
			</div>
			<Button
				size="sm"
				variant="outline"
				className="gap-1.5"
				onClick={onReadd}
				disabled={readding}
			>
				{readding ? (
					<Loader2Icon
						aria-hidden="true"
						className="size-3.5 motion-safe:animate-spin"
					/>
				) : (
					<RotateCcwIcon aria-hidden="true" className="size-3.5" />
				)}
				Re-add
			</Button>
		</li>
	);
}

function InfoSection({
	skipped,
	failed,
}: {
	skipped: GroupingSkippedTheme[];
	failed: GroupingFailedTheme[];
}) {
	if (skipped.length === 0 && failed.length === 0) {
		return null;
	}
	return (
		<section className="space-y-2">
			{skipped.length > 0 ? (
				<p className="text-muted-foreground text-xs">
					{skipped.length} theme{skipped.length === 1 ? "" : "s"}{" "}
					already covered — nothing new to add.
				</p>
			) : null}
			{failed.length > 0 ? (
				<p className="text-destructive text-xs">
					{failed.length} theme{failed.length === 1 ? "" : "s"}{" "}
					couldn't be prepared this run.
				</p>
			) : null}
		</section>
	);
}

// ---- Results (read-only) mode ------------------------------------------------

type OutcomeRow =
	| { outcome: "created"; key: string; theme: GroupingCreatedTheme }
	| { outcome: "updated"; key: string; theme: GroupingUpdatedTheme }
	| { outcome: "skipped"; key: string; theme: GroupingSkippedTheme }
	| { outcome: "failed"; key: string; theme: GroupingFailedTheme };

function ResultsView({
	created,
	updated,
	declined,
	skipped,
	failed,
	storyHref,
	onReadd,
	readding,
	projectId,
	organizationId,
}: {
	created: GroupingCreatedTheme[];
	updated: GroupingUpdatedTheme[];
	declined: GroupingProposalCreate[];
	skipped: GroupingSkippedTheme[];
	failed: GroupingFailedTheme[];
	storyHref: (storyId: string) => string;
	onReadd: (themeKey: string) => void;
	readding: boolean;
	projectId?: string;
	organizationId: string | null;
}) {
	const queryClient = useQueryClient();
	const [reattachingKey, setReattachingKey] = useState<string | null>(null);
	const canReattach = !!projectId;

	const storiesQuery = useQuery(
		orpc.projects.stories.list.queryOptions({
			input: {
				projectId: projectId ?? "",
				organizationId: organizationId ?? null,
			},
			enabled: canReattach && !!reattachingKey,
		}),
	);
	const targetStories = useMemo(
		() =>
			(storiesQuery.data?.stories ?? [])
				.filter((s) => !s.status?.isFinal)
				.map((s) => ({
					id: s.id,
					identifier: s.identifier,
					title: s.title,
				})),
		[storiesQuery.data],
	);

	const reattachMutation = useMutation(
		orpc.projects.scan.grouping.reattach.mutationOptions({
			onSuccess: (res) => {
				toast.success(`Theme reattached to ${res.targetIdentifier}`);
				setReattachingKey(null);
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.list.key(),
				});
				queryClient.invalidateQueries({
					queryKey: orpc.projects.scan.grouping.latest.key(),
				});
			},
			onError: (error) => {
				toast.error(`Couldn't reattach: ${error.message}`);
			},
		}),
	);

	const rows: OutcomeRow[] = [
		...created.map((theme) => ({
			outcome: "created" as const,
			key: theme.themeKey,
			theme,
		})),
		...updated.map((theme) => ({
			outcome: "updated" as const,
			key: theme.themeKey,
			theme,
		})),
		...skipped.map((theme) => ({
			outcome: "skipped" as const,
			key: theme.themeKey,
			theme,
		})),
		...failed.map((theme) => ({
			outcome: "failed" as const,
			key: theme.themeKey,
			theme,
		})),
	];

	if (rows.length === 0 && declined.length === 0) {
		return <EmptyResults />;
	}

	return (
		<div className="space-y-4">
			{rows.length > 0 ? (
				<ul className="space-y-2">
					{rows.map((row) => {
						const currentStoryId =
							row.outcome !== "failed" ? row.theme.storyId : null;
						return (
							<li
								key={row.key}
								className="rounded-lg border border-border bg-card p-3.5"
							>
								<div className="flex flex-wrap items-start justify-between gap-3">
									<div className="min-w-0 space-y-1.5">
										<div className="flex flex-wrap items-center gap-2">
											<Badge
												variant={
													GROUPING_OUTCOME_BADGE_VARIANT[
														row.outcome
													]
												}
											>
												{
													GROUPING_OUTCOME_LABEL[
														row.outcome
													]
												}
											</Badge>
											<Badge
												variant="outline"
												className="font-normal"
											>
												{
													CATEGORY_LABEL[
														row.theme.category
													]
												}
											</Badge>
										</div>
										<p className="break-words font-medium text-foreground text-sm leading-snug">
											{row.theme.ruleSource}
										</p>
										<p className="text-muted-foreground text-xs">
											{row.theme.findingCount}{" "}
											{row.theme.findingCount === 1
												? "finding"
												: "findings"}
											{row.outcome === "updated"
												? ` · ${row.theme.newFindingCount} new`
												: null}
										</p>
										{row.outcome === "failed" ? (
											<p className="text-destructive text-xs">
												{row.theme.reason}
											</p>
										) : null}
									</div>
									<div className="flex shrink-0 flex-col items-end gap-1.5">
										{row.outcome !== "failed" ? (
											<Link
												href={storyHref(
													row.theme.storyId,
												)}
												className="inline-flex items-center gap-1.5 font-medium text-primary text-sm hover:underline"
											>
												<ArrowRightIcon
													aria-hidden="true"
													className="size-3.5"
												/>
												{row.theme.storyIdentifier}
											</Link>
										) : null}
										{canReattach &&
										row.outcome !== "failed" ? (
											<button
												type="button"
												onClick={() =>
													setReattachingKey((k) =>
														k === row.key
															? null
															: row.key,
													)
												}
												className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
												aria-expanded={
													reattachingKey === row.key
												}
											>
												<Link2Icon
													aria-hidden="true"
													className="size-3"
												/>
												Reattach
											</button>
										) : null}
									</div>
								</div>
								{reattachingKey === row.key ? (
									<ReattachPicker
										targets={targetStories.filter(
											(s) => s.id !== currentStoryId,
										)}
										pending={reattachMutation.isPending}
										onReattach={(targetStoryId) =>
											reattachMutation.mutate({
												projectId: projectId ?? "",
												organizationId,
												themeKey: row.key,
												targetStoryId,
											})
										}
									/>
								) : null}
							</li>
						);
					})}
				</ul>
			) : null}

			{declined.length > 0 ? (
				<Section title="Declined" count={declined.length}>
					{declined.map((p) => (
						<DeclinedRow
							key={p.themeKey}
							proposal={p}
							onReadd={() => onReadd(p.themeKey)}
							readding={readding}
						/>
					))}
				</Section>
			) : null}
		</div>
	);
}

function ReattachPicker({
	targets,
	pending,
	onReattach,
}: {
	targets: Array<{ id: string; identifier: string; title: string }>;
	pending: boolean;
	onReattach: (targetStoryId: string) => void;
}) {
	const [selected, setSelected] = useState("");
	return (
		<div className="mt-3 flex flex-wrap items-center gap-2 border-border border-t pt-3">
			<label className="text-muted-foreground text-xs">
				Move theme to:
				<select
					className="ml-2 rounded-md border border-border bg-background px-2 py-1 text-foreground text-xs"
					value={selected}
					onChange={(e) => setSelected(e.target.value)}
					aria-label="Target ticket to reattach this theme to"
				>
					<option value="">Select a ticket…</option>
					{targets.map((s) => (
						<option key={s.id} value={s.id}>
							{s.identifier} — {s.title.slice(0, 60)}
						</option>
					))}
				</select>
			</label>
			<Button
				size="sm"
				variant="outline"
				className="gap-1.5"
				disabled={!selected || pending}
				onClick={() => onReattach(selected)}
			>
				{pending ? (
					<Loader2Icon
						aria-hidden="true"
						className="size-3.5 motion-safe:animate-spin"
					/>
				) : null}
				Reattach
			</Button>
		</div>
	);
}

function EmptyResults() {
	return (
		<div className="rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
			<p className="text-muted-foreground text-sm">
				No open findings to group this run.
			</p>
		</div>
	);
}
