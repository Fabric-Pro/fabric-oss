"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	ArrowRightIcon,
	CheckCircle2Icon,
	ChevronDownIcon,
	ChevronRightIcon,
	ExternalLinkIcon,
	GitCommitHorizontalIcon,
	KeyRoundIcon,
	ListChecksIcon,
	Loader2Icon,
	type LucideIcon,
	MapPinIcon,
	OctagonXIcon,
	RotateCcwIcon,
	ScanSearchIcon,
	ShieldCheckIcon,
	SlidersHorizontalIcon,
	SparklesIcon,
	TagIcon,
	TicketIcon,
	WrenchIcon,
	XCircleIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfidenceChip } from "./ConfidenceChip";
import { type BulkChange, FindingsBulkBar } from "./FindingsBulkBar";
import { GroupIntoTicketsButton } from "./GroupIntoTicketsButton";
import {
	CATEGORY_BADGE_VARIANT,
	CATEGORY_LABEL,
	confidenceLevel,
	FINDING_SCANNER_DESCRIPTION,
	FINDING_SCANNER_LABEL,
	FINDING_STATUS_OPTIONS,
	type FindingGroupKey,
	type FindingScanner,
	type FindingSort,
	type FindingStatus,
	findingGroupKey,
	findingThemeKey,
	getFindingScanner,
	isLowConfidence,
	type ProjectScan,
	RULE_CATEGORY_OPTIONS,
	RULE_SEVERITY_OPTIONS,
	SCANNER_FILTER_OPTIONS,
	type ScanCategory,
	type ScanFinding,
	type ScanSeverity,
	SEVERITY_BADGE_VARIANT,
	SEVERITY_FILL_CLASS,
	SEVERITY_LABEL,
	SEVERITY_ORDER,
	STATUS_BADGE_VARIANT,
	STATUS_LABEL,
	themeComboKey,
	worstSeverity,
} from "./lib";
import { buildStoryHref } from "./lib/story-href";
import { ReviewFindingsButton } from "./ReviewFindingsButton";
import { ScanHistoryDialog } from "./ScanHistoryDialog";
import { ScanLegendButton } from "./ScanInfo";

type Props = {
	projectId: string;
	organizationId: string | null;
	/**
	 * The latest scan, used to render the clean-scan confirmation. `null` ⇒ no
	 * scan has ever completed.
	 */
	latestScan: ProjectScan | null;
	/** A scan is currently in-flight — used to gate the clean-scan card. */
	scanInFlight: boolean;
	/** Selected scan branch that scopes the findings + summary to it. */
	branch?: string;
};

type SeverityFilter = "ALL" | ScanSeverity;
type CategoryFilter = "ALL" | ScanCategory;
type StatusFilter = "ALL" | FindingStatus;
type ScannerFilter = "ALL" | FindingScanner;

/** A triage edit to one finding — any subset of status / category / severity. */
type FindingPatch = {
	status?: FindingStatus;
	category?: ScanCategory;
	severity?: ScanSeverity;
};

