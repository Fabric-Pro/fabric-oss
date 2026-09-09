"use client";

import { TabsContent, TabsTrigger } from "@ui/components/tabs";
import { cn } from "@ui/lib";
import { AlertTriangleIcon, CheckCircle2Icon, StarIcon } from "lucide-react";
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
import { LinkedInPostPanel } from "./LinkedInPostPanel";
import type { PlanningAnalysisDocument } from "./planning-analysis-content";
import { ShortPostPanel } from "./ShortPostPanel";
import { StakeholderEmailPanel } from "./StakeholderEmailPanel";
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
	/**
	 * The candidate that body was adopted FROM, in full.
	 *
	 * A panel's "how this was generalized" note has to describe the text in the
	 * editor, and `latestReady` stops being that document the moment a
	 * regeneration nobody adopted lands on top of it. `null` for a hand-written
	 * body, or when the source row has fallen out of retention — both meaning
	 * "no note applies", which is a different answer from the newest one.
	 *
	 * `unknown` like the draft rows' own `content`: the shape belongs to each
	 * content type's own reader.
	 */
	sourceContent: unknown;
	updatedAt: string | Date;
}

/**
 * The Topic Item Page's content-generation tabs (Fizzy #1853, Phase 2B-1),
 * since the 2A rework split into three exports: the state model, row 2 of the
 * page's tab strip, and the panels.
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
 * shared panel would have to hide them behind a type check anyway. 2C-2
 * activates Stakeholder Email on the same argument: its safety fields are
 * release status and audience, which no other type has and which no other
 * panel could sensibly render.
 *
 * With that, every content type has a panel and NO tab reads "Coming soon" —
 * 2A's FR50 is satisfied for all of them rather than waived for one. LinkedIn
 * is the fifth, and it arrived WITH its panel in one change rather than landing
 * disabled first.
 *
 * The coming-soon branch below stays anyway, and the rule it enforces is a
 * PAIRING rather than a delay: `GENERATION_ACTIVE_POST_TYPES` is what makes a
 * tab selectable AND what mounts its `TabsContent`, so an entry added there
 * without an arm in `GenerationPanel`'s `postType === …` chain renders a
 * selectable tab with an empty body. A type that genuinely has no panel yet is
 * better left out of that set, where it reads "Coming soon" — an honest
 * placeholder beats a live tab that does nothing.
 *
 * The unresolved-question list is computed PER PANEL rather than once for the
 * strip, and that is a 2C requirement rather than a tidy-up. See
 * `GenerationPanel`.
 */

/** Every content type's generation state, derived once per render. */
export interface GenerationTabModel {
	tabs: GenerationTabInfo[];
	byPostType: Map<PostType, GenerationTabInfo>;
	restrictions: Restrictions;
	/**
	 * Content types whose draft has moved since this reader last opened its
	 * tab. Finding #46 — "changed since last visit".
	 */
	changedSinceRead: Set<PostType>;
	/**
	 * Whether a planning analysis exists to generate FROM.
	 *
	 * Every panel in this row opens on "No planning analysis yet — run one on
	 * the Planning & Analysis tab to get a recommendation", so before one
	 * exists there is nothing here worth a click. The row says so rather than
	 * letting a reader find out one tab at a time.
	 */
	hasAnalysis: boolean;
}

/**
 * Resolve every content type's generation state once, for a page that renders
 * the triggers and the panels in two different places.
 *
 * The 2A rework splits what used to be one self-contained `GenerationTabs`
 * block into a SECOND ROW of the page's single tab strip plus panels in the
 * shared content region — so the strip and the panels no longer sit inside one
 * component that could derive this for both. Deriving it here keeps one source
 * rather than two that drift.
 */
