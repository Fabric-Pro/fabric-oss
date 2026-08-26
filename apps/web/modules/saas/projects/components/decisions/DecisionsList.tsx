"use client";

import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Popover, PopoverAnchor, PopoverContent } from "@ui/components/popover";
import { SearchInput } from "@ui/components/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ArrowRightLeftIcon,
	BadgeCheckIcon,
	ChevronDownIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	DownloadIcon,
	InfoIcon,
	LandmarkIcon,
	LayoutListIcon,
	LinkIcon,
	MessageSquareIcon,
	MessageSquareQuoteIcon,
	PinIcon,
	PlusIcon,
	Rows3Icon,
	SearchIcon,
	SlidersHorizontalIcon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	DECISION_DOMAINS,
	DECISION_STATUSES,
	type DecisionDuration,
	type DecisionStatus,
	DOMAIN_CONFIG,
	formatDecisionDate,
	STATUS_CONFIG,
} from "./constants";
import {
	type AvatarPerson,
	AvatarStack,
	DecisionDateTime,
	DecisionTagPills,
	DomainTag,
} from "./DecisionAtoms";
import { DecisionDetailSheet } from "./DecisionDetailSheet";
import {
	DecisionFormDialog,
	type EditableDecision,
} from "./DecisionFormDialog";
import { DecisionOverridesStrip } from "./DecisionOverridesStrip";
import { DecisionStatusSelect } from "./DecisionStatusSelect";
import { DecisionsTable } from "./DecisionsTable";
import { decisionsToMarkdown, downloadMarkdown } from "./decisionMarkdown";
import {
	buildRelationshipIndex,
	type DecisionLite,
	primaryRelationship,
	type RelationshipIndex,
	type RelationshipKind,
} from "./relationships";
import { useDecisionsView } from "./useDecisionsView";

type Props = {
	projectId: string;
	canEdit?: boolean;
	canDelete?: boolean;
};

type DecisionListItem = DecisionLite & {
	rationale: string;
	domain: string | null;
	decisionDate: string | Date;
	updatedAt: string | Date;
	sourceKind: string | null;
	participants: AvatarPerson[];
	participantNames: string[];
	participantsText: string | null;
	pinnedAt: string | Date | null;
	vouchedAt: string | Date | null;
	_count: { comments: number };
	decisionTypeId: string | null;
	decisionType: { id: string; name: string } | null;
	ownerUserId: string | null;
	duration: DecisionDuration | null;
	priorityFlagged: boolean;
};

type SortKey = "newest" | "oldest" | "updated" | "status";

const ALL = "ALL";

const SORT_OPTIONS: { id: SortKey; label: string }[] = [
	{ id: "newest", label: "Newest first" },
	{ id: "oldest", label: "Oldest first" },
	{ id: "updated", label: "Recently updated" },
	{ id: "status", label: "By status" },
];

/** Short "how the AI treats this status" line for the info popover. */
const STATUS_AI_USE: Record<DecisionStatus, string> = {
	PROPOSED: "AI weighs it, but doesn't treat it as binding.",
	ACCEPTED: "AI follows it as a binding constraint.",
	DEPRECATED: "AI avoids it for new work.",
	SUPERSEDED: "AI follows the newer decision instead.",
	REJECTED: "AI never re-proposes it.",
};

const REL_ICON: Record<RelationshipKind, typeof LinkIcon> = {
	Supersedes: ArrowRightLeftIcon,
	"Superseded by": ArrowRightLeftIcon,
	Related: LinkIcon,
};

type HoverTriggerHandlers = {
	onClick: () => void;
	onPointerEnter: () => void;
	onPointerLeave: () => void;
	onFocus: () => void;
	onBlur: () => void;
	"aria-expanded": boolean;
	"aria-haspopup": "dialog";
};

/**
 * Popover that previews on hover and pins open on click: hovering the trigger
 * (or its content) opens it and moving away closes it — unless it was clicked,
 * which keeps it open until dismissed (click again, click outside, or Escape).
 */
function HoverPinPopover({
	align = "start",
	contentClassName,
	trigger,
	children,
}: {
	align?: "start" | "center" | "end";
	contentClassName?: string;
	trigger: (handlers: HoverTriggerHandlers) => ReactNode;
	children: ReactNode;
}) {
	const [pinned, setPinned] = useState(false);
	const [hovered, setHovered] = useState(false);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (closeTimer.current) {
				clearTimeout(closeTimer.current);
			}
		},
		[],
	);

	const open = pinned || hovered;
	const enter = () => {
		if (closeTimer.current) {
			clearTimeout(closeTimer.current);
		}
		setHovered(true);
	};
	const leave = () => {
		closeTimer.current = setTimeout(() => setHovered(false), 140);
	};

	return (
		<Popover
			open={open}
			onOpenChange={(o) => {
				if (!o) {
					setPinned(false);
					setHovered(false);
				}
			}}
		>
			<PopoverAnchor asChild>
				{trigger({
					onClick: () => setPinned((p) => !p),
					onPointerEnter: enter,
					onPointerLeave: leave,
					onFocus: enter,
					onBlur: leave,
					"aria-expanded": open,
					"aria-haspopup": "dialog",
				})}
			</PopoverAnchor>
			<PopoverContent
				align={align}
				className={contentClassName}
				onOpenAutoFocus={(e) => e.preventDefault()}
				onPointerEnter={enter}
				onPointerLeave={leave}
			>
				{children}
			</PopoverContent>
		</Popover>
	);
}