function toDate(value: Date | string | null | undefined): Date | null {
	if (!value) {
		return null;
	}
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A multi-finding location group (≥2 findings): its key/label, the findings
 * that belong to it, and its effective (max/worst) severity — the group sections
 * and badges as that severity. Singletons (groups of exactly one) are never
 * wrapped in a {@link FindingGroup}; they render as a bare row in their own
 * severity section.
 */
type FindingGroup = FindingGroupKey & {
	items: ScanFinding[];
	/** Worst severity among the members — the group's effective priority. */
	maxSeverity: ScanSeverity;
};

/** One placed item inside a severity section: a multi-finding group or a singleton. */
type SectionItem =
	| { kind: "group"; group: FindingGroup; sortIndex: number }
	| { kind: "singleton"; finding: ScanFinding; sortIndex: number };

/** A severity section: its severity plus the placed items (groups + singletons). */
type SeveritySection = {
	severity: ScanSeverity;
	items: SectionItem[];
};

/** The grouped ticket a finding's theme was rolled into, if a run produced one. */
type ThemeTicket = { storyId: string; storyIdentifier: string };

/**
 * A distinct theme present in the loaded findings — the `(category, ruleSource)`
 * pair the backend's "Group into tickets" run buckets on — with how many loaded
 * findings share it. Drives the client-side Theme filter's options.
 */
type ThemeOption = {
	/** Stable theme key: `themeComboKey(category, ruleSource)`. */
	key: string;
	/** Human label for the option / tag — the finding's `ruleSource`. */
	ruleSource: string;
	/** How many currently-loaded findings belong to this theme. */
	count: number;
};

export function ScanFindingsList({
	projectId,
	organizationId,
	latestScan,
	scanInFlight,
	branch,
}: Props) {
	const queryClient = useQueryClient();
	const pathname = usePathname();
	const filterHeadingId = useId();

	const [category, setCategory] = useState<CategoryFilter>("ALL");
	const [severity, setSeverity] = useState<SeverityFilter>("ALL");
	// Default to OPEN, per spec.
	const [status, setStatus] = useState<StatusFilter>("OPEN");
	const [scanner, setScanner] = useState<ScannerFilter>("ALL");
	const [sort, setSort] = useState<FindingSort>("severity");
	// Client-side THEME filter: `"ALL"` or a `themeComboKey(category, ruleSource)`.
	// Narrows the already-loaded (already server-filtered) findings to a single
	// theme — the same `(category, ruleSource)` combination the "Group into
	// tickets" run buckets on — without issuing another request. Set from the
	// Theme dropdown or by clicking a finding row's theme tag.
	const [themeFilter, setThemeFilter] = useState<string>("ALL");

	// Multi-select state (G8): the set of selected finding ids.
	const [selected, setSelected] = useState<Set<string>>(new Set());
	// Expanded location groups (G9): groups are COLLAPSED by default; a group key
	// present here is expanded. (Singletons have no collapse state.)
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	// Findings-history dialog (finding-level activity + AI review lifecycle),
	// opened from the RESULTS-bar actions so it's discoverable from the results.
	const [findingsHistoryOpen, setFindingsHistoryOpen] = useState(false);
	// Low-confidence disclosure (below the sections): COLLAPSED by default; the
	// low-signal findings the default view hides live behind it until revealed.
	const [showLowConfidence, setShowLowConfidence] = useState(false);
	const lowConfidenceBodyId = useId();

	const findingsInput = useMemo(
		() => ({
			projectId,
			organizationId,
			...(category !== "ALL" ? { category } : {}),
			...(severity !== "ALL" ? { severity } : {}),
			...(status !== "ALL" ? { status } : {}),
			...(scanner !== "ALL" ? { scanner } : {}),
			sort,
			...(branch ? { branch } : {}),
		}),
		[
			projectId,
			organizationId,
			category,
			severity,
			status,
			scanner,
			sort,
			branch,
		],
	);

	const findingsQuery = useQuery(
		orpc.projects.scan.findings.list.queryOptions({
			input: findingsInput,
		}),
	);

	// Summary counts span every status (the list above is narrowed by the Status
	// filter), so the Resolved / Dismissed totals stay correct while the default
	// Open view is shown. Category / severity / scanner scope still applies so the
	// summary reflects the active view.
	const summaryInput = useMemo(
		() => ({
			projectId,
			organizationId,
			...(category !== "ALL" ? { category } : {}),
			...(severity !== "ALL" ? { severity } : {}),
			...(scanner !== "ALL" ? { scanner } : {}),
			...(branch ? { branch } : {}),
		}),
		[projectId, organizationId, category, severity, scanner, branch],
	);

	const summaryQuery = useQuery(
		orpc.projects.scan.findings.list.queryOptions({
			input: summaryInput,
		}),
	);

	// Resolve each theme's grouped ticket so a finding can link through to it. A
	// ScanFinding carries NO reference to the ticket it was grouped into (its own
	// `storyId`/`story` is the SOURCE feature it's about); the linkage lives only
	// in the latest grouping run's results, keyed by the SAME (category,
	// ruleSource) theme. We read that here (read-only, no new backend work) and
	// match by `themeComboKey`. Shares GroupIntoTicketsButton's exact query key,
	// so it's deduped with the button's always-on fetch and stays in sync with a
	// run without polling here. Gated on having findings so a project with none
	// issues no extra request.
	const latestGroupingQuery = useQuery(
		orpc.projects.scan.grouping.latest.queryOptions({
			input: { projectId, organizationId },
			enabled: (findingsQuery.data?.findings?.length ?? 0) > 0,
		}),
	);

	const updateFinding = useMutation(
		orpc.projects.scan.findings.update.mutationOptions({
			onSuccess: () => {
				// Refetch every findings list view for this project.
				queryClient.invalidateQueries({
					queryKey: orpc.projects.scan.findings.list.key(),
				});
			},
			onError: (error) => {
				toast.error(`Couldn't update finding: ${error.message}`);
			},
		}),
	);

	// Bulk update (G8): change severity / status across the selection.
	const bulkUpdate = useMutation(
		orpc.projects.scan.findings.bulkUpdate.mutationOptions({
			onSuccess: (result) => {
				const n = result.updated ?? 0;
				toast.success(
					n === 1 ? "1 finding updated" : `${n} findings updated`,
				);
				queryClient.invalidateQueries({
					queryKey: orpc.projects.scan.findings.list.key(),
				});
				setSelected(new Set());
			},
			onError: (error) => {
				toast.error(`Couldn't update findings: ${error.message}`);
			},
		}),
	);

	// Block / unblock the work item a finding is about (its source feature),
	// using the finding as the reason. Replaces the old "convert to work item".
	const blockStory = useMutation(
		orpc.projects.stories.setBlocked.mutationOptions({
			onSuccess: (result) => {
				toast.success(
					result.blocked
						? `${result.identifier} blocked`
						: `${result.identifier} unblocked`,
				);
				queryClient.invalidateQueries({
					queryKey: orpc.projects.scan.findings.list.key(),
				});
				// Also refresh the roadmap/board AND any open work-item detail so
				// every view reflects the new blocked state (chip, filter, badge).
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.list.key(),
				});
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.get.key(),
				});
			},
			onError: (error) => {
				toast.error(`Couldn't update the work item: ${error.message}`);
			},
		}),
	);

	const handleEdit = (
		findingId: string,
		patch: FindingPatch,
		successMsg: string,
	) => {
		updateFinding.mutate(
			{ projectId, organizationId, findingId, ...patch },
			{ onSuccess: () => toast.success(successMsg) },
		);
	};

	const statusToast = (next: FindingStatus) =>
		next === "RESOLVED"
			? "Finding marked resolved"
			: next === "DISMISSED"
				? "Finding dismissed"
				: "Finding reopened";

	const handleStatusChange = (findingId: string, next: FindingStatus) => {
		handleEdit(findingId, { status: next }, statusToast(next));
	};

	// Triage edit from the per-finding editor (severity / category / status).
	const handleFieldEdit = (findingId: string, patch: FindingPatch) => {
		const msg =
			patch.severity !== undefined
				? "Severity updated"
				: patch.category !== undefined
					? "Category updated"
					: statusToast(patch.status ?? "OPEN");
		handleEdit(findingId, patch, msg);
	};

	const handleBlock = (
		storyId: string,
		blocked: boolean,
		reason?: string,
	) => {
		blockStory.mutate({
			projectId,
			organizationId,
			storyId,
			blocked,
			...(reason ? { reason } : {}),
		});
	};

	// The work item whose block toggle is in flight (disables just its button).
	const blockingStoryId = blockStory.isPending
		? (blockStory.variables?.storyId ?? null)
		: null;

	// Build the tenant-aware story route for a finding's source feature. The
	// Security view is a client-side tab, so `pathname` is the project root, not
	// `…/security` — `buildStoryHref` derives the project base and appends
	// `/stories/<id>` (see its doc comment).
	const storyHref = (storyId: string) => buildStoryHref(pathname, storyId);

	const findings = findingsQuery.data?.findings ?? [];

	// Look up a finding's title by id — passed to the AI review dialog so a
	// proposal can show the human title, not just an id.
	const getFindingTitle = useMemo(() => {
		const byId = new Map(findings.map((f) => [f.id, f.title]));
		return (id: string) => byId.get(id);
	}, [findings]);

	const openFindingCount = useMemo(
		() => findings.filter((f) => f.status === "OPEN").length,
		[findings],
	);

	// Distinct themes present across the loaded findings (computed BEFORE the
	// client-side theme narrowing so the dropdown always lists every theme) —
	// drives the Theme filter's options and their counts.
	const themeOptions = useMemo<ThemeOption[]>(() => {
		const map = new Map<string, ThemeOption>();
		for (const f of findings) {
			const { key, ruleSource } = findingThemeKey(f);
			if (!ruleSource) {
				continue; // No ruleSource ⇒ no filterable theme.
			}
			const existing = map.get(key);
			if (existing) {
				existing.count += 1;
			} else {
				map.set(key, { key, ruleSource, count: 1 });
			}
		}
		// Most-common theme first, then alphabetically for a stable order.
		return Array.from(map.values()).sort(
			(a, b) =>
				b.count - a.count || a.ruleSource.localeCompare(b.ruleSource),
		);
	}, [findings]);

	// A stale theme (e.g. after another filter changed the loaded set) collapses
	// to "ALL", so the select never shows a value absent from its options and the
	// list never goes blank behind a filter that now matches nothing.
	const effectiveThemeFilter =
		themeFilter !== "ALL" && themeOptions.some((o) => o.key === themeFilter)
			? themeFilter
			: "ALL";

	// The findings actually shown: the loaded set narrowed to the active theme.
	// Purely client-side over already-loaded data — composes on top of the
	// server-side status / category / severity / scanner filters.
	const visibleFindings = useMemo(
		() =>
			effectiveThemeFilter === "ALL"
				? findings
				: findings.filter(
						(f) => findingThemeKey(f).key === effectiveThemeFilter,
					),
		[findings, effectiveThemeFilter],
	);

	// Deterministic default-view split (zero-LLM-cost): findings the scanner was
	// LOW-confidence about (`confidence < DEFAULT_CONFIDENCE_FLOOR`) are held out
	// of the default sections and collapsed behind a disclosure below. Everything
	// else — including null/legacy confidence, which has no signal to hide behind
	// — stays in the MAIN set the severity sections are built from. This is a pure
	// view split over already-loaded data: nothing is deleted or re-fetched, and
	// it holds even if the AI false-positive review never ran.
	const { mainFindings, lowConfidenceFindings } = useMemo(() => {
		const main: ScanFinding[] = [];
		const low: ScanFinding[] = [];
		for (const f of visibleFindings) {
			(isLowConfidence(f.confidence) ? low : main).push(f);
		}
		return { mainFindings: main, lowConfidenceFindings: low };
	}, [visibleFindings]);

	// Section the findings by severity (G9). Build location groups first; a group
	// of ≥2 findings becomes a Group card, a group of exactly 1 stays a bare
	// singleton row (not grouped). Each item is then placed in the severity
	// section matching its EFFECTIVE severity — a singleton's own severity, a
	// group's MAX (worst) severity — so a group lives with its highest item while
	// keeping every member inside. Sections render in SEVERITY_ORDER; within a
	// section the existing list order (already sorted by the active `sort`) is
	// preserved via each item's first-appearance index in the flat list.
	const { sections, groupKeys } = useMemo<{
		sections: SeveritySection[];
		groupKeys: string[];
	}>(() => {
		// 1. Bucket findings into location groups, recording first-seen order.
		//    Built from the MAIN set only — low-confidence findings are collapsed
		//    into their own disclosure below, not sectioned here.
		const groupMap = new Map<
			string,
			FindingGroupKey & { items: ScanFinding[]; firstIndex: number }
		>();
		mainFindings.forEach((f, index) => {
			const gk = findingGroupKey(f);
			const existing = groupMap.get(gk.key);
			if (existing) {
				existing.items.push(f);
			} else {
				groupMap.set(gk.key, { ...gk, items: [f], firstIndex: index });
			}
		});

		// 2. Turn each bucket into a placed section item (singleton vs group),
		//    keyed into the severity section by its effective severity.
		const bySeverity = new Map<ScanSeverity, SectionItem[]>();
		for (const sev of SEVERITY_ORDER) {
			bySeverity.set(sev, []);
		}
		const keysOfMultiGroups: string[] = [];

		for (const bucket of groupMap.values()) {
			if (bucket.items.length === 1) {
				const finding = bucket.items[0];
				const sev = finding.severity as ScanSeverity;
				bySeverity.get(sev)?.push({
					kind: "singleton",
					finding,
					sortIndex: bucket.firstIndex,
				});
			} else {
				const maxSeverity = worstSeverity(
					bucket.items.map((f) => f.severity as ScanSeverity),
				);
				keysOfMultiGroups.push(bucket.key);
				bySeverity.get(maxSeverity)?.push({
					kind: "group",
					group: {
						key: bucket.key,
						label: bucket.label,
						items: bucket.items,
						maxSeverity,
					},
					sortIndex: bucket.firstIndex,
				});
			}
		}

		// 3. Sort each section's items by their first-appearance index (keeps the
		//    active query sort) and drop empty sections.
		const built: SeveritySection[] = [];
		for (const sev of SEVERITY_ORDER) {
			const items = bySeverity.get(sev) ?? [];
			if (items.length === 0) {
				continue;
			}
			items.sort((a, b) => a.sortIndex - b.sortIndex);
			built.push({ severity: sev, items });
		}
		return { sections: built, groupKeys: keysOfMultiGroups };
	}, [mainFindings]);

	// Task A — map each grouped theme back to the ticket it produced. Only themes
	// that actually resolved to a ticket carry a story id (a brand-new ticket, an
	// existing ticket that got an incremental comment, or one skipped because it
	// was already covered); proposed / failed themes have none. Every array is
	// read defensively (`?? []`) so a partially-populated or mid-review run is a
	// valid, non-crashing shape.
	const themeTickets = useMemo(() => {
		const map = new Map<string, ThemeTicket>();
		const results = latestGroupingQuery.data?.grouping?.results;
		if (!results) {
			return map;
		}
		const withTicket = [
			...(results.createdThemes ?? []),
			...(results.updatedThemes ?? []),
			...(results.skippedThemes ?? []),
		];
		for (const theme of withTicket) {
			if (theme.storyId && theme.storyIdentifier) {
				map.set(themeComboKey(theme.category, theme.ruleSource), {
					storyId: theme.storyId,
					storyIdentifier: theme.storyIdentifier,
				});
			}
		}
		return map;
	}, [latestGroupingQuery.data]);

	// Resolve the grouped ticket a given finding's theme was rolled into, if a
	// run produced one — drives the per-row "grouped into B-XX" link. Keyed on the
	// SAME (category, ruleSource) theme the run buckets on.
	const resolveTicket = (finding: ScanFinding): ThemeTicket | null =>
		themeTickets.get(findingThemeKey(finding).key) ?? null;

	// Selection helpers (G8). Selection is scoped to currently-listed findings
	// (after the client-side theme narrowing).
	const visibleIds = useMemo(
		() => visibleFindings.map((f) => f.id),
		[visibleFindings],
	);
	const selectedVisibleCount = useMemo(
		() => visibleIds.filter((id) => selected.has(id)).length,
		[visibleIds, selected],
	);

	const toggleOne = (id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	const setGroupSelected = (ids: string[], checked: boolean) => {
		setSelected((prev) => {
			const next = new Set(prev);
			for (const id of ids) {
				if (checked) {
					next.add(id);
				} else {
					next.delete(id);
				}
			}
			return next;
		});
	};

	const toggleExpanded = (key: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	};

	// Expand-all = every location group open; collapse-all = default (collapsed).
	const expandAll = () => setExpanded(new Set(groupKeys));
	const collapseAll = () => setExpanded(new Set());

	const handleBulkApply = (change: BulkChange) => {
		const ids = visibleIds.filter((id) => selected.has(id));
		if (ids.length === 0) {
			return;
		}
		bulkUpdate.mutate({
			projectId,
			organizationId,
			findingIds: ids,
			...(change.status ? { status: change.status } : {}),
			...(change.severity ? { severity: change.severity } : {}),
		});
	};

	const noFiltersApplied =
		category === "ALL" &&
		severity === "ALL" &&
		status === "OPEN" &&
		scanner === "ALL";

	// Clean-scan confirmation: latest scan completed with zero findings and no
	// scan is currently running. Only shown when the user hasn't narrowed the
	// view with filters (so it reflects the actual scan, not a filtered subset).
	const latestCompletedClean =
		!scanInFlight &&
		latestScan?.status === "COMPLETED" &&
		latestScan.securityFindingCount === 0 &&
		latestScan.accessibilityFindingCount === 0;

	const completedAt = toDate(latestScan?.completedAt);

	const filterBar = (
		<fieldset
			className="flex flex-wrap items-end gap-3"
			aria-labelledby={filterHeadingId}
		>
			<legend id={filterHeadingId} className="sr-only">
				Filter and sort findings
			</legend>
			<FilterSelect
				label="Status"
				value={status}
				onChange={(v) => setStatus(v as StatusFilter)}
				options={[
					{ value: "OPEN", label: "Open" },
					{ value: "RESOLVED", label: "Resolved" },
					{ value: "DISMISSED", label: "Dismissed" },
					{ value: "ALL", label: "All statuses" },
				]}
			/>
			<FilterSelect
				label="Category"
				value={category}
				onChange={(v) => setCategory(v as CategoryFilter)}
				options={[
					{ value: "ALL", label: "All categories" },
					{ value: "SECURITY", label: "Security" },
					{ value: "ACCESSIBILITY", label: "Accessibility" },
				]}
			/>
			<FilterSelect
				label="Severity"
				value={severity}
				onChange={(v) => setSeverity(v as SeverityFilter)}
				options={[
					{ value: "ALL", label: "All severities" },
					...SEVERITY_ORDER.map((s) => ({
						value: s,
						label: SEVERITY_LABEL[s],
					})),
				]}
			/>
			{/* Scan-type / engine filter (G12). */}
			<FilterSelect
				label="Scanner"
				value={scanner}
				onChange={(v) => setScanner(v as ScannerFilter)}
				options={[
					{ value: "ALL", label: "All scanners" },
					...SCANNER_FILTER_OPTIONS.map((o) => ({
						value: o.value,
						label: o.label,
					})),
				]}
			/>
			{/* Sort (G1): severity (default) or confidence. */}
			<FilterSelect
				label="Sort by"
				value={sort}
				onChange={(v) => setSort(v as FindingSort)}
				options={[
					{ value: "severity", label: "Severity" },
					{ value: "confidence", label: "Confidence" },
				]}
			/>
			{/* Client-side THEME filter — only worth showing with ≥2 themes.
			    Composes with the server-side filters above; narrows in place. */}
			{themeOptions.length > 1 ? (
				<ThemeFilterControl
					value={effectiveThemeFilter}
					options={themeOptions}
					onChange={setThemeFilter}
				/>
			) : null}
		</fieldset>
	);

	return (
		<section className="space-y-4" aria-label="Scan results">
			{latestCompletedClean && noFiltersApplied ? (
				<CleanScanCard
					completedAt={completedAt}
					modelName={latestScan?.modelName ?? null}
				/>
			) : null}

			<SummaryBar
				findings={summaryQuery.data?.findings ?? []}
				actions={
					<>
						<ReviewFindingsButton
							projectId={projectId}
							organizationId={organizationId}
							getFindingTitle={getFindingTitle}
							openFindingCount={openFindingCount}
						/>
						<GroupIntoTicketsButton
							projectId={projectId}
							organizationId={organizationId}
							openFindingCount={openFindingCount}
						/>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setFindingsHistoryOpen(true)}
							className="gap-1.5"
						>
							<ListChecksIcon
								aria-hidden="true"
								className="size-4"
							/>
							Findings history
						</Button>
					</>
				}
			/>

			{/* Finding-level activity + AI review lifecycle, opened from the
			    RESULTS bar so finding history is discoverable from the results. */}
			<ScanHistoryDialog
				projectId={projectId}
				organizationId={organizationId}
				group="FINDINGS"
				open={findingsHistoryOpen}
				onOpenChange={setFindingsHistoryOpen}
			/>

			<div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
				{filterBar}
				<div className="flex items-center gap-2">
					<ScanLegendButton />
				</div>
			</div>

			{findingsQuery.isLoading ? (
				<div className="space-y-2" aria-hidden="true">
					{[0, 1, 2].map((i) => (
						<div
							key={i}
							className="h-24 animate-pulse rounded-lg border border-border bg-muted"
						/>
					))}
				</div>
			) : findings.length === 0 ? (
				<EmptyFindings
					clean={latestCompletedClean && noFiltersApplied}
					hasScan={!!latestScan}
					branch={branch}
				/>
			) : (
				<>
					{groupKeys.length > 0 ? (
						<GroupControls
							onExpandAll={expandAll}
							onCollapseAll={collapseAll}
						/>
					) : null}
					<div className="space-y-8">
						{sections.map((section) => (
							<SeveritySectionBlock
								key={section.severity}
								section={section}
								expanded={expanded}
								onToggleExpanded={toggleExpanded}
								selected={selected}
								onToggleOne={toggleOne}
								onSetGroupSelected={setGroupSelected}
								onStatusChange={handleStatusChange}
								onEdit={handleFieldEdit}
								onBlock={handleBlock}
								isUpdating={updateFinding.isPending}
								blockingStoryId={blockingStoryId}
								storyHref={storyHref}
								onSelectTheme={setThemeFilter}
								resolveTicket={resolveTicket}
								activeThemeKey={effectiveThemeFilter}
							/>
						))}
					</div>

					{lowConfidenceFindings.length > 0 ? (
						<LowConfidenceDisclosure
							findings={lowConfidenceFindings}
							open={showLowConfidence}
							onToggle={() => setShowLowConfidence((v) => !v)}
							bodyId={lowConfidenceBodyId}
							selected={selected}
							onToggleOne={toggleOne}
							onStatusChange={handleStatusChange}
							onEdit={handleFieldEdit}
							onBlock={handleBlock}
							isUpdating={updateFinding.isPending}
							blockingStoryId={blockingStoryId}
							storyHref={storyHref}
							onSelectTheme={setThemeFilter}
							resolveTicket={resolveTicket}
							activeThemeKey={effectiveThemeFilter}
						/>
					) : null}
				</>
			)}

			<FindingsBulkBar
				selectedCount={selectedVisibleCount}
				isApplying={bulkUpdate.isPending}
				onApply={handleBulkApply}
				onClear={() => setSelected(new Set())}
			/>
		</section>
	);
}

