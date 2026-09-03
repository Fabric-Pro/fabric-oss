"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { AlertTriangleIcon, CheckCircle2Icon, StarIcon } from "lucide-react";
import { useState } from "react";
import { BlogPostPanel } from "./BlogPostPanel";
import { CaseStudyPanel } from "./CaseStudyPanel";
import type {
	GenerationTabInfo,
	GenerationTabState,
	Restrictions,
} from "./generation-tab-state";
import {
	isRestrictingThread,
	resolveGenerationTabStates,
	resolveRestrictions,
	restrictsPostType,
} from "./generation-tab-state";
import type { PlanningAnalysisDocument } from "./planning-analysis-content";
import { ShortPostPanel } from "./ShortPostPanel";
import type { TopicDecisionThread } from "./TopicQuestionsPanel";
import {
	GENERATION_ACTIVE_POST_TYPES,
	POST_TYPE_LABELS,
	type PostType,
} from "./topic-shared";

/**
 * One draft attempt as `listTopicDrafts` returns it (content excluded).
 *
 * Not exported: nothing outside this module names a single attempt — callers
 * pass whole `TopicDraftState` objects — and an export nobody imports is what
 * knip is there to catch.
 */
interface TopicDraftRow {
	id: string;
	postType: PostType;
	version: number;
	status: string;
	error: string | null;
	createdAt: string | Date;
	updatedAt: string | Date;
	isExpired?: boolean;
	/**
	 * The generated document, `null` until the attempt reaches READY.
	 *
	 * `unknown` rather than a shape: it is `Json?` on the row, and each content
	 * type stores a different document. The panel that renders one is the place
	 * that knows which, so each narrows it for itself — a union here would make
	 * every panel carry the other three's cases.
	 */
	content?: unknown;
}

export interface TopicDraftState {
	postType: PostType;
	latestAttempt: TopicDraftRow | null;
	latestReady: TopicDraftRow | null;
}

export interface TopicWorkingDraftState {
	postType: PostType;
	hasBody: boolean;
	/** The saved draft text. Shared project content, not author-private. */
	body: string;
	/**
	 * Which candidate the body came from. Nullable: the composite FK is
	 * `ON DELETE SET NULL ("sourceDraftId")`, so deleting a candidate keeps the
	 * body and forgets its origin.
	 */
	sourceDraftId: string | null;
	sourceOptionLabel: string | null;
	updatedAt: string | Date;
}

/**
 * The Topic Item Page's content-generation tab strip (Fizzy #1853, Phase 2B-1).
 *
 * Replaces 2A's `GenerationTabsPlaceholder`, whose own comment named itself
 * "the only thing later phases (2B/2C) still need to replace".
 *
 * 2B-1 made the Short Post / Tweet and Blog Post tabs SELECTABLE and gave each a
 * panel showing its recommendation context (FR6/FR7), the unresolved questions
 * that will constrain it (FR8/FR9) and whether a draft exists. 2B-2 gave the
 * short post its own panel, and 2B-3 gave the blog post one — two components
 * rather than one behind a flag, because their contracts differ where it
 * matters: blog generation SEEDS a working draft on the first run (DV5/FR21)
 * and centres on an editor, where the short post produces three candidates that
 * stay candidates until a person picks one (DV4).
 *
 * With both of them panelled, the generic draft-state block 2B-1 shipped had no
 * remaining caller — `TabsContent` renders only for
 * `GENERATION_ACTIVE_POST_TYPES`, and every member of that set now has a panel —
 * so it was removed here rather than left as unreachable code with a test that
 * could no longer reach it.
 *
 * 2C-1 (Fizzy #1854) activates Case Study with a panel of its own, for the same
 * reason the other two have theirs: it carries safety fields no other type has
 * — scaffold status, customer identity, results basis, two asset lists — and a
 * shared panel would have to hide them behind a type check anyway. Only
 * Stakeholder Email is still disabled and still reads "Coming soon"; 2A's FR50
 * holds for it, and the three types with a working panel are exempt from it.
 *
 * The unresolved-question list is computed PER PANEL rather than once for the
 * strip, and that is a 2C requirement rather than a tidy-up. See
 * `GenerationPanel`.
 */
