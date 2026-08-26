"use client";

/**
 * ReleaseNotesPanel — derives "what shipped" from merged GitHub PRs in the
 * brief window and renders Prod and Staging releases.
 *
 * Deploy model assumed (configurable later if needed):
 *   - PRs merged into `main` deploy to staging.
 *   - PRs merged into `production` deploy to prod. These are typically
 *     "main → production" umbrella merges that batch up everything that
 *     landed on main since the previous prod merge — the umbrella PR title
 *     itself is uninformative ("main -> production"), so we surface the
 *     constituent staging PRs instead.
 *
 * Bucketing:
 *   - Sort prod merges (baseRef === "production") chronologically.
 *   - For each prod merge P_i, contents = staging PRs merged in
 *     (P_{i-1}.merged_at, P_i.merged_at]. P_0 uses -Infinity so we capture
 *     everything in window before the first prod merge.
 *   - Staging PRs merged *after* the latest prod merge are unreleased — they
 *     sit in the "Staging" section as "merged to main, not yet in prod".
 *
 * Linkage strategy (Option A — pure derivation):
 *   - Build (storyIdentifier → storyTitle) map from sections.storyChanges.
 *   - Regex-match a story identifier in each PR title (/\b[A-Z]+-\d+\b/).
 *   - Group PRs by feature; unmatched PRs fall into a categorized
 *     "Other changes" bucket (Conventional-Commit prefix groups, with
 *     dependency bumps collapsed to a single count).
 *
 * Renders nothing when there are no merged PRs in either bucket.
 */

import type {
	DeploymentItem,
	GithubItem,
	ReleaseNotesSummary,
	StoryChangeItem,
} from "@repo/database";
import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { cn } from "@ui/lib";
import { ChevronRightIcon, EyeOff, RocketIcon } from "lucide-react";
import { createContext, useContext, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ExclusionRow } from "./DailyBriefPage";
import { formatRelativeOccurredAt, occurredAtMs } from "./format";

const PROD_BASE_REF = "production";
const STORY_ID_RE = /\b([A-Z]+-\d+)\b/;
const CONVENTIONAL_RE =
	/^(feat|fix|chore|refactor|docs|test|ci|perf|style|build|revert)(?:\(([^)]+)\))?!?:\s*(.+)$/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OtherCategory =
	| "feature"
	| "fix"
	| "refactor"
	| "docs"
	| "test"
	| "ci"
	| "chore"
	| "deps"
	| "uncategorized";

interface CategorizedPr {
	pr: GithubItem;
	cleanedTitle: string;
}

interface FeatureGroup {
	identifier: string;
	storyTitle?: string;
	prs: GithubItem[];
}

interface ReleaseBucket {
	features: FeatureGroup[];
	otherByCategory: Map<OtherCategory, CategorizedPr[]>;
	otherCount: number;
	totalPrCount: number;
}

interface ProdRelease {
	umbrellaPr: GithubItem;
	contents: ReleaseBucket;
}

/** Identifies what to hide — a specific PR, or every PR for a story. */
export type HideTarget =
	| { kind: "pr"; repoFullName: string; prNumber: number }
	| { kind: "story"; storyIdentifier: string };

// ---------------------------------------------------------------------------
// Edit context
// ---------------------------------------------------------------------------

/**
 * Carries the hide/unhide affordance down to the deeply-nested `PrLine` /
 * `FeatureRow` leaves without threading `canEdit`/`onHide` through every
 * intermediate helper (`ProdSection` → `ProdReleaseBlock` → `FeatureList` →
 * `FeatureRow`, and the `OtherChanges` → `CategoryGroup` → `PrLine` chain).
 * Fed only from this panel's own props — no oRPC/react-query — so the panel
 * stays pure and its mock-free sibling tests keep passing.
 */