/** Expand-all / collapse-all controls for the location groups (G9). */
function GroupControls({
	onExpandAll,
	onCollapseAll,
}: {
	onExpandAll: () => void;
	onCollapseAll: () => void;
}) {
	return (
		<div className="flex items-center justify-end gap-1 text-muted-foreground text-xs">
			<span className="mr-1">Groups</span>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="h-7 px-2 text-xs"
				onClick={onExpandAll}
			>
				Expand all
			</Button>
			<span aria-hidden="true">·</span>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="h-7 px-2 text-xs"
				onClick={onCollapseAll}
			>
				Collapse all
			</Button>
		</div>
	);
}

/**
 * The collapsed disclosure for LOW-confidence findings (below the severity
 * sections). The default view hides findings the scanner was low-confidence about
 * (often audit-only rules) to keep the signal high; this affordance reveals them
 * on demand — COLLAPSED by default, one click to expand. Nothing is ever deleted.
 * Members render as the SAME {@link FindingRow} used in the main list (a flat
 * list), so each stays fully actionable and selectable. Uses design-system tokens
 * only; the dashed, muted trigger reads as secondary to the main findings.
 */
function LowConfidenceDisclosure({
	findings,
	open,
	onToggle,
	bodyId,
	...rowProps
}: {
	findings: ScanFinding[];
	open: boolean;
	onToggle: () => void;
	bodyId: string;
} & Omit<
	SectionRowProps,
	"expanded" | "onToggleExpanded" | "onSetGroupSelected"
>) {
	const { selected, onToggleOne, isUpdating, blockingStoryId, storyHref } =
		rowProps;
	const count = findings.length;
	return (
		<section className="space-y-2.5" aria-label="Low-confidence findings">
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				aria-controls={bodyId}
				className="group/lowconf flex w-full items-start gap-2.5 rounded-lg border border-border border-dashed bg-muted/30 px-4 py-3 text-left transition-colors hover:bg-muted/50"
			>
				<span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors group-hover/lowconf:bg-muted group-hover/lowconf:text-foreground">
					{open ? (
						<ChevronDownIcon
							aria-hidden="true"
							className="size-4"
						/>
					) : (
						<ChevronRightIcon
							aria-hidden="true"
							className="size-4"
						/>
					)}
				</span>
				<span className="min-w-0 flex-1">
					<span className="block font-medium text-foreground text-sm">
						{open ? "Hide" : "Show"} {count} low-confidence{" "}
						{count === 1 ? "finding" : "findings"}
					</span>
					<span className="mt-0.5 block text-muted-foreground text-xs leading-snug">
						Hidden from the default view because the scanner's
						confidence was low (often audit-only rules). Nothing is
						deleted.
					</span>
				</span>
			</button>

			{open ? (
				<ul id={bodyId} className="space-y-2.5">
					{findings.map((finding) => (
						<FindingRow
							key={finding.id}
							finding={finding}
							selected={selected.has(finding.id)}
							onToggleSelected={() => onToggleOne(finding.id)}
							onStatusChange={rowProps.onStatusChange}
							onEdit={rowProps.onEdit}
							onBlock={rowProps.onBlock}
							isUpdating={isUpdating}
							isBlocking={
								blockingStoryId != null &&
								blockingStoryId === finding.story?.id
							}
							storyHref={storyHref}
							onSelectTheme={rowProps.onSelectTheme}
							resolveTicket={rowProps.resolveTicket}
							activeThemeKey={rowProps.activeThemeKey}
						/>
					))}
				</ul>
			) : null}
		</section>
	);
}