export function buildGenerationTabModel(input: {
	analysis: PlanningAnalysisDocument | null;
	drafts: TopicDraftState[];
	workingDrafts: TopicWorkingDraftState[];
	decisionThreads: TopicDecisionThread[];
	/**
	 * When this reader last opened each content type, keyed by post type. A
	 * type they have never opened is absent — and absent means "not changed",
	 * not "changed": a tab nobody has ever been to is new, and the RECOMMENDED
	 * badge already says so. Two markers for one state would be noise.
	 */
	readMarkers?: Record<string, Date | string>;
	/** The drafts read failed. States degrade to AVAILABLE and say so. */
	hasError: boolean;
}): GenerationTabModel {
	const restrictions: Restrictions = resolveRestrictions(
		input.decisionThreads,
	);

	// A type counts as generated when it has a READY candidate OR a working
	// draft. A user who saved a body has content for that type whatever became
	// of the candidate it came from.
	const generatedPostTypes = [
		...input.drafts
			.filter((d) => d.latestReady !== null)
			.map((d) => d.postType),
		...input.workingDrafts.filter((w) => w.hasBody).map((w) => w.postType),
	];

	const tabs = resolveGenerationTabStates({
		analysis: input.analysis,
		// A failed read must not invent a generated state. Everything degrades
		// to AVAILABLE and the caller's banner says the state could not load.
		generatedPostTypes: input.hasError ? [] : generatedPostTypes,
		restrictions,
	});

	/**
	 * Which tabs have moved since this reader was last in them.
	 *
	 * Compared against the DRAFT's own timestamps, never the topic's: a topic
	 * changes for many reasons — a status flip, an assignee, an answered
	 * question — and none of those is a reason to tell somebody their blog post
	 * has changed.
	 *
	 * A failed drafts read reports nothing changed rather than guessing. The
	 * caller's banner already says the state could not load, and a "changed"
	 * dot derived from data that did not arrive is worse than silence.
	 */
	const changedSinceRead = new Set<PostType>();
	if (!input.hasError && input.readMarkers) {
		for (const draft of input.drafts) {
			const marker = input.readMarkers[draft.postType];
			if (!marker) {
				continue;
			}
			const readAt = new Date(marker).getTime();
			if (Number.isNaN(readAt)) {
				continue;
			}
			const latest = Math.max(
				draft.latestReady
					? new Date(draft.latestReady.updatedAt).getTime()
					: 0,
				draft.latestAttempt
					? new Date(draft.latestAttempt.updatedAt).getTime()
					: 0,
			);
			if (latest > readAt) {
				changedSinceRead.add(draft.postType);
			}
		}
	}

	return {
		tabs,
		byPostType: new Map(tabs.map((t) => [t.postType, t])),
		restrictions,
		hasAnalysis: input.analysis !== null,
		changedSinceRead,
	};
}

/**
 * Row 2 of the topic page's tab strip: one trigger per content type the topic
 * has actually selected.
 *
 * `postTypes` is the topic's EFFECTIVE selection (the user's override when set,
 * the AI suggestion otherwise), not every type the enum knows. A topic that
 * wants a tweet and a blog post shows two triggers, not four — which is what
 * makes "Edit post types" a control with a visible consequence rather than a
 * dialog nobody opens.
 *
 * Returns a fragment rather than its own `TabsList`: the caller owns the row so
 * that both rows drive ONE selection, and picking a content type deselects the
 * review tab instead of opening a tab inside a tab.
 */