export function GenerationTabs({
	projectId,
	organizationId,
	topicId,
	analysis,
	drafts,
	workingDrafts,
	decisionThreads,
	isLoading,
	hasError,
	canEdit,
}: {
	projectId: string;
	organizationId: string | null;
	topicId: string;
	analysis: PlanningAnalysisDocument | null;
	drafts: TopicDraftState[];
	workingDrafts: TopicWorkingDraftState[];
	decisionThreads: TopicDecisionThread[];
	isLoading: boolean;
	/** The drafts read failed. States degrade to AVAILABLE and say so. */
	hasError: boolean;
	/** PR2: a reader sees every panel, and none of the write controls. */
	canEdit: boolean;
}) {
	const [tab, setTab] = useState<PostType>("TWEET");

	const restrictions: Restrictions = resolveRestrictions(decisionThreads);

	// A type counts as generated when it has a READY candidate OR a working
	// draft. A user who saved a body has content for that type whatever became
	// of the candidate it came from.
	const generatedPostTypes = [
		...drafts.filter((d) => d.latestReady !== null).map((d) => d.postType),
		...workingDrafts.filter((w) => w.hasBody).map((w) => w.postType),
	];

	const tabs = resolveGenerationTabStates({
		analysis,
		// A failed read must not invent a generated state. Everything degrades
		// to AVAILABLE and the banner below says the state could not be loaded.
		generatedPostTypes: hasError ? [] : generatedPostTypes,
		restrictions,
	});
	const byPostType = new Map(tabs.map((t) => [t.postType, t]));

	return (
		<div className="space-y-2">
			<p className="editorial-label">Content generation</p>

			{hasError ? (
				<p
					className="text-muted-foreground text-xs"
					data-testid="generation-tabs-degraded"
				>
					We couldn't load this topic's draft state. The tabs below
					still open, but they can't say what has been generated yet.
				</p>
			) : null}

			<Tabs
				value={tab}
				onValueChange={(v) => setTab(v as PostType)}
				className="space-y-4"
			>
				<TabsList aria-label="Content generation" className="flex-wrap">
					{POST_TYPE_LABELS.map((t) => {
						const info = byPostType.get(t.value);
						const active = GENERATION_ACTIVE_POST_TYPES.has(
							t.value,
						);
						return (
							<TabsTrigger
								key={t.value}
								value={t.value}
								disabled={!active}
							>
								{t.generationLabel ?? t.label}
								{active && info ? (
									<StateBadge info={info} />
								) : (
									<Badge tone="muted">Coming soon</Badge>
								)}
							</TabsTrigger>
						);
					})}
				</TabsList>

				{POST_TYPE_LABELS.filter((t) =>
					GENERATION_ACTIVE_POST_TYPES.has(t.value),
				).map((t) => {
					const info = byPostType.get(t.value);
					return (
						<TabsContent
							key={t.value}
							value={t.value}
							className="space-y-4"
						>
							<GenerationPanel
								label={t.generationLabel ?? t.label}
								postType={t.value}
								projectId={projectId}
								organizationId={organizationId}
								topicId={topicId}
								canEdit={canEdit}
								info={info ?? null}
								draft={
									drafts.find(
										(d) => d.postType === t.value,
									) ?? null
								}
								working={
									workingDrafts.find(
										(w) => w.postType === t.value,
									) ?? null
								}
								decisionThreads={decisionThreads}
								isLoading={isLoading}
								hasAnalysis={analysis !== null}
							/>
						</TabsContent>
					);
				})}
			</Tabs>
		</div>
	);
}

const STATE_LABELS: Record<GenerationTabState, string | null> = {
	GENERATED: "Generated",
	NEEDS_CONFIRMATION: "Needs confirmation",
	RECOMMENDED: "Recommended",
	// A type that is available but not recommended "should not be visually
	// promoted" (the card), so it gets no badge. The accessible name below
	// still says "Available", so the state is not invisible to a screen-reader
	// user while being visible to a sighted one.
	AVAILABLE: null,
};

/**
 * The primary state badge, plus the independent caution marker.
 *
 * FR5: state must not rely on colour alone. Every badge carries TEXT and an
 * icon, and because a Radix `TabsTrigger` renders a `<button role="tab">` whose
 * accessible name is its text content, the words become part of what a screen
 * reader announces without any `aria-label` plumbing.
 *
 * The caution marker is rendered SEPARATELY from the primary badge rather than
 * as a fifth state: the four states are exclusive and `GENERATED` outranks the
 * cautious one, so folding them together would silence the warning on exactly
 * the tabs that already have content.
 */