/**
 * The client-side THEME filter — a labelled Select of the distinct themes present
 * in the loaded findings (label = `ruleSource`, with a count) plus "All themes",
 * and an inline clear button when a theme is active. Selecting a theme narrows
 * the list in place (no request) and composes with the server-side filters. The
 * caller renders this only when ≥2 themes exist, so it's never a dead control.
 * The trigger has a capped width and clamps a long value to one line, so it wraps
 * cleanly in the filter row without overflowing a narrow viewport.
 */
function ThemeFilterControl({
	value,
	options,
	onChange,
}: {
	/** `"ALL"` or a `themeComboKey(category, ruleSource)`. */
	value: string;
	options: ThemeOption[];
	onChange: (value: string) => void;
}) {
	const id = useId();
	const active = value !== "ALL";
	return (
		<div className="grid gap-1.5">
			<Label htmlFor={id} className="text-muted-foreground text-xs">
				Theme
			</Label>
			<div className="flex items-center gap-1">
				<Select value={value} onValueChange={onChange}>
					<SelectTrigger
						id={id}
						className="h-9 w-[200px] max-w-[calc(100vw-2rem)] text-sm"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent className="max-w-[min(24rem,calc(100vw-2rem))]">
						<SelectItem value="ALL">All themes</SelectItem>
						{options.map((o) => (
							<SelectItem key={o.key} value={o.key}>
								{o.ruleSource} ({o.count})
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{active ? (
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="shrink-0 text-muted-foreground"
						onClick={() => onChange("ALL")}
						aria-label="Clear theme filter"
					>
						<XIcon aria-hidden="true" className="size-4" />
					</Button>
				) : null}
			</div>
		</div>
	);
}

/**
 * The theme tag on a finding row — a compact, keyboard-accessible chip naming the
 * finding's theme (its `ruleSource`, i.e. the `(category, ruleSource)` combo the
 * grouping run buckets on). Clicking it sets the Theme filter to that theme;
 * `aria-pressed` reflects whether that theme is the active filter. Design-system
 * tokens only (works light + dark); it truncates so a long rule id never forces
 * horizontal overflow, keeping the full value in the accessible name + a
 * hover/focus tooltip.
 */
function ThemeTagChip({
	ruleSource,
	active,
	onSelect,
}: {
	ruleSource: string;
	active: boolean;
	onSelect: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={onSelect}
					aria-pressed={active}
					aria-label={`Filter findings by theme: ${ruleSource}`}
					className={cn(
						"inline-flex min-w-0 max-w-[min(16rem,100%)] items-center gap-1 rounded-sm border px-2 py-0.5 font-medium text-xs transition-colors",
						"focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50",
						active
							? "border-transparent bg-primary/10 text-primary dark:bg-primary/20"
							: "border-border/50 text-muted-foreground hover:border-accent-foreground/20 hover:bg-accent hover:text-accent-foreground",
					)}
				>
					<TagIcon aria-hidden="true" className="size-3 shrink-0" />
					<span className="min-w-0 truncate">{ruleSource}</span>
				</button>
			</TooltipTrigger>
			<TooltipContent>{ruleSource}</TooltipContent>
		</Tooltip>
	);
}

type SectionRowProps = {
	expanded: Set<string>;
	onToggleExpanded: (key: string) => void;
	selected: Set<string>;
	onToggleOne: (id: string) => void;
	onSetGroupSelected: (ids: string[], checked: boolean) => void;
	onStatusChange: (findingId: string, next: FindingStatus) => void;
	onEdit: (findingId: string, patch: FindingPatch) => void;
	onBlock: (storyId: string, blocked: boolean, reason?: string) => void;
	isUpdating: boolean;
	blockingStoryId: string | null;
	storyHref: (storyId: string) => string;
	/** Set the client-side theme filter (from a row's theme tag). */
	onSelectTheme: (themeKey: string) => void;
	/** The grouped ticket a finding's theme was rolled into, if any. */
	resolveTicket: (finding: ScanFinding) => ThemeTicket | null;
	/** The active theme filter key — drives the tag's pressed state. */
	activeThemeKey: string;
};

/**
 * One severity section (G9): a real heading naming the severity + its item count,
 * then the placed items — multi-finding Group cards and singleton finding rows —
 * in the active sort order. Sections are ordered worst-first by the caller.
 */
function SeveritySectionBlock({
	section,
	...rowProps
}: { section: SeveritySection } & SectionRowProps) {
	const { selected, onToggleOne, isUpdating, blockingStoryId, storyHref } =
		rowProps;
	const headingId = useId();
	const total = section.items.reduce(
		(sum, item) =>
			sum + (item.kind === "group" ? item.group.items.length : 1),
		0,
	);

	return (
		<section aria-labelledby={headingId} className="space-y-2.5">
			<h3
				id={headingId}
				className="flex items-center gap-2 font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.12em]"
			>
				<span
					aria-hidden="true"
					className={cn(
						"size-2 rounded-full",
						SEVERITY_FILL_CLASS[section.severity],
					)}
				/>
				{SEVERITY_LABEL[section.severity]}
				<span className="font-normal text-muted-foreground/80 normal-case tracking-normal">
					{total} {total === 1 ? "finding" : "findings"}
				</span>
			</h3>

			<ul className="space-y-2.5">
				{section.items.map((item) =>
					item.kind === "group" ? (
						<FindingGroupCard
							key={item.group.key}
							group={item.group}
							{...rowProps}
						/>
					) : (
						<FindingRow
							key={item.finding.id}
							finding={item.finding}
							selected={selected.has(item.finding.id)}
							onToggleSelected={() =>
								onToggleOne(item.finding.id)
							}
							onStatusChange={rowProps.onStatusChange}
							onEdit={rowProps.onEdit}
							onBlock={rowProps.onBlock}
							isUpdating={isUpdating}
							isBlocking={
								blockingStoryId != null &&
								blockingStoryId === item.finding.story?.id
							}
							storyHref={storyHref}
							onSelectTheme={rowProps.onSelectTheme}
							resolveTicket={rowProps.resolveTicket}
							activeThemeKey={rowProps.activeThemeKey}
						/>
					),
				)}
			</ul>
		</section>
	);
}

/**
 * A multi-finding location group (G9), rendered to look like a single
 * {@link FindingRow} card: the same shell (rounded border, `bg-card`, left
 * severity rail in the group's MAX severity), a per-group select-all checkbox, a
 * disclosure chevron, a badges row (max-severity badge + the distinct category
 * badges present in the group), the group's location/feature label as the
 * heading, and an "N findings" count chip. COLLAPSED by default; expanding
 * reveals the member findings as `FindingRow` line items. Every member finding
 * stays individually actionable.
 */
function FindingGroupCard({
	group,
	expanded,
	onToggleExpanded,
	selected,
	onToggleOne,
	onSetGroupSelected,
	onStatusChange,
	onEdit,
	onBlock,
	isUpdating,
	blockingStoryId,
	storyHref,
	onSelectTheme,
	resolveTicket,
	activeThemeKey,
}: { group: FindingGroup } & SectionRowProps) {
	const bodyId = useId();
	const isOpen = expanded.has(group.key);
	const groupIds = group.items.map((f) => f.id);
	const selectedInGroup = groupIds.filter((id) => selected.has(id)).length;
	const allSelected = selectedInGroup === groupIds.length;
	const someSelected = selectedInGroup > 0 && !allSelected;
	const severity = group.maxSeverity;

	// Distinct categories present in the group, in a stable order — shown as
	// badges beside the severity, mirroring a finding's badges row.
	const categories = useMemo(() => {
		const seen = new Set<ScanCategory>();
		const ordered: ScanCategory[] = [];
		for (const f of group.items) {
			const c = f.category as ScanCategory;
			if (!seen.has(c)) {
				seen.add(c);
				ordered.push(c);
			}
		}
		return ordered;
	}, [group.items]);

	const toggle = () => onToggleExpanded(group.key);

	return (
		<li
			className={cn(
				"relative overflow-hidden rounded-lg border border-border bg-card pr-4 pl-5",
				"transition-colors hover:border-border/80",
				someSelected || allSelected ? "ring-1 ring-primary/40" : null,
			)}
		>
			{/* Left severity rail — the group's max severity. */}
			<span
				aria-hidden="true"
				className={cn(
					"absolute inset-y-0 left-0 w-[3px]",
					SEVERITY_FILL_CLASS[severity],
				)}
			/>

			<div className="flex flex-wrap items-start gap-3 py-4">
				{/* Per-group select-all checkbox (G8). Sits outside the disclosure
				    button so it's a separate, individually-labelled control. */}
				<Checkbox
					checked={
						allSelected
							? true
							: someSelected
								? "indeterminate"
								: false
					}
					onCheckedChange={(checked) =>
						onSetGroupSelected(groupIds, checked === true)
					}
					aria-label={`Select all findings in ${group.label}`}
					className="mt-1 shrink-0"
				/>

				{/* The whole header is one disclosure button (chevron + badges +
				    label + count), so the group toggles like a single card. */}
				<button
					type="button"
					onClick={toggle}
					aria-expanded={isOpen}
					aria-controls={bodyId}
					className="group/disc -my-2 flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-2 py-2 text-left"
				>
					<span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors group-hover/disc:bg-muted group-hover/disc:text-foreground">
						{isOpen ? (
							<ChevronDownIcon
								aria-hidden="true"
								className="size-4"
							/>
						) : (
							<ChevronRightIcon
								aria-hidden="true"
								className="size-4"
							/>
						)}
					</span>

					<span className="min-w-0 flex-1 space-y-2">
						<span className="flex flex-wrap items-center gap-2">
							<Badge variant={SEVERITY_BADGE_VARIANT[severity]}>
								{SEVERITY_LABEL[severity]}
							</Badge>
							{categories.map((c) => (
								<Badge
									key={c}
									variant={CATEGORY_BADGE_VARIANT[c]}
								>
									{CATEGORY_LABEL[c]}
								</Badge>
							))}
							<Badge
								variant="outline"
								className="gap-1 font-normal"
							>
								{group.items.length} findings
							</Badge>
						</span>
						<span className="flex items-center gap-1.5 font-medium text-foreground text-sm leading-snug group-hover/disc:text-primary">
							<MapPinIcon
								aria-hidden="true"
								className="size-3.5 shrink-0 text-muted-foreground"
							/>
							<span className="min-w-0 break-words">
								{group.label}
							</span>
						</span>
					</span>
				</button>
			</div>

			{isOpen ? (
				<ul id={bodyId} className="space-y-2.5 pb-4 pl-9">
					{group.items.map((finding) => (
						<FindingRow
							key={finding.id}
							finding={finding}
							selected={selected.has(finding.id)}
							onToggleSelected={() => onToggleOne(finding.id)}
							onStatusChange={onStatusChange}
							onEdit={onEdit}
							onBlock={onBlock}
							isUpdating={isUpdating}
							isBlocking={
								blockingStoryId != null &&
								blockingStoryId === finding.story?.id
							}
							storyHref={storyHref}
							onSelectTheme={onSelectTheme}
							resolveTicket={resolveTicket}
							activeThemeKey={activeThemeKey}
						/>
					))}
				</ul>
			) : null}
		</li>
	);
}

function SummaryBar({
	findings,
	actions,
}: {
	findings: ScanFinding[];
	/** Right-aligned actions slot (Review findings + Findings history). */
	actions?: ReactNode;
}) {
	const counts = useMemo(() => {
		const open: Record<ScanSeverity, number> = {
			CRITICAL: 0,
			HIGH: 0,
			MEDIUM: 0,
			LOW: 0,
		};
		let resolved = 0;
		let dismissed = 0;
		for (const f of findings) {
			if (f.status === "RESOLVED") {
				resolved += 1;
			} else if (f.status === "DISMISSED") {
				dismissed += 1;
			} else {
				open[f.severity as ScanSeverity] += 1;
			}
		}
		const openTotal = SEVERITY_ORDER.reduce((sum, s) => sum + open[s], 0);
		// TOTAL spans every status in the current view (open + resolved +
		// dismissed) — the count of findings shown by the active filters.
		const total = findings.length;
		return { open, resolved, dismissed, openTotal, total };
	}, [findings]);

	return (
		<div className="rounded-lg border border-border bg-muted/40 px-4 py-3.5">
			{/* Stacks on mobile (stats over actions) so neither the stat chips nor
			    the action buttons ever overflow a narrow viewport; side-by-side
			    from `sm`. */}
			<div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-x-6">
				<div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 sm:gap-x-6">
					{/* TOTAL — leading, the headline count for the current view. */}
					<div className="flex flex-col gap-1">
						<span className="font-light text-3xl text-foreground tabular-nums leading-none">
							{counts.total}
						</span>
						<span className="font-semibold text-[11px] text-muted-foreground uppercase tracking-wide">
							Total
						</span>
					</div>

					<div
						aria-hidden="true"
						className="hidden h-9 w-px bg-border sm:block"
					/>

					{SEVERITY_ORDER.map((s) => (
						<div key={s} className="flex flex-col gap-1">
							<span className="font-light text-2xl text-foreground tabular-nums leading-none">
								{counts.open[s]}
							</span>
							<span className="flex items-center gap-1.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide">
								<span
									aria-hidden="true"
									className={cn(
										"size-1.5 rounded-full",
										SEVERITY_FILL_CLASS[s],
									)}
								/>
								{SEVERITY_LABEL[s]}
							</span>
						</div>
					))}

					<div
						aria-hidden="true"
						className="hidden h-9 w-px bg-border sm:block"
					/>

					<div className="flex flex-col gap-1">
						<span className="font-light text-2xl text-muted-foreground tabular-nums leading-none">
							{counts.resolved}
						</span>
						<span className="font-semibold text-[11px] text-muted-foreground uppercase tracking-wide">
							Resolved
						</span>
					</div>
					<div className="flex flex-col gap-1">
						<span className="font-light text-2xl text-muted-foreground tabular-nums leading-none">
							{counts.dismissed}
						</span>
						<span className="font-semibold text-[11px] text-muted-foreground uppercase tracking-wide">
							Dismissed
						</span>
					</div>
				</div>

				{actions ? (
					<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
						{actions}
					</div>
				) : null}
			</div>

			{counts.openTotal > 0 ? (
				<div
					className="mt-3.5 flex h-2 gap-[3px] overflow-hidden rounded-full bg-muted"
					aria-hidden="true"
				>
					{SEVERITY_ORDER.map((s) =>
						counts.open[s] > 0 ? (
							<span
								key={s}
								className={cn(
									"block rounded-sm",
									SEVERITY_FILL_CLASS[s],
								)}
								style={{ flexGrow: counts.open[s] }}
							/>
						) : null,
					)}
				</div>
			) : null}
		</div>
	);
}

function FilterSelect({
	label,
	value,
	onChange,
	options,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	options: ReadonlyArray<{ value: string; label: string }>;
}) {
	const id = useId();
	return (
		<div className="grid gap-1.5">
			<Label htmlFor={id} className="text-muted-foreground text-xs">
				{label}
			</Label>
			<Select value={value} onValueChange={onChange}>
				<SelectTrigger id={id} className="h-9 w-[160px] text-sm">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{options.map((opt) => (
						<SelectItem key={opt.value} value={opt.value}>
							{opt.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

function FindingRow({
	finding,
	selected,
	onToggleSelected,
	onStatusChange,
	onEdit,
	onBlock,
	isUpdating,
	isBlocking,
	storyHref,
	onSelectTheme,
	resolveTicket,
	activeThemeKey,
}: {
	finding: ScanFinding;
	selected: boolean;
	onToggleSelected: () => void;
	onStatusChange: (findingId: string, next: FindingStatus) => void;
	onEdit: (findingId: string, patch: FindingPatch) => void;
	onBlock: (storyId: string, blocked: boolean, reason?: string) => void;
	isUpdating: boolean;
	isBlocking: boolean;
	storyHref: (storyId: string) => string;
	onSelectTheme: (themeKey: string) => void;
	resolveTicket: (finding: ScanFinding) => ThemeTicket | null;
	activeThemeKey: string;
}) {
	const bodyId = useId();
	const [open, setOpen] = useState(false);

	const category = finding.category as ScanCategory;
	const severity = finding.severity as ScanSeverity;
	const status = finding.status as FindingStatus;
	const scanner = getFindingScanner(finding);
	const closed = status !== "OPEN";
	// The finding's theme (its `(category, ruleSource)` combo) + the grouped
	// ticket it was rolled into by a run, if any.
	const { key: themeKey } = findingThemeKey(finding);
	const ruleSource = finding.ruleSource ?? "";
	const ticket = resolveTicket(finding);

	const toggle = () => setOpen((v) => !v);

	return (
		<li
			className={cn(
				"relative overflow-hidden rounded-lg border border-border bg-card pr-4 pl-5",
				"transition-colors hover:border-border/80",
				closed && "opacity-60",
				selected && "ring-1 ring-primary/40",
			)}
		>
			{/* Left severity rail. */}
			<span
				aria-hidden="true"
				className={cn(
					"absolute inset-y-0 left-0 w-[3px]",
					closed
						? "bg-muted-foreground/40"
						: SEVERITY_FILL_CLASS[severity],
				)}
			/>

			<div className="flex flex-wrap items-start gap-3 py-4">
				{/* Multi-select checkbox (G8). */}
				<Checkbox
					checked={selected}
					onCheckedChange={onToggleSelected}
					aria-label={`Select finding: ${finding.title}`}
					className="mt-1 shrink-0"
				/>

				<button
					type="button"
					onClick={toggle}
					aria-expanded={open}
					aria-controls={bodyId}
					aria-label={`${open ? "Collapse" : "Expand"} finding: ${finding.title}`}
					className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				>
					{open ? (
						<ChevronDownIcon
							aria-hidden="true"
							className="size-4"
						/>
					) : (
						<ChevronRightIcon
							aria-hidden="true"
							className="size-4"
						/>
					)}
				</button>

				<div className="min-w-0 flex-1 space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant={SEVERITY_BADGE_VARIANT[severity]}>
							{SEVERITY_LABEL[severity]}
						</Badge>
						<Badge variant={CATEGORY_BADGE_VARIANT[category]}>
							{CATEGORY_LABEL[category]}
						</Badge>
						<Badge variant={STATUS_BADGE_VARIANT[status]}>
							{STATUS_LABEL[status]}
						</Badge>
						<ScannerChip scanner={scanner} />
						{/* Theme tag — the finding's (category, ruleSource) theme.
						    Click to filter the list to this theme. Replaces the old
						    plain-text ruleSource line; the full value stays in its
						    accessible name + title. */}
						{ruleSource ? (
							<ThemeTagChip
								ruleSource={ruleSource}
								active={activeThemeKey === themeKey}
								onSelect={() => onSelectTheme(themeKey)}
							/>
						) : null}
						{/* When a grouping run rolled this finding's theme into a
						    ticket, link straight to it (tenant-aware). */}
						{ticket ? (
							<Link
								href={storyHref(ticket.storyId)}
								className="inline-flex min-w-0 max-w-full items-center gap-1 font-medium text-primary text-xs hover:underline"
								title={`Grouped into ticket ${ticket.storyIdentifier}`}
								aria-label={`Open the ticket this finding's theme was grouped into: ${ticket.storyIdentifier}`}
							>
								<TicketIcon
									aria-hidden="true"
									className="size-3 shrink-0"
								/>
								<span className="min-w-0 truncate">
									{ticket.storyIdentifier}
								</span>
							</Link>
						) : null}
						<ConfidenceChip confidence={finding.confidence} />
						{finding.isCustomRule && (
							<Badge variant="outline" className="font-normal">
								Custom rule
							</Badge>
						)}
					</div>
					<h4 className="font-medium text-foreground text-sm leading-snug">
						<button
							type="button"
							onClick={toggle}
							className="break-words text-left hover:text-primary"
						>
							{finding.title}
						</button>
					</h4>
				</div>

				<FindingActions
					finding={finding}
					status={status}
					isUpdating={isUpdating}
					isBlocking={isBlocking}
					onStatusChange={(next) => onStatusChange(finding.id, next)}
					onBlock={onBlock}
					storyHref={storyHref}
				/>
			</div>

			{open ? (
				<div id={bodyId} className="space-y-3 pb-4 pl-9">
					<p className="break-words text-muted-foreground text-sm leading-relaxed">
						{finding.description}
					</p>

					<ScannerDetail scanner={scanner} />

					<ConfidenceDetail confidence={finding.confidence} />

					<div className="rounded-md border border-border bg-muted/40 p-3">
						<p className="flex items-center gap-1.5 font-medium text-foreground text-xs uppercase tracking-wide">
							<WrenchIcon
								aria-hidden="true"
								className="size-3.5"
							/>
							Remediation
						</p>
						<p className="mt-1.5 break-words text-muted-foreground text-sm">
							{finding.remediation}
						</p>
					</div>

					{finding.location && (
						<p className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs">
							<MapPinIcon
								aria-hidden="true"
								className="size-3.5 shrink-0"
							/>
							<span className="break-all">
								{finding.location}
							</span>
						</p>
					)}

					<FindingSourceLink
						finding={finding}
						storyHref={storyHref}
					/>

					<FindingTriageEditor
						severity={severity}
						category={category}
						status={status}
						disabled={isUpdating}
						onChange={(patch) => onEdit(finding.id, patch)}
					/>
				</div>
			) : (
				<button
					type="button"
					onClick={() => setOpen(true)}
					aria-hidden="true"
					tabIndex={-1}
					className="block w-full cursor-pointer pb-4 pl-9 text-left text-muted-foreground text-sm"
				>
					<span className="line-clamp-1 break-words">
						{finding.description}
					</span>
				</button>
			)}
		</li>
	);
}

function FindingActions({
	finding,
	status,
	isUpdating,
	isBlocking,
	onStatusChange,
	onBlock,
	storyHref,
}: {
	finding: ScanFinding;
	status: FindingStatus;
	isUpdating: boolean;
	isBlocking: boolean;
	onStatusChange: (next: FindingStatus) => void;
	onBlock: (storyId: string, blocked: boolean, reason?: string) => void;
	storyHref: (storyId: string) => string;
}) {
	const blockControl = (
		<FindingBlockControl
			finding={finding}
			isBlocking={isBlocking}
			onBlock={onBlock}
			storyHref={storyHref}
		/>
	);

	if (status !== "OPEN") {
		return (
			<div className="flex shrink-0 flex-wrap items-center gap-2">
				{blockControl}
				<Button
					variant="outline"
					size="sm"
					disabled={isUpdating}
					onClick={() => onStatusChange("OPEN")}
					className="gap-1.5"
				>
					<RotateCcwIcon aria-hidden="true" className="size-4" />
					Reopen
				</Button>
			</div>
		);
	}

	return (
		<div className="flex shrink-0 flex-wrap items-center gap-2">
			{blockControl}
			<Button
				variant="outline"
				size="sm"
				disabled={isUpdating}
				onClick={() => onStatusChange("RESOLVED")}
				className="gap-1.5"
			>
				<CheckCircle2Icon
					aria-hidden="true"
					className="size-4 text-secondary"
				/>
				Resolve
			</Button>
			<Button
				variant="ghost"
				size="sm"
				disabled={isUpdating}
				onClick={() => onStatusChange("DISMISSED")}
				className="gap-1.5"
			>
				<XCircleIcon aria-hidden="true" className="size-4" />
				Dismiss
			</Button>
		</div>
	);
}

/**
 * If a finding is about an existing feature, let the user block that work item
 * (with the finding as the reason) — or show a "Blocked → F-XXX" chip if it's
 * already blocked. Nothing if the finding isn't linked to a feature.
 */
function FindingBlockControl({
	finding,
	isBlocking,
	onBlock,
	storyHref,
}: {
	finding: ScanFinding;
	isBlocking: boolean;
	onBlock: (storyId: string, blocked: boolean, reason?: string) => void;
	storyHref: (storyId: string) => string;
}) {
	const story = finding.story;
	if (!story) {
		return null;
	}
	if (story.blocked) {
		return (
			<BlockedChip
				identifier={story.identifier}
				reason={story.blockedReason}
				href={storyHref(story.id)}
			/>
		);
	}
	return (
		<Button
			variant="outline"
			size="sm"
			disabled={isBlocking}
			onClick={() => onBlock(story.id, true, finding.title)}
			className="gap-1.5"
			title={`Block ${story.identifier} with this finding as the reason`}
		>
			{isBlocking ? (
				<Loader2Icon
					aria-hidden="true"
					className="size-4 motion-safe:animate-spin"
				/>
			) : (
				<OctagonXIcon aria-hidden="true" className="size-4" />
			)}
			Block {story.identifier}
		</Button>
	);
}

/**
 * Per-finding triage editor — lets the user override the AI's severity and
 * category, and set the status, from the expanded finding body. Each change
 * patches immediately (Radix Select only fires on an actual change, so picking
 * the current value is a no-op).
 */
function FindingTriageEditor({
	severity,
	category,
	status,
	disabled,
	onChange,
}: {
	severity: ScanSeverity;
	category: ScanCategory;
	status: FindingStatus;
	disabled: boolean;
	onChange: (patch: FindingPatch) => void;
}) {
	return (
		<div className="flex flex-wrap items-end gap-3 border-border/60 border-t pt-3">
			<p className="flex w-full items-center gap-1.5 font-medium text-foreground text-xs uppercase tracking-wide">
				<SlidersHorizontalIcon
					aria-hidden="true"
					className="size-3.5"
				/>
				Adjust triage
			</p>
			<EditSelect
				label="Severity"
				value={severity}
				options={RULE_SEVERITY_OPTIONS}
				disabled={disabled}
				onChange={(v) => onChange({ severity: v as ScanSeverity })}
			/>
			<EditSelect
				label="Category"
				value={category}
				options={RULE_CATEGORY_OPTIONS}
				disabled={disabled}
				onChange={(v) => onChange({ category: v as ScanCategory })}
			/>
			<EditSelect
				label="Status"
				value={status}
				options={FINDING_STATUS_OPTIONS}
				disabled={disabled}
				onChange={(v) => onChange({ status: v as FindingStatus })}
			/>
		</div>
	);
}

function EditSelect({
	label,
	value,
	options,
	disabled,
	onChange,
}: {
	label: string;
	value: string;
	options: ReadonlyArray<{ value: string; label: string }>;
	disabled?: boolean;
	onChange: (value: string) => void;
}) {
	const id = useId();
	return (
		<div className="grid gap-1.5">
			<Label htmlFor={id} className="text-muted-foreground text-xs">
				{label}
			</Label>
			<Select value={value} onValueChange={onChange} disabled={disabled}>
				<SelectTrigger id={id} className="h-9 w-[150px] text-sm">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{options.map((opt) => (
						<SelectItem key={opt.value} value={opt.value}>
							{opt.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/**
 * A verifiable link to a finding's source: the repo file / commit (Semgrep,
 * git-history — opens the host in a new tab) or the in-app feature it's about.
 */
function FindingSourceLink({
	finding,
	storyHref,
}: {
	finding: ScanFinding;
	storyHref: (storyId: string) => string;
}) {
	if (finding.sourceUrl) {
		const isCommit = (finding.ruleSource ?? "").startsWith(
			"Secret history",
		);
		return (
			<a
				href={finding.sourceUrl}
				target="_blank"
				rel="noopener noreferrer"
				className="inline-flex w-fit items-center gap-1.5 font-medium text-primary text-xs hover:underline"
			>
				{isCommit ? (
					<GitCommitHorizontalIcon
						aria-hidden="true"
						className="size-3.5"
					/>
				) : (
					<ExternalLinkIcon aria-hidden="true" className="size-3.5" />
				)}
				{isCommit ? "View commit" : "View source"}
			</a>
		);
	}
	if (finding.storyId) {
		const featureId = finding.location?.match(/\b[FB]-\d+\b/)?.[0];
		return (
			<Link
				href={storyHref(finding.storyId)}
				className="inline-flex w-fit items-center gap-1.5 font-medium text-primary text-xs hover:underline"
			>
				<ArrowRightIcon aria-hidden="true" className="size-3" />
				View {featureId ?? "feature"}
			</Link>
		);
	}
	return null;
}

/** Icon per producing scanner engine — mirrors the config card's scanner row. */
const FINDING_SCANNER_ICON: Record<FindingScanner, LucideIcon> = {
	AI_SECURITY: SparklesIcon,
	AI_ACCESSIBILITY: SparklesIcon,
	SEMGREP: ScanSearchIcon,
	GIT_HISTORY: KeyRoundIcon,
};

/**
 * Compact chip naming the engine that captured a finding (AI review / Semgrep /
 * Git history), shown in the always-visible badges row. The label is
 * self-describing; the expanded body ({@link ScannerDetail}) carries the fuller
 * explanation, so this chip needs no tooltip (keeps it keyboard-accessible).
 */
function ScannerChip({ scanner }: { scanner: FindingScanner }) {
	const Icon = FINDING_SCANNER_ICON[scanner];
	return (
		<Badge variant="outline" className="gap-1 font-normal">
			<Icon aria-hidden="true" className="size-3" />
			{FINDING_SCANNER_LABEL[scanner]}
		</Badge>
	);
}

/**
 * Plain-language "which scanner found this" line for the expanded finding body —
 * reinforces the chip with the engine's full description as fully-visible text,
 * so the attribution is reachable without hovering.
 */
function ScannerDetail({ scanner }: { scanner: FindingScanner }) {
	const Icon = FINDING_SCANNER_ICON[scanner];
	return (
		<p className="flex items-start gap-1.5 text-muted-foreground text-xs">
			<Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
			<span className="break-words">
				<span className="font-medium text-foreground">
					Detected by {FINDING_SCANNER_LABEL[scanner]}
				</span>{" "}
				— {FINDING_SCANNER_DESCRIPTION[scanner]}
			</span>
		</p>
	);
}

/**
 * Plain-language confidence line in the expanded body — reinforces the
 * confidence chip with how to read it, as fully-visible text (not color-alone).
 * Hidden for legacy rows with no confidence.
 */
function ConfidenceDetail({
	confidence,
}: {
	confidence: number | null | undefined;
}) {
	const level = confidenceLevel(confidence);
	if (!level) {
		return null;
	}
	const help =
		level === "HIGH"
			? "The scanner was confident this is a real issue (evidence-backed)."
			: level === "MEDIUM"
				? "The scanner was moderately confident — worth a look to confirm."
				: "The scanner was unsure — verify before acting, or run a review.";
	return (
		<p className="flex items-start gap-1.5 text-muted-foreground text-xs">
			<ConfidenceChip confidence={confidence} className="shrink-0" />
			<span className="break-words pt-px">{help}</span>
		</p>
	);
}

function BlockedChip({
	identifier,
	reason,
	href,
}: {
	identifier: string;
	reason: string | null;
	href: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Badge variant="destructive" asChild className="gap-1">
					<Link href={href}>
						<OctagonXIcon aria-hidden="true" className="size-3" />
						Blocked → {identifier}
					</Link>
				</Badge>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs">
				{reason || "This work item is blocked."}
			</TooltipContent>
		</Tooltip>
	);
}

function CleanScanCard({
	completedAt,
	modelName,
}: {
	completedAt: Date | null;
	modelName: string | null;
}) {
	const relative = completedAt
		? formatDistanceToNow(completedAt, { addSuffix: true })
		: null;
	const absolute = completedAt ? completedAt.toLocaleString() : null;

	return (
		<Card
			className={cn(
				"border-secondary/30 bg-secondary/5",
				"text-card-foreground",
			)}
		>
			<CardContent className="flex items-start gap-3 p-5">
				<div className="rounded-full bg-secondary/10 p-2">
					<ShieldCheckIcon
						aria-hidden="true"
						className="size-5 text-secondary"
					/>
				</div>
				<div className="min-w-0">
					<p className="font-medium text-foreground">
						Clean scan — no issues found
					</p>
					<p className="mt-1 text-muted-foreground text-sm">
						{relative ? (
							<>
								Clean scan ·{" "}
								<time
									dateTime={completedAt?.toISOString()}
									title={absolute ?? undefined}
								>
									{relative}
								</time>
							</>
						) : (
							"Clean scan"
						)}
						{modelName ? (
							<>
								{" · "}
								<span className="font-mono">{modelName}</span>
							</>
						) : null}
					</p>
				</div>
			</CardContent>
		</Card>
	);
}

function EmptyFindings({
	clean,
	hasScan,
	branch,
}: {
	clean: boolean;
	hasScan: boolean;
	branch?: string;
}) {
	if (clean) {
		// Clean-scan card already covers the "all good" case above.
		return null;
	}
	return (
		<div className="rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
			<p className="text-muted-foreground text-sm">
				{hasScan
					? "No findings match the current filters."
					: branch
						? `No scans yet on branch "${branch}". Run a scan to check this branch.`
						: "No findings yet. Run a scan to surface security and accessibility issues."}
			</p>
		</div>
	);
}
