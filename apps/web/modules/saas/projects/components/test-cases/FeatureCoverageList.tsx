"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import {
	buildStoryDetailsRoute,
	buildStoryQaRoute,
} from "@saas/projects/lib/stories/routes";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { SearchInput } from "@ui/components/search-input";
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
import { Loader2Icon, SearchIcon, TargetIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useDebounceValue } from "usehooks-ts";
import { type TestResult, TONE_CLASSES } from "./constants";
import {
	COVERAGE_STATE_I18N_KEY,
	COVERAGE_STATE_TONE,
	type FeatureCoverageState,
	featurePassRateView,
} from "./feature-coverage";
import { PassRateBar, PassRateValue } from "./PassRateBar";
import { featureStageLabel } from "./story-stage-label";

/** Page size for the offset-paginated coverage list (procedure caps `limit` at 200). */
const PAGE_SIZE = 50;

/** Debounce for the type-ahead: the search runs server-side, so don't fire per keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

/** Sentinel for "both kinds" — the `kind` input is omitted entirely when unset. */
const ANY_KIND = "ALL" as const;
type KindFilter = "FEATURE" | "BUG" | typeof ANY_KIND;

type Props = {
	projectId: string;
	/** Filters the Cases segment to this feature and switches to it. */
};

/**
 * Features / coverage: one row per work item, showing how well it is tested.
 *
 * Every number here is rendered EXACTLY as `listFeatureCoverage` returns it. In
 * particular the AC figure is `distinctAcRefs` — how many distinct acceptance
 * criteria the linked cases actually reference — and NOT a "covered X of N"
 * ratio: a story's acceptance criteria are unvalidated free text with no parser,
 * so N does not exist as a computable number and any ratio would be invented
 * here. For the same reason coverage is binary (COVERED / UNCOVERED) with no
 * PARTIAL state. Filtering, searching and paging are all server-side.
 */
export function FeatureCoverageList({ projectId }: Props) {
	const { basePath } = useOrganizationContext();
	const t = useTranslations("projects.testCases");

	const [search, setSearch] = useState("");
	const [debouncedSearch] = useDebounceValue(search, SEARCH_DEBOUNCE_MS);
	const [kind, setKind] = useState<KindFilter>(ANY_KIND);
	const [uncoveredOnly, setUncoveredOnly] = useState(false);

	const trimmedSearch = debouncedSearch.trim();
	const query = useInfiniteQuery(
		orpc.projects.testCases.featureCoverage.infiniteOptions({
			input: (offset: number) => ({
				projectId,
				...(trimmedSearch ? { search: trimmedSearch } : {}),
				...(kind === ANY_KIND ? {} : { kind }),
				...(uncoveredOnly ? { uncoveredOnly: true } : {}),
				limit: PAGE_SIZE,
				offset,
			}),
			initialPageParam: 0,
			getNextPageParam: (lastPage, allPages) => {
				const loaded = allPages.reduce(
					(sum, page) => sum + page.items.length,
					0,
				);
				return loaded < lastPage.total ? loaded : undefined;
			},
		}),
	);

	const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
	const total = query.data?.pages[0]?.total ?? 0;
	const hasFilters =
		trimmedSearch !== "" || kind !== ANY_KIND || uncoveredOnly;

	return (
		<div className="space-y-4">
			<div>
				<p className="app-editorial-label">{t("features.heading")}</p>
				<p className="mt-1 max-w-2xl text-muted-foreground text-sm">
					{t("features.subtitle")}
				</p>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<div className="relative w-full sm:max-w-xs">
					<SearchIcon
						aria-hidden="true"
						className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground"
					/>
					<SearchInput
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder={t("features.searchPlaceholder")}
						aria-label={t("features.searchAria")}
						className="h-9 pl-9"
					/>
				</div>

				<Select
					value={kind}
					onValueChange={(v) => setKind(v as KindFilter)}
				>
					<SelectTrigger
						className="h-9 w-[9.5rem]"
						aria-label={t("features.kindAria")}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ANY_KIND}>
							{t("features.allKinds")}
						</SelectItem>
						<SelectItem value="FEATURE">
							{t("features.kindFeature")}
						</SelectItem>
						<SelectItem value="BUG">
							{t("features.kindBug")}
						</SelectItem>
					</SelectContent>
				</Select>

				{/* A toggle, not a sort: the server answers "which features have no
				    live cases" exactly, across the whole project rather than the
				    loaded page. */}
				<Button
					type="button"
					variant={uncoveredOnly ? "primary" : "outline"}
					size="sm"
					aria-pressed={uncoveredOnly}
					onClick={() => setUncoveredOnly((prev) => !prev)}
					className="h-9"
				>
					<TargetIcon className="mr-2 size-4" aria-hidden="true" />
					{t("features.uncoveredOnly")}
				</Button>

				<span className="ml-auto text-muted-foreground text-xs tabular-nums">
					{rows.length < total
						? t("filters.showingOfTotal", {
								shown: rows.length,
								total,
							})
						: t("features.featureCount", { count: total })}
				</span>
			</div>

			{query.isLoading ? (
				<div className="flex items-center justify-center py-16 text-muted-foreground">
					<Loader2Icon className="size-5 motion-safe:animate-spin" />
				</div>
			) : query.isError ? (
				<div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
					<p className="text-muted-foreground text-sm">
						{t("errors.featuresFailed")}
					</p>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => query.refetch()}
					>
						{t("errors.retry")}
					</Button>
				</div>
			) : rows.length === 0 ? (
				<div
					className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center"
					style={{
						backgroundImage:
							"radial-gradient(circle, color-mix(in srgb, var(--muted-foreground) 13%, transparent) 1px, transparent 1px)",
						backgroundSize: "32px 32px",
					}}
				>
					<TargetIcon className="size-8 text-muted-foreground/60" />
					<h3 className="font-serif text-xl font-normal">
						{hasFilters
							? t("features.emptyFiltered")
							: t("features.empty")}
					</h3>
				</div>
			) : (
				<>
					<ul className="space-y-1.5">
						{rows.map((row) => (
							<li key={row.storyId}>
								<FeatureCoverageRowItem
									row={row}
									href={
										// A FEATURE opens on its Testing tab,
										// which is what the tooltip promises and
										// where the criterion-to-case pairing
										// lives. Bugs have no such tab, so they
										// open on their details page.
										row.kind === "FEATURE"
											? buildStoryQaRoute(
													basePath,
													projectId,
													row.storyId,
												)
											: buildStoryDetailsRoute(
													basePath,
													projectId,
													row.storyId,
												)
									}
								/>
							</li>
						))}
					</ul>
					{query.hasNextPage && (
						<div className="flex justify-center pt-1">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => query.fetchNextPage()}
								disabled={query.isFetchingNextPage}
								className="gap-1.5 text-muted-foreground hover:text-foreground"
							>
								{query.isFetchingNextPage && (
									<Loader2Icon
										aria-hidden="true"
										className="size-3.5 motion-safe:animate-spin"
									/>
								)}
								{t("actions.loadMore")}
							</Button>
						</div>
					)}
				</>
			)}
		</div>
	);
}