function StateBadge({ info }: { info: GenerationTabInfo }) {
	const label = STATE_LABELS[info.state];
	const showCaution =
		info.needsAttention && info.state !== "NEEDS_CONFIRMATION";

	return (
		<>
			{label ? (
				<Badge
					tone={
						info.state === "GENERATED"
							? "done"
							: info.state === "NEEDS_CONFIRMATION"
								? "warn"
								: "recommend"
					}
				>
					{info.state === "GENERATED" ? (
						<CheckCircle2Icon
							className="size-3"
							aria-hidden="true"
						/>
					) : info.state === "NEEDS_CONFIRMATION" ? (
						<AlertTriangleIcon
							className="size-3"
							aria-hidden="true"
						/>
					) : (
						<StarIcon className="size-3" aria-hidden="true" />
					)}
					{label}
				</Badge>
			) : (
				<span className="sr-only">Available</span>
			)}
			{showCaution ? (
				<Badge tone="warn">
					<AlertTriangleIcon className="size-3" aria-hidden="true" />
					Needs confirmation
				</Badge>
			) : null}
		</>
	);
}

/** "CUSTOMER_NAME" -> "Customer name", for a question that carries no subject. */
function humanizeKind(kind: string | null): string {
	if (!kind || kind === "OTHER") {
		return "An unresolved approval";
	}
	const words = kind.toLowerCase().split("_").join(" ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function Badge({
	tone,
	children,
}: {
	tone: "done" | "warn" | "recommend" | "muted";
	children: React.ReactNode;
}) {
	const toneClass =
		tone === "done"
			? "border-secondary/40 bg-secondary/10 text-secondary"
			: tone === "warn"
				? "border-highlight/40 bg-highlight/10 text-highlight"
				: tone === "recommend"
					? "border-primary/40 bg-primary/10 text-primary"
					: "border-border bg-muted text-muted-foreground";
	return (
		<span
			className={`ml-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${toneClass}`}
		>
			{children}
		</span>
	);
}

/**
 * One content type's panel: why it was recommended, what is unresolved, and
 * what has been generated so far.
 */