/** Shared legend (markers, statuses, domains) shown in the "Legend" popover. */
function DecisionLegend() {
	return (
		<div className="grid gap-5 sm:grid-cols-3 sm:divide-x">
			<div className="sm:pr-4">
				<p className="app-editorial-label mb-2">Markers</p>
				<ul className="space-y-1.5 text-xs">
					<li className="flex items-start gap-2">
						<SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
						<span className="text-muted-foreground">
							<span className="font-medium text-foreground">
								From meeting
							</span>{" "}
							— extracted from a meeting transcript.
						</span>
					</li>
					<li className="flex items-start gap-2">
						<BadgeCheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
						<span className="text-muted-foreground">
							<span className="font-medium text-foreground">
								Endorsed
							</span>{" "}
							— a teammate vouched for it.
						</span>
					</li>
					<li className="flex items-start gap-2">
						<PinIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
						<span className="text-muted-foreground">
							<span className="font-medium text-foreground">
								Pinned
							</span>{" "}
							— kept at the top of the list.
						</span>
					</li>
					<li className="flex items-start gap-2">
						<LinkIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
						<span className="text-muted-foreground">
							<span className="font-medium text-foreground">
								Linked
							</span>{" "}
							— relates to or supersedes another decision.
						</span>
					</li>
				</ul>
			</div>
			<div className="sm:px-4">
				<p className="app-editorial-label mb-2">
					Statuses & how the AI uses them
				</p>
				<ul className="space-y-2">
					{DECISION_STATUSES.map((s) => (
						<li key={s}>
							<span className="flex items-center gap-1.5">
								<span
									className={cn(
										"size-1.5 shrink-0 rounded-full",
										STATUS_CONFIG[s].dotClassName,
									)}
								/>
								<span className="font-medium text-foreground text-xs">
									{STATUS_CONFIG[s].label}
								</span>
							</span>
							<span className="mt-0.5 block pl-3 text-muted-foreground text-xs leading-snug">
								{STATUS_CONFIG[s].description}{" "}
								<span className="text-foreground/70">
									{STATUS_AI_USE[s]}
								</span>
							</span>
						</li>
					))}
				</ul>
			</div>
			<div className="sm:pl-4">
				<p className="app-editorial-label mb-2">Domains supported</p>
				<ul className="space-y-2">
					{DECISION_DOMAINS.map((d) => (
						<li key={d}>
							<span className="flex items-center gap-1.5">
								<span
									className={cn(
										"size-1.5 shrink-0 rounded-full",
										DOMAIN_CONFIG[d].dotClassName,
									)}
								/>
								<span className="font-medium text-foreground text-xs">
									{DOMAIN_CONFIG[d].label}
								</span>
							</span>
							<span className="mt-0.5 block pl-3 text-muted-foreground text-xs leading-snug">
								{DOMAIN_CONFIG[d].description}
							</span>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

export function DecisionsList({
	projectId,
	canEdit = false,
	canDelete = false,
}: Props) {
	const { organizationId } = useOrganizationContext();
	const { mode, setMode } = useDecisionsView(projectId, organizationId);

	const [searchInput, setSearchInput] = useState("");
	const [search, setSearch] = useState("");
	const [statusTab, setStatusTab] = useState<DecisionStatus | typeof ALL>(
		ALL,
	);
	const [domain, setDomain] = useState<string>(ALL);
	const [sort, setSort] = useState<SortKey>("newest");
	const [participantUserId, setParticipantUserId] = useState<string>(ALL);
	const [dateFrom, setDateFrom] = useState("");
	const [dateTo, setDateTo] = useState("");
	const [filtersOpen, setFiltersOpen] = useState(false);

	const [formOpen, setFormOpen] = useState(false);
	const [editing, setEditing] = useState<EditableDecision | null>(null);
	const [detailId, setDetailId] = useState<string | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);

	useEffect(() => {
		const t = setTimeout(() => setSearch(searchInput.trim()), 300);
		return () => clearTimeout(t);
	}, [searchInput]);

	const listQuery = useQuery(
		orpc.projects.architectureDecisions.list.queryOptions({
			input: {
				projectId,
				organizationId: organizationId ?? null,
				search: search || undefined,
				participantUserId:
					participantUserId === ALL ? undefined : participantUserId,
				dateFrom: dateFrom || undefined,
				dateTo: dateTo || undefined,
			},
		}),
	);
	const items = (listQuery.data?.items ?? []) as DecisionListItem[];

	const membersQuery = useQuery(
		orpc.projects.members.list.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const members = membersQuery.data?.members ?? [];

	const candidatesQuery = useQuery(
		orpc.projects.architectureDecisions.meetingDecisions.list.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const candidates = (candidatesQuery.data?.candidates ?? []).filter(
		(c) => !(c.alreadyConverted || c.dismissed),
	);

	const supersedeOptions = useMemo(
		() =>
			items.map((i) => ({
				id: i.id,
				identifier: i.identifier,
				title: i.title,
			})),
		[items],
	);

	const relationshipIndex: RelationshipIndex = useMemo(
		() => buildRelationshipIndex(items),
		[items],
	);

	const counts = useMemo(() => {
		const c: Partial<Record<DecisionStatus, number>> = {};
		for (const it of items) {
			c[it.status] = (c[it.status] ?? 0) + 1;
		}
		return c;
	}, [items]);

	const filtered = useMemo(() => {
		const list = items.filter(
			(it) =>
				(statusTab === ALL || it.status === statusTab) &&
				(domain === ALL || it.domain === domain),
		);
		const byDate = (v: string | Date) => new Date(v).getTime();
		const bySort = (a: DecisionListItem, b: DecisionListItem) => {
			if (sort === "oldest") {
				return byDate(a.decisionDate) - byDate(b.decisionDate);
			}
			if (sort === "updated") {
				return byDate(b.updatedAt) - byDate(a.updatedAt);
			}
			if (sort === "status") {
				return (
					DECISION_STATUSES.indexOf(a.status) -
					DECISION_STATUSES.indexOf(b.status)
				);
			}
			return byDate(b.decisionDate) - byDate(a.decisionDate);
		};
		return list.sort((a, b) => {
			// Pinned decisions always float to the top.
			const aPinned = a.pinnedAt ? 1 : 0;
			const bPinned = b.pinnedAt ? 1 : 0;
			if (aPinned !== bPinned) {
				return bPinned - aPinned;
			}
			return bySort(a, b);
		});
	}, [items, statusTab, domain, sort]);

	const createFromMutation = useMutation(
		orpc.projects.architectureDecisions.meetingDecisions.createFrom.mutationOptions(
			{
				onSuccess: (data) => {
					toast.success("Draft decision created from meeting");
					listQuery.refetch();
					candidatesQuery.refetch();
					setDetailId(data.decision.id);
					setDetailOpen(true);
				},
				onError: (e) => toast.error(`Failed to create: ${e.message}`),
			},
		),
	);

	const dismissMutation = useMutation(
		orpc.projects.architectureDecisions.meetingDecisions.dismiss.mutationOptions(
			{
				onSuccess: () => {
					toast.success("Suggestion dismissed");
					candidatesQuery.refetch();
				},
				onError: (e) => toast.error(`Failed to dismiss: ${e.message}`),
			},
		),
	);

	const activeFilterCount =
		(domain !== ALL ? 1 : 0) +
		(participantUserId !== ALL ? 1 : 0) +
		(dateFrom ? 1 : 0) +
		(dateTo ? 1 : 0);
	const hasAnyFilter =
		Boolean(search) || statusTab !== ALL || activeFilterCount > 0;

	const isLoading = listQuery.isLoading;
	const showEmpty = !isLoading && items.length === 0;

	const exportAll = () => {
		if (items.length === 0) {
			return;
		}
		const md = decisionsToMarkdown(
			items.map((i) => ({
				identifier: i.identifier,
				title: i.title,
				status: i.status,
				domain: i.domain,
				decisionDate: i.decisionDate,
				rationale: i.rationale,
				participantNames: i.participantNames,
				participantsText: i.participantsText,
				vouchedAt: i.vouchedAt,
			})),
		);
		downloadMarkdown("architecture-decisions.md", md);
	};

	return (
		// min-height keeps the panel from collapsing when a filter narrows the
		// list, so clicking a status tab doesn't jump the page scroll.
		<div className="min-h-[75vh] space-y-5">
			{/* Header */}
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<div className="flex items-center gap-1.5">
						<h2
							data-onboarding-target="decisions-header"
							className="font-serif text-3xl font-normal"
						>
							Decisions
						</h2>
						<HoverPinPopover
							align="start"
							contentClassName="w-[min(92vw,30rem)] text-sm"
							trigger={(h) => (
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-6 rounded-full text-muted-foreground hover:text-foreground"
									aria-label="About the Architecture Decision Log"
									{...h}
								>
									<InfoIcon className="size-4" />
								</Button>
							)}
						>
							<p className="font-medium">
								Architecture Decision Log
							</p>
							<p className="mt-1.5 text-muted-foreground">
								A durable record of the architectural choices
								your team makes — the context, what was decided,
								why, and the alternatives considered. Each entry
								has a status, full version history you can
								revert to, and a discussion thread.
							</p>
							<p className="mt-2 text-muted-foreground">
								Decisions become AI-aware context, so Fabric
								considers them when generating specs, plans, and
								analyses — and won't re-suggest something you've
								already ruled out.
							</p>
							<p className="mt-2 text-muted-foreground">
								<span className="font-medium text-foreground">
									Where suggestions come from:
								</span>{" "}
								link Teams meetings to this project under{" "}
								<span className="font-medium text-foreground">
									Settings → Meeting Transcript Sync
								</span>
								. Fabric syncs their transcripts on the schedule
								you pick there (hourly up to daily, or “Sync
								now”), detects the decisions discussed, and
								lists them in the “detected in recent meetings”
								strip above to review — nothing is saved until
								you accept.
							</p>
						</HoverPinPopover>
						<PageTourButton pageId="decisions" />
					</div>
					<p className="mt-1 max-w-xl text-muted-foreground text-sm">
						A searchable, AI-aware record of the architectural
						choices your team has made — the context, the rationale,
						and who decided.
					</p>
				</div>
				<div className="flex items-center gap-2">
					{items.length > 0 && (
						<Button
							variant="outline"
							onClick={exportAll}
							title="Export the log as Markdown"
						>
							<DownloadIcon className="mr-2 size-4" />
							Export
						</Button>
					)}
					{canEdit && (
						<Button
							data-onboarding-target="decisions-new"
							onClick={() => setFormOpen(true)}
						>
							<PlusIcon className="mr-2 size-4" />
							New decision
						</Button>
					)}
				</div>
			</div>

			{/* Meeting-extracted candidates (compact, collapsible) */}
			<MeetingCandidatesStrip
				candidates={candidates}
				canEdit={canEdit}
				projectId={projectId}
				organizationId={organizationId}
				creating={createFromMutation.isPending}
				onCreate={(c) =>
					createFromMutation.mutate({
						projectId,
						organizationId,
						transcriptId: c.transcriptId,
						decisionIndex: c.decisionIndex,
					})
				}
				dismissing={dismissMutation.isPending}
				onDismiss={(c) =>
					dismissMutation.mutate({
						projectId,
						organizationId,
						transcriptId: c.transcriptId,
						decisionIndex: c.decisionIndex,
					})
				}
				onOpenDecision={(id) => {
					setDetailId(id);
					setDetailOpen(true);
				}}
			/>

			{/* Read-only log of AI output accepted despite a flagged decision
			    conflict. Admin-only (the override ledger is a governance surface),
			    and the strip renders nothing until an override actually exists. */}
			{canDelete && (
				<DecisionOverridesStrip
					projectId={projectId}
					organizationId={organizationId}
				/>
			)}

			{!showEmpty && (
				<>
					{/* Status filter tabs */}
					<div data-onboarding-target="decisions-status-tabs">
						<StatusTabs
							counts={counts}
							total={items.length}
							value={statusTab}
							onChange={setStatusTab}
						/>
					</div>

					{/* Toolbar: search + sort + view toggle + filters */}
					<div className="flex flex-wrap items-center gap-2">
						<div className="relative w-full sm:max-w-xs">
							<SearchIcon className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
							<SearchInput
								value={searchInput}
								onChange={(e) => setSearchInput(e.target.value)}
								placeholder="Search decisions…"
								className="h-9 pl-9"
								aria-label="Search decisions"
							/>
						</div>
						<div className="ml-auto flex items-center gap-2">
							<Select
								value={sort}
								onValueChange={(v) => setSort(v as SortKey)}
							>
								<SelectTrigger
									className="h-9 w-[170px]"
									aria-label="Sort decisions"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{SORT_OPTIONS.map((o) => (
										<SelectItem key={o.id} value={o.id}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Tooltip>
								<TooltipTrigger asChild>
									<div className="inline-flex items-center rounded-md border p-0.5">
										<button
											type="button"
											onClick={() => setMode("list")}
											aria-label="List view (cards)"
											aria-pressed={mode === "list"}
											className={cn(
												"inline-flex size-7 items-center justify-center rounded transition-colors",
												mode === "list"
													? "bg-accent text-foreground"
													: "text-muted-foreground hover:text-foreground",
											)}
										>
											<LayoutListIcon className="size-4" />
										</button>
										<button
											type="button"
											onClick={() => setMode("table")}
											aria-label="Table view"
											aria-pressed={mode === "table"}
											className={cn(
												"inline-flex size-7 items-center justify-center rounded transition-colors",
												mode === "table"
													? "bg-accent text-foreground"
													: "text-muted-foreground hover:text-foreground",
											)}
										>
											<Rows3Icon className="size-4" />
										</button>
									</div>
								</TooltipTrigger>
								<TooltipContent
									surface="popover"
									className="max-w-60"
								>
									Cards or table is your personal view — it's
									saved to your account and only changes the
									layout for you, never for your teammates.
								</TooltipContent>
							</Tooltip>
							<Button
								variant="outline"
								size="sm"
								className="h-9 gap-1.5"
								onClick={() => setFiltersOpen((v) => !v)}
								aria-expanded={filtersOpen}
								aria-controls="decision-filters-panel"
							>
								<SlidersHorizontalIcon className="size-4" />
								Filters
								{activeFilterCount > 0 && (
									<span className="ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-primary text-xs">
										{activeFilterCount}
									</span>
								)}
								<ChevronDownIcon
									className={cn(
										"size-3.5 text-muted-foreground transition-transform",
										filtersOpen && "rotate-180",
									)}
								/>
							</Button>
						</div>
					</div>

					{/* Filters: inline expandable row (replaces the popover) */}
					{filtersOpen && (
						<div
							id="decision-filters-panel"
							className="rounded-lg border bg-muted/30 p-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
						>
							<div className="flex flex-wrap items-end gap-4">
								<div className="w-full space-y-1.5 sm:w-auto sm:min-w-[12rem] sm:max-w-[16rem] sm:flex-1">
									<p className="app-editorial-label">
										Domain
									</p>
									<Select
										value={domain}
										onValueChange={setDomain}
									>
										<SelectTrigger className="h-9 w-full">
											<SelectValue placeholder="All domains" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={ALL}>
												All domains
											</SelectItem>
											{DECISION_DOMAINS.map((d) => (
												<SelectItem key={d} value={d}>
													{DOMAIN_CONFIG[d].label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
								<div className="w-full space-y-1.5 sm:w-auto sm:min-w-[12rem] sm:max-w-[16rem] sm:flex-1">
									<p className="app-editorial-label">
										Participant
									</p>
									<Select
										value={participantUserId}
										onValueChange={setParticipantUserId}
									>
										<SelectTrigger className="h-9 w-full">
											<SelectValue placeholder="Anyone" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={ALL}>
												Anyone
											</SelectItem>
											{members.map((m) => (
												<SelectItem
													key={m.userId}
													value={m.userId}
												>
													{m.user.name ||
														m.user.email}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
								<div className="w-full space-y-1.5 sm:w-auto">
									<p className="app-editorial-label">
										Decision date
									</p>
									<div className="flex items-center gap-2">
										<Input
											type="date"
											value={dateFrom}
											onChange={(e) =>
												setDateFrom(e.target.value)
											}
											className="h-9"
											aria-label="From date"
										/>
										<span className="text-muted-foreground text-xs">
											to
										</span>
										<Input
											type="date"
											value={dateTo}
											onChange={(e) =>
												setDateTo(e.target.value)
											}
											className="h-9"
											aria-label="To date"
										/>
									</div>
								</div>
								<div className="ml-auto flex items-center gap-2 self-end">
									{activeFilterCount > 0 && (
										<Button
											variant="ghost"
											size="sm"
											onClick={() => {
												setDomain(ALL);
												setParticipantUserId(ALL);
												setDateFrom("");
												setDateTo("");
											}}
										>
											Clear filters
										</Button>
									)}
									<Button
										variant="ghost"
										size="icon"
										className="size-8 shrink-0"
										onClick={() => setFiltersOpen(false)}
										aria-label="Close filters"
									>
										<XIcon className="size-4" />
									</Button>
								</div>
							</div>
						</div>
					)}

					{/* Count + legend */}
					<div className="flex items-center gap-3">
						{!isLoading && (
							<p className="text-muted-foreground text-sm">
								<strong className="text-foreground">
									{filtered.length}
								</strong>{" "}
								{filtered.length === 1
									? "decision"
									: "decisions"}
							</p>
						)}
						<HoverPinPopover
							align="start"
							contentClassName="max-h-[80vh] w-[min(94vw,52rem)] overflow-y-auto text-sm"
							trigger={(h) => (
								<button
									type="button"
									className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 font-medium text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
									{...h}
								>
									<InfoIcon className="size-3" />
									Legend
								</button>
							)}
						>
							<DecisionLegend />
						</HoverPinPopover>
					</div>
				</>
			)}

			{/* List */}
			{isLoading ? (
				<div className="space-y-3">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-28 w-full rounded-lg" />
					))}
				</div>
			) : showEmpty ? (
				<div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center">
					<LandmarkIcon className="size-8 text-muted-foreground/60" />
					<h3 className="font-serif text-xl font-normal">
						No decisions yet
					</h3>
					<p className="max-w-sm text-muted-foreground text-sm">
						Record your first architectural decision so the
						reasoning is never lost.
					</p>
					{canEdit && (
						<Button
							onClick={() => setFormOpen(true)}
							className="mt-1"
						>
							<PlusIcon className="mr-2 size-4" />
							New decision
						</Button>
					)}
				</div>
			) : filtered.length === 0 ? (
				<div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-14 text-center">
					<SearchIcon className="size-6 text-muted-foreground/60" />
					<p className="text-muted-foreground text-sm">
						No decisions match your filters.
					</p>
					{hasAnyFilter && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setSearchInput("");
								setStatusTab(ALL);
								setDomain(ALL);
								setParticipantUserId(ALL);
								setDateFrom("");
								setDateTo("");
							}}
						>
							Clear all
						</Button>
					)}
				</div>
			) : mode === "table" ? (
				<DecisionsTable
					items={filtered}
					index={relationshipIndex}
					projectId={projectId}
					organizationId={organizationId}
					canEdit={canEdit}
					onOpen={(id) => {
						setDetailId(id);
						setDetailOpen(true);
					}}
					onChanged={() => listQuery.refetch()}
				/>
			) : (
				<div className="space-y-3">
					{filtered.map((item) => (
						<DecisionRow
							key={item.id}
							item={item}
							index={relationshipIndex}
							projectId={projectId}
							organizationId={organizationId}
							canEdit={canEdit}
							onOpen={(id) => {
								setDetailId(id);
								setDetailOpen(true);
							}}
							onChanged={() => listQuery.refetch()}
						/>
					))}
				</div>
			)}

			<DecisionFormDialog
				projectId={projectId}
				open={formOpen}
				onOpenChange={(o) => {
					setFormOpen(o);
					if (!o) {
						setEditing(null);
					}
				}}
				decision={editing}
				supersedeOptions={supersedeOptions}
				onSaved={() => {
					listQuery.refetch();
				}}
			/>

			<DecisionDetailSheet
				projectId={projectId}
				decisionId={detailId}
				open={detailOpen}
				onOpenChange={setDetailOpen}
				canEdit={canEdit}
				canDelete={canDelete}
				relationshipIndex={relationshipIndex}
				onOpenDecision={(id) => {
					setDetailId(id);
					setDetailOpen(true);
				}}
				onEdit={(d) => {
					setEditing(d);
					setFormOpen(true);
				}}
				onChanged={() => {
					listQuery.refetch();
				}}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Status filter tabs
// ---------------------------------------------------------------------------

function StatusTabs({
	counts,
	total,
	value,
	onChange,
}: {
	counts: Partial<Record<DecisionStatus, number>>;
	total: number;
	value: DecisionStatus | typeof ALL;
	onChange: (v: DecisionStatus | typeof ALL) => void;
}) {
	const tabClass = (active: boolean) =>
		cn(
			"inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
			active
				? "border-primary/40 bg-primary/10 text-foreground"
				: "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
		);
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<button
				type="button"
				onClick={() => onChange(ALL)}
				className={tabClass(value === ALL)}
			>
				All
				<span className="text-muted-foreground/80 text-xs">
					{total}
				</span>
			</button>
			{DECISION_STATUSES.map((s) => (
				<button
					key={s}
					type="button"
					onClick={() => onChange(s)}
					className={tabClass(value === s)}
				>
					<span
						className={cn(
							"size-1.5 rounded-full",
							STATUS_CONFIG[s].dotClassName,
						)}
					/>
					{STATUS_CONFIG[s].label}
					<span className="text-muted-foreground/80 text-xs">
						{counts[s] ?? 0}
					</span>
				</button>
			))}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Meeting candidates strip
// ---------------------------------------------------------------------------

type Candidate = {
	transcriptId: string;
	decisionIndex: number;
	text: string;
	meetingSubject: string | null;
	meetingDate: string | Date | null;
	matchedDecision?: { id: string; identifier: string; title: string };
};

const CANDIDATE_PAGE_SIZE = 10;

// Page numbers to render for the candidate pager: first, last, and a ±1 window
// around the current page, with "ellipsis" markers filling any gaps. Values are
// 0-indexed page numbers; the UI renders each as `n + 1`.
function getCandidatePageList(
	current: number,
	total: number,
): Array<number | "ellipsis"> {
	if (total <= 7) {
		return Array.from({ length: total }, (_, i) => i);
	}
	const wanted = new Set<number>([
		0,
		total - 1,
		current,
		current - 1,
		current + 1,
	]);
	const shown = [...wanted]
		.filter((p) => p >= 0 && p < total)
		.sort((a, b) => a - b);
	const out: Array<number | "ellipsis"> = [];
	let prev = -1;
	for (const p of shown) {
		if (prev >= 0 && p - prev > 1) {
			out.push("ellipsis");
		}
		out.push(p);
		prev = p;
	}
	return out;
}

// Review a single AI-detected candidate before anything is written. Closing the
// dialog is a no-op; the user explicitly accepts (create), rejects (dismiss), or
// — for a candidate that matches an existing decision — opens it to apply the
// change, with a side-by-side of the current decision vs. the proposed text.
function MeetingCandidatePreviewDialog({
	candidate,
	projectId,
	organizationId,
	creating,
	dismissing,
	onClose,
	onCreate,
	onDismiss,
	onOpenDecision,
}: {
	candidate: Candidate | null;
	projectId: string;
	organizationId?: string | null;
	creating: boolean;
	dismissing: boolean;
	onClose: () => void;
	onCreate: (c: Candidate) => void;
	onDismiss: (c: Candidate) => void;
	onOpenDecision: (id: string) => void;
}) {
	const matched = candidate?.matchedDecision;
	const isUpdate = Boolean(matched);

	// Load the full existing decision only for an update, so the comparison can
	// show its real statement instead of just the matched title.
	const existingQuery = useQuery({
		...orpc.projects.architectureDecisions.get.queryOptions({
			input: {
				projectId,
				id: matched?.id ?? "",
				organizationId: organizationId ?? null,
			},
		}),
		enabled: Boolean(candidate) && Boolean(matched?.id),
	});
	const existing = existingQuery.data?.decision;

	const meetingSource = candidate
		? `${candidate.meetingSubject ?? "a meeting"}${
				candidate.meetingDate
					? ` · ${formatDecisionDate(candidate.meetingDate)}`
					: ""
			}`
		: "";

	return (
		<Dialog
			open={Boolean(candidate)}
			onOpenChange={(o) => {
				if (!o) {
					onClose();
				}
			}}
		>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<div className="flex items-center gap-2">
						<span
							className={cn(
								"inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium text-[11px]",
								isUpdate
									? "border-highlight/40 bg-highlight/10 text-highlight"
									: "border-primary/30 bg-primary/5 text-primary",
							)}
						>
							<SparklesIcon className="size-3" />
							{isUpdate
								? `Updates ${matched?.identifier}`
								: "New decision"}
						</span>
					</div>
					<DialogTitle>
						{isUpdate
							? "Review proposed update"
							: "Review proposed decision"}
					</DialogTitle>
					<DialogDescription>
						Detected in {meetingSource}.{" "}
						{isUpdate
							? `Nothing changes until you open ${matched?.identifier} and apply it.`
							: "Nothing is created until you accept."}
					</DialogDescription>
				</DialogHeader>

				{isUpdate ? (
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="rounded-md border bg-muted/40 p-3">
							<p className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
								Current · {matched?.identifier}
							</p>
							{existingQuery.isLoading ? (
								<p className="text-muted-foreground text-sm">
									Loading current decision…
								</p>
							) : existing ? (
								<>
									<p className="font-medium text-sm">
										{existing.title}
									</p>
									{existing.decision ? (
										<p className="mt-1 whitespace-pre-wrap text-muted-foreground text-sm">
											{existing.decision}
										</p>
									) : null}
								</>
							) : (
								<p className="text-sm">{matched?.title}</p>
							)}
						</div>
						<div className="rounded-md border border-primary/30 bg-primary/[0.03] p-3">
							<p className="mb-1.5 font-medium text-[11px] text-primary uppercase tracking-[0.14em]">
								Proposed · from this meeting
							</p>
							<p className="whitespace-pre-wrap text-sm">
								{candidate?.text}
							</p>
						</div>
					</div>
				) : (
					<div className="rounded-md border bg-card p-3">
						<p className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
							Proposed decision
						</p>
						<p className="whitespace-pre-wrap text-sm">
							{candidate?.text}
						</p>
					</div>
				)}

				<DialogFooter className="gap-2 sm:items-center sm:justify-between">
					<Button
						variant="ghost"
						className="text-muted-foreground hover:text-destructive"
						disabled={dismissing}
						onClick={() => {
							if (candidate) {
								onDismiss(candidate);
							}
						}}
					>
						Reject suggestion
					</Button>
					<div className="flex gap-2">
						<Button variant="outline" onClick={onClose}>
							Cancel
						</Button>
						{isUpdate ? (
							<Button
								onClick={() => {
									if (matched) {
										onOpenDecision(matched.id);
									}
								}}
							>
								Open {matched?.identifier} to apply
							</Button>
						) : (
							<Button
								disabled={creating}
								onClick={() => {
									if (candidate) {
										onCreate(candidate);
									}
								}}
							>
								Create decision
							</Button>
						)}
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function MeetingCandidatesStrip({
	candidates,
	canEdit,
	projectId,
	organizationId,
	creating,
	dismissing,
	onCreate,
	onDismiss,
	onOpenDecision,
}: {
	candidates: Candidate[];
	canEdit: boolean;
	projectId: string;
	organizationId?: string | null;
	creating: boolean;
	dismissing: boolean;
	onCreate: (c: Candidate) => void;
	onDismiss: (c: Candidate) => void;
	onOpenDecision: (id: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [page, setPage] = useState(0);
	const [preview, setPreview] = useState<Candidate | null>(null);
	if (candidates.length === 0) {
		return null;
	}
	const pageCount = Math.max(
		1,
		Math.ceil(candidates.length / CANDIDATE_PAGE_SIZE),
	);
	// `page` can briefly point past the end after a create/dismiss shrinks the
	// list; clamp for rendering and let the next Prev/Next click self-correct.
	const safePage = Math.min(page, pageCount - 1);
	const visible = candidates.slice(
		safePage * CANDIDATE_PAGE_SIZE,
		safePage * CANDIDATE_PAGE_SIZE + CANDIDATE_PAGE_SIZE,
	);
	return (
		<div
			className="overflow-hidden rounded-lg border border-primary/20 bg-primary/[0.03]"
			data-onboarding-target="decisions-meeting-candidates"
		>
			<MeetingCandidatePreviewDialog
				candidate={preview}
				projectId={projectId}
				organizationId={organizationId}
				creating={creating}
				dismissing={dismissing}
				onClose={() => setPreview(null)}
				onCreate={(c) => {
					setPreview(null);
					onCreate(c);
				}}
				onDismiss={(c) => {
					setPreview(null);
					onDismiss(c);
				}}
				onOpenDecision={(id) => {
					setPreview(null);
					onOpenDecision(id);
				}}
			/>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
				aria-expanded={open}
			>
				<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
					<SparklesIcon className="size-4" />
				</span>
				<span className="flex-1 text-sm">
					<strong className="font-semibold">
						{candidates.length} decision
						{candidates.length === 1 ? "" : "s"}
					</strong>{" "}
					<span className="text-muted-foreground">
						detected in recent meetings
					</span>
				</span>
				<span className="hidden text-muted-foreground text-xs md:inline">
					Turn transcripts into tracked records
				</span>
				<span className="inline-flex items-center gap-1 font-medium text-primary text-sm">
					{open ? "Hide" : "Review"}
					<ChevronDownIcon
						className={cn(
							"size-4 transition-transform",
							open && "rotate-180",
						)}
					/>
				</span>
			</button>
			{open && (
				<ul className="space-y-2 border-primary/10 border-t p-3">
					{visible.map((c) => {
						const matched = c.matchedDecision;
						return (
							<li
								key={`${c.transcriptId}:${c.decisionIndex}`}
								className="flex items-start gap-3 rounded-md border bg-card p-3"
							>
								<MessageSquareQuoteIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<p className="text-sm">{c.text}</p>
									<p className="mt-0.5 text-muted-foreground text-xs">
										{c.meetingSubject ?? "Meeting"}
										{c.meetingDate
											? ` · ${formatDecisionDate(c.meetingDate)}`
											: ""}
										{matched && (
											<>
												{" · "}
												<span className="font-medium text-highlight">
													May update{" "}
													{matched.identifier}
												</span>
											</>
										)}
									</p>
								</div>
								{canEdit && (
									<div className="flex shrink-0 items-center gap-1">
										<Button
											size="sm"
											variant="outline"
											onClick={() => setPreview(c)}
										>
											Review
										</Button>
										<Button
											size="icon"
											variant="ghost"
											className="size-8 text-muted-foreground hover:text-foreground"
											disabled={dismissing}
											title="Dismiss — don't suggest this again"
											aria-label="Dismiss suggestion"
											onClick={() => onDismiss(c)}
										>
											<XIcon className="size-4" />
										</Button>
									</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{open && pageCount > 1 && (
				<nav
					aria-label="Meeting decision pages"
					className="flex flex-wrap items-center justify-center gap-1 border-primary/10 border-t px-3 py-2"
				>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="gap-1 px-2 text-muted-foreground"
						disabled={safePage === 0}
						onClick={() => setPage(safePage - 1)}
						aria-label="Previous page"
					>
						<ChevronLeftIcon className="size-4" />
						Prev
					</Button>
					{getCandidatePageList(safePage, pageCount).map((p, i) =>
						p === "ellipsis" ? (
							<span
								key={`gap-${i}`}
								className="px-1 text-muted-foreground text-xs"
								aria-hidden
							>
								…
							</span>
						) : (
							<Button
								key={p}
								type="button"
								size="sm"
								variant="ghost"
								className={cn(
									"size-8 px-0 text-xs",
									p === safePage &&
										"bg-primary/10 font-semibold text-primary",
								)}
								aria-label={`Page ${p + 1}`}
								aria-current={
									p === safePage ? "page" : undefined
								}
								onClick={() => setPage(p)}
							>
								{p + 1}
							</Button>
						),
					)}
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="gap-1 px-2 text-muted-foreground"
						disabled={safePage === pageCount - 1}
						onClick={() => setPage(safePage + 1)}
						aria-label="Next page"
					>
						Next
						<ChevronRightIcon className="size-4" />
					</Button>
				</nav>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Decision row
// ---------------------------------------------------------------------------

function DecisionRow({
	item,
	index,
	projectId,
	organizationId,
	canEdit,
	onOpen,
	onChanged,
}: {
	item: DecisionListItem;
	index: RelationshipIndex;
	projectId: string;
	organizationId?: string | null;
	canEdit: boolean;
	onOpen: (id: string) => void;
	onChanged: () => void;
}) {
	const tTooltips = useTranslations("tooltips.decisions");
	const rel = primaryRelationship(item, index);
	const RelIcon = rel ? REL_ICON[rel.kind] : null;
	const people = item.participants;
	const fromMeeting = item.sourceKind === "meeting_decision";
	const pinned = Boolean(item.pinnedAt);

	const pinMutation = useMutation(
		orpc.projects.architectureDecisions.pin.mutationOptions({
			onSuccess: onChanged,
			onError: (e) => toast.error(`Failed to pin: ${e.message}`),
		}),
	);

	return (
		<article
			className={cn(
				"group relative flex items-start gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/30",
				pinned && "border-primary/30 bg-primary/[0.03]",
			)}
		>
			<div className="min-w-0 flex-1 space-y-2">
				{/* top row */}
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-mono text-muted-foreground text-xs">
						{item.identifier}
					</span>
					<span className="relative z-10">
						<DecisionStatusSelect
							projectId={projectId}
							decisionId={item.id}
							value={item.status}
							canEdit={canEdit}
							organizationId={organizationId}
							onChanged={onChanged}
						/>
					</span>
					<DomainTag domain={item.domain} />
					<DecisionTagPills
						decisionType={item.decisionType}
						duration={item.duration}
						priorityFlagged={item.priorityFlagged}
					/>
					{/* Not focusable, so the tooltip is a pointer affordance; the
						`sr-only` child carries the same copy for assistive tech and
						leaves the visible "Endorsed" in the accessible name. */}
					{item.vouchedAt && (
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
									<BadgeCheckIcon className="size-3" />
									Endorsed
									<span className="sr-only">
										{tTooltips("humanEndorsed")}
									</span>
								</span>
							</TooltipTrigger>
							<TooltipContent>
								{tTooltips("humanEndorsed")}
							</TooltipContent>
						</Tooltip>
					)}
					{fromMeeting && (
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="relative z-10 inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[11px] text-primary">
									<SparklesIcon className="size-3" />
									From meeting
								</span>
							</TooltipTrigger>
							<TooltipContent
								surface="popover"
								className="max-w-56"
							>
								<span className="font-medium">
									From meeting
								</span>{" "}
								— extracted from a meeting transcript. Review
								and complete the details.
							</TooltipContent>
						</Tooltip>
					)}
				</div>
				{/* title (stretched click target) */}
				<h3 className="font-medium text-foreground leading-snug">
					<button
						type="button"
						onClick={() => onOpen(item.id)}
						className="line-clamp-2 break-words text-left after:absolute after:inset-0 after:rounded-lg focus:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring"
					>
						{item.title}
					</button>
				</h3>
				{/* rationale snippet */}
				{item.rationale?.trim() && (
					<p className="line-clamp-2 break-words text-muted-foreground text-sm">
						{item.rationale}
					</p>
				)}
				{/* meta */}
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-muted-foreground text-xs">
					{people.length > 0 && (
						<span className="flex items-center gap-1.5">
							<AvatarStack people={people} />
							<span className="text-muted-foreground">
								{people[0].name}
								{people.length > 1
									? ` +${people.length - 1}`
									: ""}
							</span>
						</span>
					)}
					{rel && RelIcon && (
						// The button's visible text (kind + identifier) already
						// names it, so no `aria-label` here — one would drop that
						// visible text out of the accessible name.
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={() => onOpen(rel.ref.id)}
									className="relative z-10 inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
								>
									<RelIcon className="size-3" />
									{rel.kind}
									<span className="font-mono">
										{rel.ref.identifier}
									</span>
								</button>
							</TooltipTrigger>
							<TooltipContent>
								{tTooltips("relatedItem", {
									kind: rel.kind,
									identifier: rel.ref.identifier,
									title: rel.ref.title,
								})}
							</TooltipContent>
						</Tooltip>
					)}
					{item._count.comments > 0 && (
						<span className="flex items-center gap-1">
							<MessageSquareIcon className="size-3.5" />
							{item._count.comments}
						</span>
					)}
				</div>
			</div>
			{/* side: pin + date */}
			<div className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
				{canEdit && (
					<span className="relative z-10">
						<Button
							variant="ghost"
							size="icon"
							disabled={pinMutation.isPending}
							title={pinned ? "Unpin" : "Pin to top"}
							aria-label={
								pinned
									? "Unpin decision"
									: "Pin decision to top"
							}
							className={cn(
								"size-7 transition-opacity",
								pinned
									? "text-primary opacity-100"
									: "text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
							)}
							onClick={() =>
								pinMutation.mutate({
									projectId,
									id: item.id,
									pinned: !pinned,
									organizationId: organizationId ?? null,
								})
							}
						>
							<PinIcon
								className={cn(
									"size-4",
									pinned && "fill-current",
								)}
							/>
						</Button>
					</span>
				)}
				<DecisionDateTime
					value={item.decisionDate}
					className="whitespace-nowrap"
				/>
				<ChevronRightIcon className="size-4 opacity-0 transition-opacity group-hover:opacity-60" />
			</div>
		</article>
	);
}