interface ReleaseNotesEditContextValue {
	canEdit: boolean;
	onHide?: (target: HideTarget) => void;
}
const ReleaseNotesEditContext = createContext<ReleaseNotesEditContextValue>({
	canEdit: false,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildIdentifierToTitle(
	storyChanges: StoryChangeItem[] | undefined,
): Map<string, string> {
	const map = new Map<string, string>();
	for (const s of storyChanges ?? []) {
		if (s.storyIdentifier && !map.has(s.storyIdentifier)) {
			map.set(s.storyIdentifier, s.title);
		}
	}
	return map;
}

function categorizeOtherPr(pr: GithubItem): {
	category: OtherCategory;
	cleanedTitle: string;
} {
	const isBot = /dependabot|renovate/i.test(pr.author ?? "");
	const m = pr.title.match(CONVENTIONAL_RE);
	if (m) {
		const type = (m[1] ?? "").toLowerCase();
		const scope = (m[2] ?? "").toLowerCase();
		const rest = m[3] ?? pr.title;
		if (scope === "deps" || /^bump\b/i.test(rest)) {
			return { category: "deps", cleanedTitle: rest };
		}
		const typeToCategory: Record<string, OtherCategory> = {
			feat: "feature",
			fix: "fix",
			chore: "chore",
			refactor: "refactor",
			docs: "docs",
			test: "test",
			ci: "ci",
			perf: "refactor",
			style: "chore",
			build: "ci",
			revert: "chore",
		};
		return {
			category: typeToCategory[type] ?? "uncategorized",
			cleanedTitle: rest,
		};
	}
	if (isBot || /^bump\b/i.test(pr.title)) {
		return { category: "deps", cleanedTitle: pr.title };
	}
	return { category: "uncategorized", cleanedTitle: pr.title };
}

function groupMergedPrs(
	mergedPrs: GithubItem[],
	identifierToTitle: Map<string, string>,
): ReleaseBucket {
	const featureMap = new Map<string, FeatureGroup>();
	const otherByCategory = new Map<OtherCategory, CategorizedPr[]>();

	for (const pr of mergedPrs) {
		const match = pr.title.match(STORY_ID_RE);
		const identifier = match?.[1];
		if (identifier) {
			let group = featureMap.get(identifier);
			if (!group) {
				group = {
					identifier,
					storyTitle: identifierToTitle.get(identifier),
					prs: [],
				};
				featureMap.set(identifier, group);
			}
			group.prs.push(pr);
		} else {
			const { category, cleanedTitle } = categorizeOtherPr(pr);
			let list = otherByCategory.get(category);
			if (!list) {
				list = [];
				otherByCategory.set(category, list);
			}
			list.push({ pr, cleanedTitle });
		}
	}

	for (const group of featureMap.values()) {
		group.prs.sort((a, b) => occurredAtMs(b) - occurredAtMs(a));
	}
	const features = [...featureMap.values()].sort(
		(a, b) => occurredAtMs(b.prs[0]) - occurredAtMs(a.prs[0]),
	);
	for (const list of otherByCategory.values()) {
		list.sort((a, b) => occurredAtMs(b.pr) - occurredAtMs(a.pr));
	}

	let otherCount = 0;
	for (const list of otherByCategory.values()) {
		otherCount += list.length;
	}

	return {
		features,
		otherByCategory,
		otherCount,
		totalPrCount: mergedPrs.length,
	};
}

function partitionReleases(
	mergedItems: GithubItem[],
	identifierToTitle: Map<string, string>,
): { prodReleases: ProdRelease[]; staging: ReleaseBucket } {
	const prodMerges = mergedItems
		.filter((g) => g.baseRef === PROD_BASE_REF)
		.sort((a, b) => occurredAtMs(a) - occurredAtMs(b));
	const stagingMerges = mergedItems.filter(
		(g) => g.baseRef !== PROD_BASE_REF,
	);

	if (prodMerges.length === 0) {
		return {
			prodReleases: [],
			staging: groupMergedPrs(stagingMerges, identifierToTitle),
		};
	}

	const prodReleases: ProdRelease[] = prodMerges.map((prodPr, i) => {
		const prevProdTime =
			i > 0 ? occurredAtMs(prodMerges[i - 1]) : Number.NEGATIVE_INFINITY;
		const thisProdTime = occurredAtMs(prodPr);
		const included = stagingMerges.filter((s) => {
			const t = occurredAtMs(s);
			return t > prevProdTime && t <= thisProdTime;
		});
		return {
			umbrellaPr: prodPr,
			contents: groupMergedPrs(included, identifierToTitle),
		};
	});

	const lastProdTime = occurredAtMs(prodMerges[prodMerges.length - 1]);
	const unpromoted = stagingMerges.filter(
		(s) => occurredAtMs(s) > lastProdTime,
	);

	// Newest prod release first.
	prodReleases.reverse();

	return {
		prodReleases,
		staging: groupMergedPrs(unpromoted, identifierToTitle),
	};
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ReleaseNotesPanelProps {
	github: GithubItem[] | undefined;
	storyChanges: StoryChangeItem[] | undefined;
	summary?: ReleaseNotesSummary;
	latestProdRelease?: DeploymentItem;
	latestProdReleasesByRepo?: DeploymentItem[];
	/** Whether the current user can hide/unhide release-notes exclusions. */
	canEdit?: boolean;
	/** Current exclusions for this project — renders the Manage-hidden footer when non-empty. */
	exclusions?: ExclusionRow[];
	onHide?: (target: HideTarget) => void;
	onUnhide?: (id: string) => void;
}

export function ReleaseNotesPanel({
	github,
	storyChanges,
	summary,
	latestProdRelease,
	latestProdReleasesByRepo,
	canEdit = false,
	exclusions = [],
	onHide,
	onUnhide,
}: ReleaseNotesPanelProps) {
	const { prodReleases, staging } = useMemo(() => {
		const merged = (github ?? []).filter((g) => g.kind === "pr_merged");
		const identifierToTitle = buildIdentifierToTitle(storyChanges);
		return partitionReleases(merged, identifierToTitle);
	}, [github, storyChanges]);

	const hasProdReleases = prodReleases.length > 0;
	const hasStaging = staging.totalPrCount > 0;
	const hasLatestAnchor =
		(latestProdReleasesByRepo && latestProdReleasesByRepo.length > 0) ||
		Boolean(latestProdRelease);
	// An editor with manageable exclusions still needs the panel rendered even
	// when every PR in the window happens to be hidden — otherwise there is no
	// path back to the Manage-hidden footer to unhide them.
	const hasManageableExclusions = canEdit && exclusions.length > 0;
	if (
		!hasProdReleases &&
		!hasStaging &&
		!hasLatestAnchor &&
		!hasManageableExclusions
	) {
		return null;
	}

	return (
		<section
			aria-label="Release notes"
			className="rounded-2xl border border-border bg-card p-6"
		>
			<header className="flex items-center gap-2">
				<RocketIcon
					className="size-4 text-muted-foreground"
					aria-hidden="true"
				/>
				<span className="editorial-label">Release notes</span>
			</header>

			<ReleaseNotesEditContext.Provider value={{ canEdit, onHide }}>
				<div className="mt-5 space-y-6">
					<ProdSection
						releases={prodReleases}
						summary={summary?.prod}
						latestProdRelease={latestProdRelease}
						latestProdReleasesByRepo={latestProdReleasesByRepo}
					/>
					<StagingSection
						bucket={staging}
						hasProdReleases={hasProdReleases}
						summary={summary?.staging}
					/>
				</div>
			</ReleaseNotesEditContext.Provider>

			{hasManageableExclusions ? (
				<ManageHiddenFooter
					exclusions={exclusions}
					onUnhide={onUnhide}
				/>
			) : null}
		</section>
	);
}

function SummaryBlurb({ text }: { text: string }) {
	return <p className="mt-3 text-sm leading-6 text-foreground/85">{text}</p>;
}

function getProdHint(releaseCount: number): string {
	if (releaseCount > 1) {
		return `${releaseCount} releases`;
	}
	if (releaseCount === 1) {
		return "merged into production";
	}
	return "no production deploys";
}

function ProdSection({
	releases,
	summary,
	latestProdRelease,
	latestProdReleasesByRepo,
}: {
	releases: ProdRelease[];
	summary?: string;
	latestProdRelease?: DeploymentItem;
	latestProdReleasesByRepo?: DeploymentItem[];
}) {
	const totalPrs = releases.reduce(
		(sum, r) => sum + r.contents.totalPrCount,
		0,
	);

	// Render precedence for the window-independent anchor: prefer the per-repo
	// array (newest-first; re-sorted defensively for old/uncertain inputs), then
	// fall back to the single global-newest field (old briefs / post-rollback).
	const perRepo =
		latestProdReleasesByRepo && latestProdReleasesByRepo.length > 0
			? [...latestProdReleasesByRepo].sort(
					(a, b) =>
						new Date(b.occurredAt).getTime() -
							new Date(a.occurredAt).getTime() ||
						a.repoFullName.localeCompare(b.repoFullName),
				)
			: latestProdRelease
				? [latestProdRelease]
				: [];

	return (
		<section aria-label="Prod releases">
			<EnvHeader
				tone="prod"
				label="Prod release"
				hint={
					releases.length > 0
						? getProdHint(releases.length)
						: perRepo.length > 0
							? "latest production release"
							: getProdHint(0)
				}
				count={totalPrs}
				countLabel="PR"
			/>

			{summary ? <SummaryBlurb text={summary} /> : null}

			{releases.length === 0 ? (
				perRepo.length > 0 ? (
					<div className="mt-3 space-y-5">
						{perRepo.map((item) => (
							<LatestReleaseBlock
								key={`${item.repoFullName}-${item.tagName}`}
								item={item}
							/>
						))}
					</div>
				) : (
					<p className="mt-3 text-sm text-muted-foreground">
						Nothing shipped to prod in this window.
					</p>
				)
			) : (
				<div className="mt-3 space-y-5">
					{releases.map((release) => (
						<ProdReleaseBlock
							key={`${release.umbrellaPr.repoFullName}-${release.umbrellaPr.prNumber}`}
							release={release}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function LatestReleaseBlock({ item }: { item: DeploymentItem }) {
	return (
		<article className="mt-3 rounded-md border border-border/70 bg-muted/30 p-4">
			<header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="inline-flex items-center rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
						{item.tagName}
					</span>
					<a
						href={item.url}
						target="_blank"
						rel="noreferrer noopener"
						className="min-w-0 truncate font-sans text-sm font-medium text-foreground hover:text-primary hover:underline"
					>
						{item.title}
					</a>
				</div>
				<span className="text-[11px] text-muted-foreground">
					{item.repoFullName}
					{item.author ? ` · ${item.author}` : ""} ·{" "}
					{formatRelativeOccurredAt(item.occurredAt)}
				</span>
			</header>
			<div className="mt-2">
				{item.body ? (
					<Collapsible className="group/collapsible">
						<CollapsibleTrigger className="flex items-center gap-1.5 rounded text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
							<ChevronRightIcon
								aria-hidden="true"
								className="size-3 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90"
							/>
							Release notes
						</CollapsibleTrigger>
						<CollapsibleContent>
							<div className="prose prose-sm mt-2 max-w-none text-foreground/90 prose-headings:text-foreground prose-a:text-primary">
								<ReactMarkdown remarkPlugins={[remarkGfm]}>
									{item.body}
								</ReactMarkdown>
							</div>
						</CollapsibleContent>
					</Collapsible>
				) : (
					<p className="text-xs italic text-muted-foreground">
						No release notes provided.
					</p>
				)}
			</div>
		</article>
	);
}

function ProdReleaseBlock({ release }: { release: ProdRelease }) {
	const umbrella = release.umbrellaPr;
	return (
		<article className="rounded-md border border-border/70 bg-muted/30 p-4">
			<header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<p className="font-sans text-sm font-medium text-foreground">
					Released{" "}
					<a
						href={umbrella.url}
						target="_blank"
						rel="noreferrer noopener"
						className="font-mono text-xs text-muted-foreground underline-offset-4 hover:text-primary hover:underline"
					>
						via #{umbrella.prNumber}
					</a>{" "}
					<span className="text-xs text-muted-foreground">
						· {formatRelativeOccurredAt(umbrella.occurredAt)}
					</span>
				</p>
				<span className="font-mono text-[11px] text-muted-foreground">
					{release.contents.totalPrCount}{" "}
					{release.contents.totalPrCount === 1 ? "PR" : "PRs"}
				</span>
			</header>

			{release.contents.totalPrCount === 0 ? (
				<p className="mt-2 text-xs italic text-muted-foreground">
					No prior staging PRs found in this window — release contents
					may predate the brief window.
				</p>
			) : (
				<div className="mt-3 space-y-3">
					<FeatureList features={release.contents.features} />
					<OtherChanges
						byCategory={release.contents.otherByCategory}
						count={release.contents.otherCount}
					/>
				</div>
			)}
		</article>
	);
}

function StagingSection({
	bucket,
	hasProdReleases,
	summary,
}: {
	bucket: ReleaseBucket;
	hasProdReleases: boolean;
	summary?: string;
}) {
	const hint = hasProdReleases
		? "merged to main, not yet in prod"
		: "merged to main";
	return (
		<section aria-label="Staging release">
			<EnvHeader
				tone="staging"
				label="Staging"
				hint={hint}
				count={bucket.totalPrCount}
				countLabel="PR"
			/>

			{summary ? <SummaryBlurb text={summary} /> : null}

			{bucket.totalPrCount === 0 ? (
				<p className="mt-3 text-sm text-muted-foreground">
					{hasProdReleases
						? "Everything merged to main this window has shipped to prod."
						: "Nothing merged to main in this window."}
				</p>
			) : (
				<div className="mt-3 space-y-3">
					<FeatureList features={bucket.features} />
					<OtherChanges
						byCategory={bucket.otherByCategory}
						count={bucket.otherCount}
					/>
				</div>
			)}
		</section>
	);
}

function EnvHeader({
	tone,
	label,
	hint,
	count,
	countLabel,
}: {
	tone: "prod" | "staging";
	label: string;
	hint: string;
	count: number;
	countLabel: string;
}) {
	const accentBar = tone === "prod" ? "bg-primary" : "bg-muted-foreground/40";
	return (
		<header className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-2">
			<div className="flex items-center gap-2">
				<span
					aria-hidden="true"
					className={cn("h-3 w-1 rounded-sm", accentBar)}
				/>
				<h3 className="font-sans text-sm font-semibold uppercase tracking-[0.2em] text-foreground/85">
					{label}
				</h3>
				<span className="text-[11px] text-muted-foreground">
					{hint}
				</span>
			</div>
			<span className="font-mono text-xs text-muted-foreground">
				{count} {count === 1 ? countLabel : `${countLabel}s`}
			</span>
		</header>
	);
}

function FeatureList({ features }: { features: FeatureGroup[] }) {
	if (features.length === 0) {
		return null;
	}
	return (
		<ul className="space-y-3">
			{features.map((feature) => (
				<FeatureRow key={feature.identifier} feature={feature} />
			))}
		</ul>
	);
}

function FeatureRow({ feature }: { feature: FeatureGroup }) {
	const prCount = feature.prs.length;
	const { canEdit, onHide } = useContext(ReleaseNotesEditContext);
	return (
		<li className="border-l-2 border-border/60 pl-3">
			<Collapsible className="group/collapsible">
				<div className="flex items-start gap-1">
					<CollapsibleTrigger className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
						<ChevronRightIcon
							aria-hidden="true"
							className="size-3 shrink-0 self-center text-muted-foreground transition-transform group-data-[state=open]/collapsible:rotate-90"
						/>
						<span className="inline-flex items-center rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							{feature.identifier}
						</span>
						{feature.storyTitle ? (
							<p className="min-w-0 font-sans text-sm font-medium text-foreground">
								{feature.storyTitle}
							</p>
						) : (
							<p className="font-sans text-xs italic text-muted-foreground">
								(no story changes in this window)
							</p>
						)}
						<span className="ml-auto font-mono text-[11px] text-muted-foreground">
							{prCount} {prCount === 1 ? "PR" : "PRs"}
						</span>
					</CollapsibleTrigger>
					{canEdit && onHide ? (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive motion-safe:transition-colors"
							aria-label={`Hide feature ${feature.identifier} from release notes`}
							onClick={() =>
								onHide({
									kind: "story",
									storyIdentifier: feature.identifier,
								})
							}
						>
							<EyeOff className="size-3.5" aria-hidden="true" />
						</Button>
					) : null}
				</div>
				<CollapsibleContent>
					<ul className="mt-1.5 space-y-1 pl-5">
						{feature.prs.map((pr) => (
							<PrLine
								key={`${pr.repoFullName}-${pr.prNumber}`}
								pr={pr}
							/>
						))}
					</ul>
				</CollapsibleContent>
			</Collapsible>
		</li>
	);
}

const OTHER_CATEGORY_LABELS: Record<OtherCategory, string> = {
	feature: "Features",
	fix: "Fixes",
	refactor: "Refactors",
	docs: "Docs",
	test: "Tests",
	ci: "CI / build",
	chore: "Chores",
	deps: "Dependency updates",
	uncategorized: "Other",
};

const OTHER_CATEGORY_ORDER: OtherCategory[] = [
	"feature",
	"fix",
	"refactor",
	"docs",
	"test",
	"ci",
	"chore",
	"uncategorized",
	"deps",
];

function OtherChanges({
	byCategory,
	count,
}: {
	byCategory: Map<OtherCategory, CategorizedPr[]>;
	count: number;
}) {
	if (count === 0) {
		return null;
	}
	const visible = OTHER_CATEGORY_ORDER.flatMap((cat) => {
		const items = byCategory.get(cat);
		return items && items.length > 0 ? [{ cat, items }] : [];
	});
	if (visible.length === 0) {
		return null;
	}

	const summary = visible
		.map(
			({ cat, items }) =>
				`${items.length} ${OTHER_CATEGORY_LABELS[cat].toLowerCase()}`,
		)
		.join(" · ");

	return (
		<div className="border-l-2 border-border/60 pl-3">
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<p className="font-sans text-xs uppercase tracking-[0.16em] text-muted-foreground">
					Other changes
				</p>
				<p className="text-[11px] text-muted-foreground">{summary}</p>
			</div>
			<div className="mt-2 space-y-2.5">
				{visible.map(({ cat, items }) => (
					<CategoryGroup key={cat} category={cat} items={items} />
				))}
			</div>
		</div>
	);
}

function CategoryGroup({
	category,
	items,
}: {
	category: OtherCategory;
	items: CategorizedPr[];
}) {
	if (category === "deps") {
		return <DepsCategoryRow items={items} />;
	}
	return <CollapsibleCategoryGroup category={category} items={items} />;
}

function DepsCategoryRow({ items }: { items: CategorizedPr[] }) {
	// Dependency bumps are inherently uninteresting individually — collapse to
	// a single line with the count and the most recent timestamp.
	const latest = items[0]?.pr.occurredAt;
	return (
		<p className="text-xs text-muted-foreground">
			<span className="font-medium text-foreground/80">
				{items.length} dependency{" "}
				{items.length === 1 ? "update" : "updates"}
			</span>
			{latest ? (
				<span> · latest {formatRelativeOccurredAt(latest)}</span>
			) : null}
		</p>
	);
}

function CollapsibleCategoryGroup({
	category,
	items,
}: {
	category: OtherCategory;
	items: CategorizedPr[];
}) {
	return (
		<Collapsible className="group/collapsible">
			<CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
				<ChevronRightIcon
					aria-hidden="true"
					className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/collapsible:rotate-90"
				/>
				<span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/70">
					{OTHER_CATEGORY_LABELS[category]} ({items.length})
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<ul className="mt-1 space-y-1 pl-5">
					{items.map(({ pr, cleanedTitle }) => (
						<PrLine
							key={`${pr.repoFullName}-${pr.prNumber}`}
							pr={pr}
							displayTitle={cleanedTitle}
						/>
					))}
				</ul>
			</CollapsibleContent>
		</Collapsible>
	);
}

function PrLine({
	pr,
	displayTitle,
}: {
	pr: GithubItem;
	displayTitle?: string;
}) {
	const { canEdit, onHide } = useContext(ReleaseNotesEditContext);
	return (
		<li className="flex items-baseline justify-between gap-2 text-xs leading-5">
			<span className="min-w-0">
				<a
					href={pr.url}
					target="_blank"
					rel="noreferrer noopener"
					className="group inline-flex items-baseline gap-1.5 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
				>
					<span className="font-mono text-[11px] text-muted-foreground">
						#{pr.prNumber}
					</span>
					<span className="text-foreground/90 group-hover:text-primary">
						{displayTitle ?? pr.title}
					</span>
				</a>
				<span className="ml-1.5 text-[11px] text-muted-foreground">
					· {pr.repoFullName}
					{pr.author ? ` · ${pr.author}` : ""} ·{" "}
					{formatRelativeOccurredAt(pr.occurredAt)}
				</span>
			</span>
			{canEdit && onHide ? (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive motion-safe:transition-colors"
					aria-label="Hide from release notes"
					onClick={() =>
						onHide({
							kind: "pr",
							repoFullName: pr.repoFullName,
							prNumber: pr.prNumber,
						})
					}
				>
					<EyeOff className="size-3" aria-hidden="true" />
				</Button>
			) : null}
		</li>
	);
}

function ManageHiddenFooter({
	exclusions,
	onUnhide,
}: {
	exclusions: ExclusionRow[];
	onUnhide?: (id: string) => void;
}) {
	return (
		<Collapsible className="group/collapsible mt-6 border-t border-border/60 pt-4">
			<CollapsibleTrigger className="flex items-center gap-1.5 rounded text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
				<ChevronRightIcon
					aria-hidden="true"
					className="size-3 shrink-0 motion-safe:transition-transform group-data-[state=open]/collapsible:rotate-90"
				/>
				{exclusions.length} {exclusions.length === 1 ? "item" : "items"}{" "}
				hidden from release notes
			</CollapsibleTrigger>
			<CollapsibleContent>
				<ul className="mt-2 space-y-1.5 pl-5">
					{exclusions.map((exclusion) => (
						<li
							key={exclusion.id}
							className="flex items-baseline justify-between gap-2 text-xs leading-5"
						>
							<span className="min-w-0 text-foreground/85">
								{exclusion.kind === "pr" ? (
									<>
										<span className="font-mono text-[11px] text-muted-foreground">
											#{exclusion.prNumber}
										</span>{" "}
										· {exclusion.repoFullName}
									</>
								) : (
									<span className="font-mono text-[11px] text-muted-foreground">
										{exclusion.storyIdentifier}
									</span>
								)}
								{exclusion.reason ? (
									<span className="text-muted-foreground">
										{" "}
										— {exclusion.reason}
									</span>
								) : null}
							</span>
							{onUnhide ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-6 shrink-0 px-2 text-[11px] text-muted-foreground hover:text-primary motion-safe:transition-colors"
									onClick={() => onUnhide(exclusion.id)}
								>
									Unhide
								</Button>
							) : null}
						</li>
					))}
				</ul>
			</CollapsibleContent>
		</Collapsible>
	);
}