export function GenerationTabTriggers({
	model,
	postTypes,
}: {
	model: GenerationTabModel;
	postTypes: readonly PostType[];
}) {
	return (
		<>
			{POST_TYPE_LABELS.filter((t) => postTypes.includes(t.value)).map(
				(t) => {
					const info = model.byPostType.get(t.value);
					const active = GENERATION_ACTIVE_POST_TYPES.has(t.value);
					// Muted, NOT disabled, and the difference is the whole
					// decision. Every panel here opens on "run one on the
					// Planning & Analysis tab", so before an analysis exists
					// there is nothing to do in any of them — but generation
					// itself still works, and disabling the tab would hide
					// that from someone who wants to draft anyway. It reads
					// as unavailable and stays reachable.
					// Not for a type that already HAS a draft: a generated tab
					// is useful whatever the analysis says, and muting it
					// would hide real content behind a hint about something
					// else.
					const awaitingAnalysis =
						active &&
						!model.hasAnalysis &&
						info?.state !== "GENERATED";
					return (
						<TabsTrigger
							key={t.value}
							value={t.value}
							disabled={!active}
							className={cn(
								awaitingAnalysis &&
									"opacity-60 data-[state=active]:opacity-100",
							)}
						>
							{t.generationLabel ?? t.label}
							{!active ? (
								<Badge tone="muted">Coming soon</Badge>
							) : (
								<>
									{/* `StateBadge` renders first and always:
									    it is what carries the tab's state into
									    the ACCESSIBLE NAME, including for an
									    AVAILABLE type that deliberately shows
									    no visible badge. The hint is added
									    beside it, never in place of it. */}
									{info ? <StateBadge info={info} /> : null}
									{awaitingAnalysis ? (
										<Badge tone="muted">
											Needs analysis
										</Badge>
									) : null}
									{/* Beside the state badge, not instead of
									    it: "changed" is a fact about YOUR last
									    visit, and the state is a fact about the
									    draft. Both can be true. */}
									{model.changedSinceRead.has(t.value) ? (
										<Badge tone="warn">Changed</Badge>
									) : null}
								</>
							)}
						</TabsTrigger>
					);
				},
			)}
		</>
	);
}

/**
 * The generation panels, as `TabsContent` siblings of the review tabs' own
 * content. Only the selected types render, and only those with a panel.
 */
export function GenerationTabPanels({
	model,
	postTypes,
	projectId,
	organizationId,
	topicId,
	analysis,
	drafts,
	workingDrafts,
	decisionThreads,
	isLoading,
	canEdit,
}: {
	model: GenerationTabModel;
	postTypes: readonly PostType[];
	projectId: string;
	organizationId: string | null;
	topicId: string;
	analysis: PlanningAnalysisDocument | null;
	drafts: TopicDraftState[];
	workingDrafts: TopicWorkingDraftState[];
	decisionThreads: TopicDecisionThread[];
	isLoading: boolean;
	/** PR2: a reader sees every panel, and none of the write controls. */
	canEdit: boolean;
}) {
	return (
		<>
			{POST_TYPE_LABELS.filter(
				(t) =>
					postTypes.includes(t.value) &&
					GENERATION_ACTIVE_POST_TYPES.has(t.value),
			).map((t) => {
				const info = model.byPostType.get(t.value);
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
								drafts.find((d) => d.postType === t.value) ??
								null
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
		</>
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
	// kinds for CASE_STUDY that the 2B types do not restrict (`CLAIM_STRENGTH`,
	// `AUDIENCE_SCOPE`, `CODEBASE_DETAIL`) and two for STAKEHOLDER_EMAIL
	// (`AUDIENCE_SCOPE`, `CLAIM_STRENGTH` — not `CODEBASE_DETAIL`, which an
	// email to a sponsor does not run), so a hoisted post-type-agnostic list
	// would leave those tabs wearing an amber "Needs confirmation" badge for an
	// open claim-strength question while this list named nothing — a warning
	// with no stated cause, and the same page-promises-one-thing /
	// generator-does-another divergence `publishing-restrictions.ts` exists to
	// prevent. It also has to be per-panel rather than per-phase: the two 2C
	// types have DIFFERENT extra sets, so one list shared between them would be
	// wrong for whichever it was not computed for. Tweet and Blog Post are
	// unchanged by the move: their extra set is empty, so `restrictsPostType`
	// reduces to `isRestrictingThread` for them.
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
			) : postType === "LINKEDIN_POST" ? (
				<LinkedInPostPanel
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
			) : postType === "STAKEHOLDER_EMAIL" ? (
				<StakeholderEmailPanel
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