function GenerationPanel({
	label,
	postType,
	projectId,
	organizationId,
	topicId,
	canEdit,
	info,
	draft,
	working,
	decisionThreads,
	isLoading,
	hasAnalysis,
}: {
	label: string;
	postType: PostType;
	projectId: string;
	organizationId: string | null;
	topicId: string;
	canEdit: boolean;
	info: GenerationTabInfo | null;
	draft: TopicDraftState | null;
	working: TopicWorkingDraftState | null;
	decisionThreads: TopicDecisionThread[];
	isLoading: boolean;
	hasAnalysis: boolean;
}) {
	// Only the questions that actually CONSTRAIN a draft OF THIS TYPE, and only
	// named by their subject — never by their full text. TWO lists rather than
	// one; the last paragraph below says why.
	//
	// Keyed on this panel's own `postType` via `restrictsPostType`, NOT computed
	// once for the whole strip. `EXTRA_RESTRICTING_KINDS_BY_POST_TYPE` adds three
	// kinds for CASE_STUDY that no other type restricts (`CLAIM_STRENGTH`,
	// `AUDIENCE_SCOPE`, `CODEBASE_DETAIL`), so a hoisted post-type-agnostic list
	// would leave the Case Study tab wearing an amber "Needs confirmation" badge
	// for an open claim-strength question while this list named nothing — a
	// warning with no stated cause, and the same page-promises-one-thing /
	// generator-does-another divergence `publishing-restrictions.ts` exists to
	// prevent. Tweet and Blog Post are unchanged by the move: their extra set is
	// empty, so `restrictsPostType` reduces to `isRestrictingThread` for them.
	//
	// Two further reasons for the SHAPE of these lists, both found rather than
	// foreseen. First, an open question about authorship does not change what a
	// draft may assert, so listing it here would bury the ones that do — and
	// this filters per THREAD rather than on an aggregated flag, because an
	// earlier version filtered on `restrictions.global`, a property of the whole
	// thread set, so one safety-critical question let every open thread through.
	//
	// Second, `TopicQuestionsPanel` on the Summary & Questions tab renders the
	// full question text and the control that ANSWERS it; both panels are
	// mounted at once, so restating the text here put the same sentence on the
	// page twice with only one of them actionable. Naming the subject says what
	// the draft will avoid and leaves answering where the answering happens.
	//
	// TWO lists, not one, and the split mirrors the generator's own. The
	// activity feeds `buildCaseStudyLockedClauses` two blocks: the threads that
	// pass `isRestrictingThread` become "NOT approved for use … write around
	// each one … or leave it out", and the ones that pass only the per-type
	// extra become "these are unsettled — do not resolve them by assumption, do
	// not assert either side". The builder's own comment calls applying the
	// first framing to the second category "actively harmful": an open
	// AUDIENCE_SCOPE question under "leave it out" instructs the model to strip
	// the audience framing, and an open CLAIM_STRENGTH one to drop the result,
	// when the correct behaviour is to state it qualitatively and say the
	// strength is unsettled.
	//
	// A single list headed "these will be generalized rather than asserted"
	// therefore told the reader exactly the reading the prompt rejects, for
	// exactly the two kinds it rejects it for — the page-promises-one-thing /
	// generator-does-another divergence `publishing-restrictions.ts` exists to
	// prevent, in the one direction a shared PREDICATE cannot catch on its own.
	const restrictingThreads = decisionThreads.filter((t) =>
		restrictsPostType(t, postType),
	);
	const asSubject = (t: (typeof restrictingThreads)[number]) => ({
		id: t.root.id,
		label: t.root.subject ?? humanizeKind(t.root.decisionKind),
	});
	const unapprovedSubjects = restrictingThreads
		.filter((t) => isRestrictingThread(t))
		.map(asSubject);
	const openQuestionSubjects = restrictingThreads
		.filter((t) => !isRestrictingThread(t))
		.map(asSubject);

	if (isLoading) {
		return (
			<p className="text-muted-foreground text-sm">
				Loading draft state…
			</p>
		);
	}

	return (
		<div className="space-y-5">
			<Section label="Recommendation">
				{info?.rationale ? (
					<p className="text-muted-foreground text-sm leading-relaxed">
						{info.rationale}
					</p>
				) : hasAnalysis ? (
					<p className="text-muted-foreground text-sm">
						The planning analysis doesn't say anything about {label}{" "}
						for this topic.
					</p>
				) : (
					<p className="text-muted-foreground text-sm">
						No planning analysis yet — run one on the Planning &amp;
						Analysis tab to get a recommendation.
					</p>
				)}
			</Section>

			{unapprovedSubjects.length > 0 ? (
				<Section label="Unresolved approvals">
					{/* FR8/FR9. Shown rather than used to block: generation
					    will produce a safe, generalized draft and say so, which
					    is what UC4 asks for. Answering happens on the Summary &
					    Questions tab — this only names what is outstanding.
					    Wording tracks the locked clause it describes. */}
					<p className="text-muted-foreground text-sm leading-relaxed">
						These are still unapproved, so a draft will write around
						each one — generalizing it, using a neutral placeholder,
						or leaving it out — rather than assert it:
					</p>
					<ul className="list-disc space-y-1.5 pl-5 text-muted-foreground text-sm leading-relaxed">
						{unapprovedSubjects.map((r) => (
							<li key={r.id}>{r.label}</li>
						))}
					</ul>
				</Section>
			) : null}

			{openQuestionSubjects.length > 0 ? (
				<Section label="Open questions that constrain this type">
					{/* Deliberately NOT the wording above. These decide how the
					    piece is framed, and a draft that "leaves out" its
					    audience or the strength of its result is vaguer, not
					    safer. */}
					<p className="text-muted-foreground text-sm leading-relaxed">
						These are unsettled, so a draft will not resolve them by
						assumption or assert either side. Where one decides how
						strongly a result may be stated it stays qualitative,
						and what the draft assumed is recorded under inputs
						needed:
					</p>
					<ul className="list-disc space-y-1.5 pl-5 text-muted-foreground text-sm leading-relaxed">
						{openQuestionSubjects.map((r) => (
							<li key={r.id}>{r.label}</li>
						))}
					</ul>
				</Section>
			) : null}

			{postType === "TWEET" ? (
				<ShortPostPanel
					projectId={projectId}
					organizationId={organizationId}
					topicId={topicId}
					draft={draft}
					working={working}
					canEdit={canEdit}
				/>
			) : postType === "BLOG_POST" ? (
				<BlogPostPanel
					projectId={projectId}
					organizationId={organizationId}
					topicId={topicId}
					draft={draft}
					working={working}
					canEdit={canEdit}
				/>
			) : postType === "CASE_STUDY" ? (
				<CaseStudyPanel
					projectId={projectId}
					organizationId={organizationId}
					topicId={topicId}
					draft={draft}
					working={working}
					canEdit={canEdit}
				/>
			) : // Every type in `GENERATION_ACTIVE_POST_TYPES` has a panel, and
			// `TabsContent` renders only for those — so nothing reaches this
			// arm today. It is `null` rather than a shared placeholder on
			// purpose: falling through to a neighbour's panel would render the
			// wrong product under the right tab, which is worse than rendering
			// nothing.
			null}
		</div>
	);
}

function Section({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<section className="space-y-2">
			<h3 className="editorial-label">{label}</h3>
			{children}
		</section>
	);
}