/** The row shape `listFeatureCoverage` returns (extra API fields are ignored). */
type CoverageRow = {
	storyId: string;
	identifier: string;
	title: string;
	kind: string;
	draftingStage: string;
	caseCount: number;
	// Keyed off the shared TestResult union rather than re-listing its members:
	// spelling them out here is how this row silently missed SKIPPED when the
	// result vocabulary grew.
	resultCounts: Record<TestResult, number>;
	distinctAcRefs: number;
	coverageState: FeatureCoverageState;
};

/**
 * One feature's coverage. The title is the click target and stretches over the
 * whole row (`after:inset-0`), so the row has exactly ONE interactive element —
 * no nested buttons, and the accessible name is the feature itself.
 */
function FeatureCoverageRowItem({
	row,
	href,
}: {
	row: CoverageRow;
	/** The feature's own page. A real link, so it opens in a new tab and its
	 *  address can be copied — neither of which a click handler allows. */
	href: string;
}) {
	const t = useTranslations("projects.testCases");
	const tTooltip = useTranslations("tooltips.testCases");
	const view = featurePassRateView(row);
	const stageLabel = featureStageLabel(row.draftingStage);
	const coverageTone = TONE_CLASSES[COVERAGE_STATE_TONE[row.coverageState]];

	return (
		<div className="relative flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:border-primary/40 hover:bg-accent/50">
			{/* Identifiers are plain decimals shared by features and bugs — rendered
			    verbatim, never prefixed. The kind chip says what it points at. */}
			<span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
				{row.identifier}
			</span>

			<span className="min-w-0 flex-1 truncate font-medium text-sm">
				<Tooltip>
					<TooltipTrigger asChild>
						{/* No `aria-label` on purpose. The button's accessible name is its
							contents — the feature title — and an `aria-label` would replace
							it rather than add to it, dropping the visible label out of the
							accessible name (WCAG 2.5.3). The old native `title` did not have
							this problem: `title` is only a fallback when an element has no
							content. The tooltip now carries the "what happens on click"
							context that `title` used to. */}
						<Link
							href={href}
							className="block w-full truncate text-left after:absolute after:inset-0 after:rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{row.title}
						</Link>
					</TooltipTrigger>
					<TooltipContent>{tTooltip("openFeature")}</TooltipContent>
				</Tooltip>
			</span>

			{row.kind === "BUG" && (
				<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
					{t("featurePicker.bug")}
				</span>
			)}

			{stageLabel && (
				<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
					{stageLabel}
				</span>
			)}

			<span
				className={cn(
					"inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium text-foreground text-xs",
					coverageTone.pill,
				)}
			>
				<span
					aria-hidden="true"
					className={cn("size-1.5 rounded-full", coverageTone.dot)}
				/>
				{t(COVERAGE_STATE_I18N_KEY[row.coverageState])}
			</span>

			<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
				{t("caseCount", { count: row.caseCount })}
			</span>

			{/* Distinct acceptance criteria the linked cases REFERENCE — a tally of
			    what testers wrote down, deliberately not a ratio. */}
			<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
				{t("features.acRefCount", { count: row.distinctAcRefs })}
			</span>

			<div className="flex w-40 shrink-0 items-center gap-2">
				<PassRateBar view={view} className="flex-1" />
				<PassRateValue view={view} />
			</div>
		</div>
	);
}
