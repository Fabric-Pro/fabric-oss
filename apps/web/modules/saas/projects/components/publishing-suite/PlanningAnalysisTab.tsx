"use client";

import {
	type EffectiveAnalysis,
	renderAnalysisProse,
} from "@repo/utils/publishing-analysis-prose";
import { diffPartialText } from "@saas/projects/lib/diff-utils";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Markdown } from "@ui/components/markdown";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	AlertTriangleIcon,
	ChevronDownIcon,
	HistoryIcon,
	Loader2Icon,
	SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AnalysisVersionHistory } from "./AnalysisVersionHistory";
import { PlanningAnalysisEditor } from "./PlanningAnalysisEditor";
import {
	isEmptyAnalysis,
	readPlanningAnalysis,
} from "./planning-analysis-content";

const UNKNOWN_AUTHOR_LABEL = "Unknown author";
/**
 * One analysis row as `getPlanningAnalysis` returns it. Local: no other
 * module needs it, because no other module is given the raw AI row.
 */
interface PlanningAnalysisRow {
	id: string;
	version: number;
	status: string;
	content: unknown;
	sourceRefs: unknown;
	model: string | null;
	promptSource: string | null;
	error: string | null;
	createdAt: string | Date;
	updatedAt: string | Date;
	/**
	 * Server-computed: a GENERATING row past its deadline that nothing
	 * terminalised. The panel must treat it as retryable — the only code that
	 * reclaims such a row runs inside the NEXT attempt, so a button disabled on
	 * `status === "GENERATING"` alone locks the topic permanently.
	 */
	isExpired?: boolean;
}

interface PlanningAnalysisTabProps {
	projectId: string;
	topicId: string;
	organizationId: string | null;
	canEdit: boolean;
	isLoading: boolean;
	/**
	 * The topic-level "answers recorded after the analysis" banner is on
	 * screen, and it carries its own Regenerate.
	 *
	 * The header's control stands down for as long as that is true. Two
	 * buttons starting the same run is design-QA finding #5: they cannot
	 * disagree about whether one is in flight — both read the same
	 * `GENERATING` row — but a reader should not have to work out that the
	 * filled button and the outlined one beside it do the same thing.
	 */
	generateActionIsElsewhere?: boolean;
	/**
	 * A rewrite the AI assistant produced and the reader accepted in the chat
	 * (Fizzy #1851, #15). `null` whenever there is none waiting.
	 *
	 * It arrives as a SEED for the editor, never as a save: this tab has no
	 * autosave, and the reason is #1929 — an autosave racing an in-flight agent
	 * overwrote the server with pre-answer text. A second writer here would
	 * reintroduce exactly that race against a document whose revisions are
	 * defined as "what a person saved". So the assistant's text lands in the
	 * editor and the existing Save stays the only thing that writes.
	 */
	assistantProposal?: string | null;
	/** Clears the parent's copy, so one accepted rewrite is applied once. */
	onAssistantProposalConsumed?: () => void;
	/**
	 * The assistant is mid-run against this topic, so the document is about to
	 * be rewritten from under the author.
	 *
	 * Joins `latestAttempt.status === "GENERATING"` rather than replacing it:
	 * a server regeneration and a chat-driven rewrite are different paths that
	 * threaten the same document in the same way, and the editor should not
	 * care which one is running. Optional, defaulting to false, so a caller
	 * with no assistant on the page locks for regenerations exactly as before.
	 */
	assistantRunActive?: boolean;
	/**
	 * The newest attempt at an analysis, whatever became of it. This is what
	 * the panel says ABOUT the document — running, failed, stranded past its
	 * deadline — never what it renders. A panel driven off "the newest row"
	 * would blank a perfectly good analysis the moment a regeneration failed,
	 * and hide it again for the minutes the next one runs.
	 */
	latestAttempt: PlanningAnalysisRow | null;
	/**
	 * What to RENDER: the resolver's one answer to "what is this topic's
	 * planning analysis right now" — the AI's own prose, or the author's
	 * override of it, plus the structured data half either way. `null` when no
	 * READY analysis exists at all.
	 */
	effective: EffectiveAnalysis | null;
	/** Version of the newest READY analysis. `null` when there is none. */
	aiVersion: number | null;
	/**
	 * The model that produced the newest READY analysis, and how that run's
	 * prompt was resolved. Scalars off that row rather than the row itself:
	 * provenance has to survive a FAILED or stranded attempt landing on top of
	 * a good analysis, and both of those are terminal states — a footer that
	 * read them off `latestAttempt` would drop them for good, on exactly the
	 * analyses a reader is most likely to be scrutinising.
	 */
	aiModel: string | null;
	aiPromptSource: string | null;
	/** Version of the current hand-edited revision. `null` before the first. */
	revisionVersion: number | null;
	/** The analysis version the current document was written from. */
	sourceAnalysisVersion: number | null;
	/** Who wrote the current revision; `null` for a departed author. */
	author: { id: string; name: string } | null;
	/** Arrives as a `Date` over the oRPC contract, not a string. */
	revisionCreatedAt: string | Date | null;
}

/**
 * The topic's Planning & Analysis tab (Fizzy #1851).
 *
 * Composes the editable document (`PlanningAnalysisEditor`, Task 9) and its
 * version history (`AnalysisVersionHistory`, Task 10) around the structured
 * sections the product reads by name, in one order: header (label, History,
 * Generate, and the provenance line under them), stale banner, document, data
 * sections.
 *
 * Three things here are load-bearing rather than cosmetic:
 *
 *  1. **The editor is remounted on a seed change, and only on one.** It seeds
 *     its `prose` prop on mount and has no re-sync effect, so a restore, a
 *     replace, or a regeneration landing on a document nobody has edited all
 *     have to force a fresh mount — a prop update alone would leave the author
 *     reading text the server no longer holds. An ordinary Save is the
 *     opposite case: the editor's own buffer already IS the saved text, and
 *     remounting would reset the cursor, drop the undo stack, and discard
 *     anything typed between the save and the refetch landing. With no
 *     autosave here, "save and keep typing" is the normal way to work. See
 *     `seed` below for the one rule that separates the two.
 *  2. **Every write invalidates the analysis query.** The editor's version
 *     props are controlled with no internal state update on success, so a
 *     second Save before this parent re-renders with fresh props would resend
 *     a stale `expectedVersion` and earn a spurious CONFLICT.
 *  3. **"Replace" goes through the same save path as any other edit.** It
 *     writes a new revision seeded from the newer AI prose rather than
 *     deleting the author's, so it lands in history and rolls back like
 *     anything else.
 *
 * Data is fetched by the page rather than here: `latestAttempt`'s status also
 * drives the Summary & Questions tab's `TopicQuestionsPanel`, which explains a
 * failed regeneration (`analysisFailed`) rather than rendering as though
 * nothing was ever raised — so both tabs need the same row from one poll.
 */
export function PlanningAnalysisTab({
	projectId,
	topicId,
	organizationId,
	canEdit,
	isLoading,
	generateActionIsElsewhere = false,
	latestAttempt,
	effective,
	aiVersion,
	aiModel,
	aiPromptSource,
	revisionVersion,
	sourceAnalysisVersion,
	author,
	revisionCreatedAt,
	assistantProposal = null,
	onAssistantProposalConsumed,
	assistantRunActive = false,
}: PlanningAnalysisTabProps) {
	const queryClient = useQueryClient();
	const [historyOpen, setHistoryOpen] = useState(false);
	const [newerOpen, setNewerOpen] = useState(false);

	/**
	 * What the MOUNTED editor was seeded from, and the token that remounts it.
	 *
	 * `generation` is the editor's `key`, so bumping it destroys the TipTap
	 * instance and rebuilds it from the prose now in props. `revision` and `ai`
	 * are what that instance was actually built from — deliberately not "what
	 * the server holds now", which is what makes the comparison below mean
	 * something.
	 */
	const [seed, setSeed] = useState<{
		topic: string;
		revision: number | null;
		ai: number | null;
		generation: number;
	}>(() => ({
		topic: topicId,
		revision: revisionVersion,
		ai: aiVersion,
		generation: 0,
	}));
	/**
	 * The revision this editor's own Save produced, and the topic it produced
	 * it on. A version the editor itself wrote is never a reason to re-seed it:
	 * the text is already on screen, in the instance the author is still typing
	 * into.
	 *
	 * The TOPIC half is what keeps that exemption honest, and it cannot be
	 * recovered from `seed.topic`: by the time a revision arrives on a new
	 * topic, the topic-swing remount has already advanced the seed to it. A
	 * bare version number would then match across topics — and it would match
	 * routinely rather than rarely, because every topic's first revision is
	 * version 1. The consequence is not cosmetic: the exempted refetch leaves
	 * the editor showing the new topic's un-edited AI prose while
	 * `revisionVersion` says a revision exists, so the next Save sends an
	 * `expectedVersion` the server accepts and supersedes somebody else's
	 * revision with neither person seeing it.
	 *
	 * This is only ONE of the two topic terms `isOwnSave` needs. Nothing ever
	 * clears this record, so it also has to be paired with `seed.topic` — see
	 * the comment there for the question that term answers instead.
	 */
	const [ownSave, setOwnSave] = useState<{
		topic: string;
		version: number;
	} | null>(null);

	/**
	 * The assistant's rewrite once it is IN the editor — kept so the editor can
	 * be seeded from it instead of from the server's prose, and so the notice
	 * above it knows to be there.
	 *
	 * Cleared by a save (the text is the document now) and by Discard.
	 */
	const [loadedProposal, setLoadedProposal] = useState<string | null>(null);
	/**
	 * A proposed rewrite waiting for the author's decision, as the pair the
	 * diff is computed from. `null` whenever nothing is under review.
	 */
	const [review, setReview] = useState<{
		baseline: string;
		proposed: string;
		/**
		 * The analysis version an accepted review must be STAMPED with, or
		 * `null` to keep the document's current stamp.
		 *
		 * This is the whole reason `Replace` existed as its own write: a
		 * revision seeded from analysis version N has to record N as its
		 * `sourceAnalysisVersion`, because `isStale` is
		 * `sourceAnalysisVersion < aiVersion` and nothing else clears the
		 * banner. A rewrite from the assistant carries `null` — it is based on
		 * the document as it stands, not on a newer analysis, so the stamp must
		 * not move and the banner must stay up if it was up.
		 */
		sourceAnalysisVersion: number | null;
	} | null>(null);
	/**
	 * The stamp an accepted review still owes its save.
	 *
	 * Accepting resolves the marks and hands the text back to the editor
	 * UNSAVED, so the version it must be recorded against has to outlive the
	 * review itself — right up to the Save the author presses. Cleared by
	 * `handleSaved`.
	 */
	const [pendingSourceVersion, setPendingSourceVersion] = useState<
		number | null
	>(null);

	const effectiveProse = effective?.prose ?? "";
	/**
	 * The document as it stands, mirrored for readers that must not depend on
	 * it. The assistant-proposal effect opens a review against this; taking it
	 * from the closure instead would put `effective.prose` in that effect's
	 * dependency list, and every poll that changed the document would re-open a
	 * review the author had already resolved.
	 */
	const currentProseRef = useRef(effectiveProse);
	currentProseRef.current = effectiveProse;

	/**
	 * The prose as of the last COMMIT, which is the document a newly-generated
	 * analysis is about to replace.
	 *
	 * `currentProseRef` above is written during render and is therefore already
	 * the new text by the time a regeneration is detected. This one is written
	 * in an effect with no dependency array, so during any render it still
	 * holds what was last on screen — the only place the previous document
	 * survives, since nothing serves an older analysis's content.
	 */
	const committedProseRef = useRef(effectiveProse);
	useEffect(() => {
		committedProseRef.current = effectiveProse;
	});

	// Every write that can move the document's version has to land here. The
	// editor and the history drawer both hold their version tokens as props
	// from this parent, and neither updates them itself on success.
	//
	// TWO queries, because a save moves two things: the document, and the list
	// of versions the document has had. Only the first was invalidated, so
	// saving an edit left History showing a list without the revision it had
	// just written — and the global 60s `staleTime` meant reopening the drawer
	// did not refetch either, which is why it took a full page reload to
	// appear. Restore already invalidated both; an ordinary Save did not.
	//
	// `key()` and NOT `queryKey()` for the revision list, for the reason its
	// own restore handler documents at length: the list is an INFINITE query,
	// `queryKey({ input })` stamps `type: "query"`, and the mismatch matches
	// nothing at runtime while looking perfectly correct here.
	const refreshAnalysis = useCallback(() => {
		queryClient.invalidateQueries({
			queryKey:
				orpc.projects.publishingSuite.getPlanningAnalysis.queryKey({
					input: { projectId, topicId, organizationId },
				}),
		});
		queryClient.invalidateQueries({
			queryKey: orpc.projects.publishingSuite.listAnalysisRevisions.key({
				input: { projectId, topicId, organizationId },
			}),
		});
	}, [queryClient, projectId, topicId, organizationId]);

	// A save is the one write whose result the editor already has. Recording
	// the version it produced is what keeps the refetch that follows from
	// remounting the instance the author is still typing into. It records
	// BEFORE the refetch lands, so the props that arrive carrying that version
	// are recognised the moment they do — and it records the topic it was made
	// on, which is the only thing that stops the same number being honoured on
	// a different one.
	const handleSaved = useCallback(
		(version: number) => {
			setOwnSave({ topic: topicId, version });
			// The assistant's text is the document now, so the notice offering
			// to discard it no longer describes anything true.
			setLoadedProposal(null);
			// The stamp has been written; the next save is an ordinary edit.
			setPendingSourceVersion(null);
			refreshAnalysis();
		},
		[refreshAnalysis, topicId],
	);

	const generate = useMutation(
		orpc.projects.publishingSuite.generatePlanningAnalysis.mutationOptions({
			onSuccess: (result: { started: boolean; reason?: string }) => {
				if (!result.started && result.reason === "unavailable") {
					toast.error(
						"Generation is temporarily unavailable. Please try again shortly.",
					);
				}
				// Even an "in-progress" answer wants the refetch: it means a row
				// exists that this client has not seen yet, and the page's poll
				// keys off exactly that row's status.
				refreshAnalysis();
			},
			onError: () => {
				toast.error("Could not start the planning analysis.");
			},
		}),
	);

	// `isExpired` splits GENERATING in two. A LIVE run keeps the button disabled
	// — a second click spends a second model call on a healthy run. A STRANDED
	// one must re-enable it, because pressing it is the only thing that reaches
	// the reclaim inside `startPlanningAnalysisAttempt`.
	const isStranded =
		latestAttempt?.status === "GENERATING" &&
		latestAttempt.isExpired === true;
	const isGenerating = latestAttempt?.status === "GENERATING" && !isStranded;
	const hasFailed = latestAttempt?.status === "FAILED";
	const canRetry = hasFailed || isStranded;

	// The newest attempt IS the newest READY row whenever nothing newer has
	// been tried. That is the only way this component ever holds the raw AI
	// content: `latestReady` is deliberately no longer part of the response,
	// because a caller that rendered it would silently ignore the author's own
	// edit. Here the row is never rendered as the document — it is the SEED for
	// "replace with the newer analysis", and nothing else. Provenance does NOT
	// come from here; it arrives as `aiModel` / `aiPromptSource`, which survive
	// a failed attempt landing on top of a good analysis.
	const readyRow =
		latestAttempt != null &&
		latestAttempt.status === "READY" &&
		aiVersion != null &&
		latestAttempt.version === aiVersion
			? latestAttempt
			: null;

	// A ready analysis that is NOT the newest attempt is a previous one being
	// shown while a newer attempt runs or after one failed.
	const showingPrevious =
		aiVersion != null &&
		latestAttempt != null &&
		latestAttempt.version !== aiVersion;

	// The author's document was written from an analysis the AI has since moved
	// past. Both halves must be known — a document nobody has edited reports
	// `sourceAnalysisVersion === aiVersion` and is never stale.
	const isStale =
		sourceAnalysisVersion !== null &&
		aiVersion !== null &&
		sourceAnalysisVersion < aiVersion;

	// Has the document moved out from under the mounted editor?
	//
	// Three ways it can, and all three must remount: this is a different topic
	// (the page reuses one mounted tab across topics), a different revision is
	// now current (a restore, a replace, or someone else's edit arriving on a
	// poll), or — on a document nobody has ever edited — a newer analysis went
	// READY, which replaces `effective.prose` wholesale. Missing the last is
	// how an editor ends up rendering version 1's text directly beside a footer
	// that says "showing analysis version 2".
	//
	// The one thing that is NOT a move: a version this editor's own Save just
	// produced. That is the whole difference between "the text changed" and "I
	// changed the text", and it has to exempt that one refetch and nothing
	// else.
	//
	// It takes BOTH topic terms. They are not redundant — they answer two
	// different questions, and deleting either one reopens a different defect:
	//
	//  * `topicId === ownSave.topic` asks "is this revision MINE?" Without it
	//    the exemption remembers a bare version NUMBER, and every topic's first
	//    revision is version 1 — so a save made here lines up with the first
	//    revision anybody writes over there as a matter of course. That refetch
	//    is exempted, the editor keeps showing the other topic's un-edited AI
	//    prose, and the next Save supersedes a colleague's revision with
	//    neither person seeing it. `seed.topic` cannot stand in for this: the
	//    topic-swing remount has already advanced the seed onto the arriving
	//    revision's own topic by the time it lands.
	//  * `topicId === seed.topic` asks "is the MOUNTED editor already on this
	//    topic?" `ownSave` is never cleared, so after a save on topic-1 and a
	//    swing away to topic-2, swinging BACK to topic-1 on that same version
	//    number still matches the save. Without this term the exemption holds,
	//    nothing remounts, and the editor keeps topic-2's document while
	//    `topicId`, `revisionVersion`, `sourceAnalysisVersion` and the footer
	//    are all topic-1's — so the next Save writes topic-2's prose into
	//    topic-1's revision chain at an `expectedVersion` the server accepts.
	//    No CONFLICT, no warning, and no second actor required.
	const isOwnSave =
		ownSave !== null &&
		topicId === ownSave.topic &&
		topicId === seed.topic &&
		revisionVersion !== null &&
		revisionVersion === ownSave.version;
	const seedIsStale =
		!isOwnSave &&
		(topicId !== seed.topic ||
			revisionVersion !== seed.revision ||
			(revisionVersion === null && aiVersion !== seed.ai));
	if (seedIsStale) {
		/**
		 * A regeneration landing on a document nobody has edited.
		 *
		 * This is the "Regenerate planning analysis" case, and it used to be
		 * the quietest replacement of the three: with no revision, a newly
		 * READY analysis simply became the document, and the text it replaced
		 * was gone — no endpoint serves an older analysis's content, so there
		 * was no way back to it. Painted as a review instead, both versions are
		 * on screen and every change is accepted or rejected on purpose.
		 *
		 * `seed.ai !== null` is what keeps the FIRST analysis out of it: the
		 * tab kicks a run automatically on first open, and a diff against an
		 * empty document is a review with nothing to weigh. An empty previous
		 * document is excluded for the same reason.
		 *
		 * The review is opened in the SAME render pass that bumps the seed, so
		 * the editor still mounts exactly once — on the diff.
		 */
		const regeneratedOntoUneditedDocument =
			topicId === seed.topic &&
			revisionVersion === null &&
			seed.ai !== null &&
			aiVersion !== seed.ai &&
			committedProseRef.current.trim() !== "" &&
			committedProseRef.current !== effectiveProse;
		if (regeneratedOntoUneditedDocument && review === null) {
			// No stamp to carry: with no revision the save path already reports
			// the newest READY version as the source it was seeded from.
			setReview({
				baseline: committedProseRef.current,
				proposed: effectiveProse,
				sourceAnalysisVersion: null,
			});
		}
		// Adjusting state during render — React's own pattern for state that
		// derives from props. It re-runs this render with the new seed before
		// anything commits, so the editor mounts once, on the right key.
		setSeed({
			topic: topicId,
			revision: revisionVersion,
			ai: aiVersion,
			generation: seed.generation + 1,
		});
	}

	const newerProse = readyRow ? renderAnalysisProse(readyRow.content) : null;

	const onGenerate = () =>
		generate.mutate({ projectId, topicId, organizationId });

	/**
	 * Start the first analysis when this tab is opened on a topic that has
	 * never had one.
	 *
	 * The tab used to open on an empty dashed box with a button, and the owner's
	 * complaint was that there is nothing to work with there — every other tab
	 * on the page depends on this document, so the first thing anyone does on
	 * arriving is press Generate. Feature Maturation drafts its spec at creation
	 * for the same reason.
	 *
	 * The conditions are narrow on purpose, because this spends an LLM call:
	 *
	 *  - `latestAttempt === null` — NEVER attempted, not merely "no READY row".
	 *    A failed or stranded run has already cost money and its retry is a
	 *    decision for the person looking at the failure, not for a mount.
	 *  - `canEdit` — the server gates generation, so a reader must not fire a
	 *    request that can only 403.
	 *  - `!isLoading` — before the query settles, `latestAttempt` is null
	 *    because nothing has been read yet, which is a different thing from
	 *    nothing existing.
	 *
	 * The ref guard is load-bearing rather than defensive. `generate.mutate`
	 * invalidates the analysis query, the refetch re-renders this component,
	 * and for the moment before the new row lands `latestAttempt` is still
	 * null — so without it this effect re-enters and starts a second run.
	 *
	 * MOUNT NO LONGER MEANS "OPENED". This tab is force-mounted by
	 * `TopicItemPage` so an editor full of unsaved words survives a trip to
	 * another tab, which means this effect now runs on page load for everyone,
	 * not just for someone who clicked through to the third tab.
	 *
	 * That is safe, and it was already the shape of things: the page-level
	 * auto-start in `TopicItemPage` fires on the same load, under the same
	 * conditions, and the two have always been allowed to race. The server
	 * claims the attempt under a partial unique index and answers
	 * `in-progress` to whichever call loses, so at most one run starts. The
	 * cost of force-mounting is one extra call that the server refuses, not an
	 * extra generation.
	 */
	const autoStarted = useRef(false);
	useEffect(() => {
		if (
			autoStarted.current ||
			isLoading ||
			!canEdit ||
			latestAttempt !== null ||
			generate.isPending
		) {
			return;
		}
		autoStarted.current = true;
		onGenerate();
	}, [isLoading, canEdit, latestAttempt, generate.isPending, onGenerate]);

	/**
	 * Open a review: paint `proposed` over `baseline` as diff marks and hand
	 * the editor the result.
	 *
	 * The two callers are the assistant's rewrite and the stale banner's
	 * Replace. Both used to swap the whole document in one move — one into the
	 * editor, one straight through `saveAnalysisRevision` — which is what made
	 * "regenerate" feel like something done TO the document rather than
	 * proposed to its author.
	 *
	 * `diffPartialText` emits marker tokens rather than HTML so the surrounding
	 * markdown still parses; `fromMarkdown` inside the editor turns them into
	 * the `<ins class="diff-ins">` / `<del class="diff-del">` that
	 * `advancedExtensions` binds. Nothing here writes.
	 */
	const beginReview = useCallback(
		(
			baseline: string,
			proposed: string,
			sourceAnalysisVersion: number | null,
		) => {
			setReview({ baseline, proposed, sourceAnalysisVersion });
			setLoadedProposal(null);
			setSeed((prev) => ({ ...prev, generation: prev.generation + 1 }));
		},
		[],
	);

	/**
	 * The advisory "what changed" digest for the open review.
	 *
	 * `null` covers two different facts and keeps them apart: it is the state
	 * before the call resolves, and it is also where a FAILED call lands,
	 * because the procedure throws on model failure rather than returning `[]`.
	 * A successful call that finds nothing to say returns `[]`. Both render
	 * nothing — see the note on the effect below — but they are not the same
	 * thing and the code does not pretend they are.
	 */
	const [changeSummary, setChangeSummary] = useState<string[] | null>(null);
	const summarize = useMutation(
		orpc.projects.publishingSuite.summarizeAnalysisChanges.mutationOptions({
			onSuccess: (result: { changeSummary: string[] }) => {
				setChangeSummary(result.changeSummary);
			},
			// Silent, and deliberately so. The digest is advisory: it explains
			// a diff the author can already read. A toast over a failed
			// explanation would interrupt the review it was meant to help,
			// and the card simply stays away. Accept and Reject never consult
			// this mutation at all.
			onError: () => {
				setChangeSummary(null);
			},
		}),
	);

	/**
	 * Ask for the digest ONCE per review, not once per render.
	 *
	 * The trigger is `review` becoming non-null. Both texts are already in
	 * hand, so nothing has to be read back out of the editor first. The ref
	 * is what makes it once: this effect re-runs on every render that touches
	 * its dependencies, and a model call per keystroke is the failure mode
	 * being avoided. It re-arms when the review closes, so the next one asks
	 * again.
	 */
	const summarizeFiredRef = useRef(false);
	// `mutate` is a fresh identity on every render of this component, so it is
	// read through a ref rather than named as a dependency — naming it would
	// re-run this effect constantly and defeat the guard above it.
	const summarizeMutateRef = useRef(summarize.mutate);
	summarizeMutateRef.current = summarize.mutate;
	useEffect(() => {
		if (review === null) {
			summarizeFiredRef.current = false;
			setChangeSummary(null);
			return;
		}
		if (summarizeFiredRef.current) {
			return;
		}
		summarizeFiredRef.current = true;
		summarizeMutateRef.current({
			projectId,
			topicId,
			organizationId,
			before: review.baseline,
			after: review.proposed,
		});
	}, [review, projectId, topicId, organizationId]);

	/**
	 * The author accepted what the review left standing.
	 *
	 * `merged` is the document with the marks resolved — every insertion they
	 * kept, without the deletions they accepted. It is loaded into the editor
	 * UNSAVED, through the same channel the assistant's rewrite already used,
	 * so the amber "nothing is saved until you save it" notice describes it
	 * exactly and Save remains the only writer.
	 */
	const acceptReview = useCallback(
		(merged: string | null) => {
			if (merged === null) {
				// The same null-not-empty contract the editor's own save path
				// treats as refusal: a failed serialization must not be allowed to
				// replace the document with nothing.
				toast.error(
					"Couldn't apply the review — the editor content could not be read. Nothing was changed.",
				);
				return;
			}
			setReview(null);
			setPendingSourceVersion(review?.sourceAnalysisVersion ?? null);
			setLoadedProposal(merged);
			setSeed((prev) => ({ ...prev, generation: prev.generation + 1 }));
		},
		[review],
	);

	/** Drop the proposal entirely and remount on the server's text. */
	const rejectReview = useCallback(() => {
		setReview(null);
		setPendingSourceVersion(null);
		setLoadedProposal(null);
		setSeed((prev) => ({ ...prev, generation: prev.generation + 1 }));
	}, []);

	/**
	 * Take the assistant's accepted rewrite into the editor.
	 *
	 * The generation bump is what makes it visible: `PlanningAnalysisEditor`
	 * seeds its TipTap instance on mount and never re-syncs, so feeding it new
	 * prose without remounting it changes nothing on screen. The functional
	 * form matters too — the render-phase `setSeed` above may have fired in the
	 * same commit, and a bump computed from the `seed` this closure captured
	 * would land on the stale generation and cancel that remount out.
	 *
	 * Taken ONCE, and the guard is the proposal's own text rather than the
	 * effect's dependency list: `onAssistantProposalConsumed` is a prop, and a
	 * caller that rebuilds it per render would otherwise re-fire this on every
	 * poll — re-seeding the editor and destroying everything typed since the
	 * accept. Clearing the parent is the other half, not a substitute for it.
	 */
	const consumedProposal = useRef<string | null>(null);
	useEffect(() => {
		if (assistantProposal === null) {
			// Re-arm, so proposing the SAME text again after a clear is a new
			// proposal rather than one the guard below silently swallows.
			consumedProposal.current = null;
			return;
		}
		if (consumedProposal.current === assistantProposal) {
			return;
		}
		consumedProposal.current = assistantProposal;
		// Read the baseline through a ref: adding `effective.prose` to the
		// dependency list would re-fire this on every poll that changes the
		// document, re-opening a review the author had already resolved.
		beginReview(currentProseRef.current, assistantProposal, null);
		onAssistantProposalConsumed?.();
	}, [assistantProposal, onAssistantProposalConsumed, beginReview]);

	/** Put the server's text back, and remount the editor onto it. */
	const discardProposal = useCallback(() => {
		setLoadedProposal(null);
		setSeed((prev) => ({ ...prev, generation: prev.generation + 1 }));
	}, []);

	/**
	 * Review the newer analysis against the document as it stands.
	 *
	 * This used to write immediately — `replace.mutate` with the newer prose
	 * as the whole body — so the only way to see what changed was to have
	 * memorised the old text. The write still happens through the same Save
	 * the author presses afterwards; what moved is that they see the change
	 * first.
	 */
	const onReview = () => {
		if (newerProse === null || aiVersion === null) {
			return;
		}
		beginReview(effectiveProse, newerProse, aiVersion);
	};

	if (isLoading) {
		return (
			<p className="text-muted-foreground text-sm">
				Loading planning analysis…
			</p>
		);
	}

	const data = effective ? readPlanningAnalysis(effective.data) : null;
	const proseIsEmpty = effective !== null && effective.prose.trim() === "";

	/**
	 * Answers the current analysis does not know about.
	 *
	 * Compares TIMESTAMPS, not versions: an answer that landed after the
	 * document was written is one the document cannot reflect, whatever
	 * version either of them carries.
	 *
	 * It used to compare the version a question was RAISED against with the
	 * version on screen, and that proxy has two holes — both reachable, both
	 * silent, and neither visible from inside the slice that introduced it:
	 *
	 * - **Amending.** `reconcileTopicQuestions` skips RESOLVED roots, so a
	 *   question answered against v1 keeps `analysisVersion: 1` forever. Amend
	 *   its answer after a regeneration to v2 and the versions differ, so the
	 *   banner stays quiet while the analysis is genuinely behind the decision
	 *   that just changed.
	 * - **Answering a soft-closed root.** The `POSSIBLY_RESOLVED` sweep sets
	 *   status only and never `analysisVersion`, so answering one after a
	 *   regeneration is silent for the same reason.
	 *
	 * A timestamp has neither hole, because every answer — first or amended —
	 * appends a reply and every reply is stamped.
	 *
	 * This is the Feature Maturation banner ("N new decisions recorded — not
	 * yet in the Full Specification") in the place that reads the same way here.
	 * The action is the Regenerate button already in this header, so the banner
	 * points at it rather than adding a second control that does the same thing.
	 */

	return (
		<TooltipProvider>
			<div className="space-y-5">
				{/* Version state and the two controls that change it sit together,
				    above the fold. They used to be split: Generate pinned here and
				    the provenance line plus History in a footer BELOW the document
				    and below the data sections, which on a real analysis is a long
				    scroll away from the button whose result it describes.
				    Provenance takes its own line rather than sharing the header
				    row — it runs to ~140 characters with a model name and a prompt
				    note, and would wrap badly against the buttons. */}

				{/* ONE toolbar row, not a stack.
			    
				    The provenance line and the controls were separate block-level
				    rows, and with the document's own Markdown toggle below them
				    that was three full-width rows of chrome before the text began
				    — seven or eight once the stale, generating, failed and
				    superseded notices stacked up behind them. Feature Maturation
				    is not compact because it has fewer controls; it has just as
				    many, portalled into one shared toolbar slot. This is that
				    slot: provenance left, actions right, one line.

				    No `PLANNING & ANALYSIS` label: the tab immediately above
				    already says it, and printing it twice was the first thing a
				    reader noticed. */}
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
					<div className="min-w-0">
						{effective !== null ? (
							<DocumentProvenance
								revisionVersion={revisionVersion}
								aiVersion={aiVersion}
								author={author}
								revisionCreatedAt={revisionCreatedAt}
								aiModel={aiModel}
								aiPromptSource={aiPromptSource}
							/>
						) : null}
					</div>
					<div className="flex flex-wrap items-center justify-end gap-3">
						<div className="flex flex-wrap items-center gap-2">
							{/* Reading history is gated on read access, not edit
							    access, so it shows for a viewer too — but only
							    once there is an analysis to have a history of. */}
							{effective !== null ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											aria-label={`Version history, showing version ${
												revisionVersion ??
												aiVersion ??
												1
											}`}
											onClick={() => setHistoryOpen(true)}
										>
											<HistoryIcon
												className="mr-1 size-4"
												aria-hidden="true"
											/>
											v{revisionVersion ?? aiVersion ?? 1}
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										Version history
									</TooltipContent>
								</Tooltip>
							) : null}
							{/* Stands down while the topic-level banner
							    carries the same action — except to RETRY,
							    which that banner never offers: it only fires
							    on answers landing after a successful run, so
							    suppressing this button after a failure would
							    leave no way to start another. */}
							{canEdit &&
							(!generateActionIsElsewhere || canRetry) ? (
								<Button
									variant={
										aiVersion !== null
											? "outline"
											: "primary"
									}
									size="sm"
									onClick={onGenerate}
									disabled={
										isGenerating || generate.isPending
									}
								>
									{isGenerating || generate.isPending ? (
										<Loader2Icon
											className="mr-2 size-4 motion-safe:animate-spin"
											aria-hidden="true"
										/>
									) : (
										<SparklesIcon
											className="mr-2 size-4"
											aria-hidden="true"
										/>
									)}
									{canRetry
										? "Try again"
										: aiVersion !== null
											? "Regenerate planning analysis"
											: "Generate planning analysis"}
								</Button>
							) : null}
						</div>
					</div>
				</div>

				{isGenerating ? (
					<Banner tone="info">
						Generating the planning analysis. This usually takes a
						minute or two.
					</Banner>
				) : null}

				{hasFailed ? (
					<Banner tone="error">
						{latestAttempt?.error ??
							"The planning analysis could not be built."}
					</Banner>
				) : null}

				{isStranded ? (
					<Banner tone="error">
						This run did not report back within its time limit.
						Generating again will clear it and start a new one.
					</Banner>
				) : null}

				{/* ONE quiet line, actions inline.
					
					   It was a full-width amber block with its own two-button
					   row underneath — the loudest thing on a tab whose
					   complaint was how much chrome sits above the text, and
					   it appears on exactly the documents someone is in the
					   middle of editing.
					
					   The CHOICE stays. Feature Maturation replaces a
					   refreshed spec outright because it locks its editor
					   while one runs, so nothing can have been typed into the
					   document being superseded. Here the newer analysis
					   arrives from a background run, and this banner only
					   shows when a person has already edited — a document
					   nobody has touched takes the new version wholesale and
					   never gets here. Auto-replacing would discard exactly
					   the edits it exists to protect.
					
					   The live region is the SENTENCE, not the row: putting
					   the controls inside one would have a screen reader
					   re-announce them every time it appeared. */}
				{isStale ? (
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-highlight/40 bg-highlight/10 px-3 py-2">
						<p
							className="min-w-0 flex-1 text-xs leading-relaxed"
							role="status"
						>
							Written from version {sourceAnalysisVersion};
							version {aiVersion} has since been generated.
						</p>
						{newerProse !== null ? (
							<>
								{/* Short LABEL, full accessible name. "View" and
								    "Replace" out of context tell a screen
								    reader nothing about what is being viewed
								    or replaced; the sentence beside them is
								    what gives the words their meaning, and a
								    button has to carry its own. */}
								<Button
									type="button"
									variant="ghost"
									size="sm"
									aria-label="View the newer analysis"
									onClick={() => setNewerOpen(true)}
								>
									View
								</Button>
								{canEdit ? (
									<Button
										type="button"
										variant="outline"
										size="sm"
										aria-label="Review the newer analysis against this document"
										onClick={onReview}
									>
										Review changes
									</Button>
								) : null}
							</>
						) : (
							<span className="text-muted-foreground text-xs">
								Available once the run in flight finishes.
							</span>
						)}
					</div>
				) : null}

				{effective === null ? (
					<p className="rounded-xl border border-border border-dashed bg-muted/40 p-6 text-center text-muted-foreground text-sm">
						No analysis yet.
						{canEdit
							? " Generate one to see the angle, key details, recommended content types and the decisions that still need an answer."
							: ""}
					</p>
				) : (
					<div className="space-y-6">
						{showingPrevious ? (
							<p className="text-muted-foreground text-xs">
								Showing the previous analysis (version{" "}
								{aiVersion}).
							</p>
						) : null}

						{proseIsEmpty ? (
							<EmptyProseNotice
								effective={effective}
								canEdit={canEdit}
							/>
						) : null}

						{loadedProposal !== null ? (
							<div
								data-testid="assistant-proposal-notice"
								className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-highlight/40 bg-highlight/10 p-3"
							>
								<p className="text-sm">
									The assistant's rewrite is loaded below.
									Nothing is saved until you save it.
								</p>
								<Button
									size="sm"
									variant="outline"
									onClick={discardProposal}
								>
									Discard it
								</Button>
							</div>
						) : null}

						{/* Keyed on the seed, not merely fed it: the editor seeds
						    `prose` on mount and never re-syncs, so every change of
						    seed has to remount it — and nothing else may. */}
						<PlanningAnalysisEditor
							key={seed.generation}
							projectId={projectId}
							topicId={topicId}
							organizationId={organizationId}
							// Under review the seed is the DIFF, not the
							// proposal: the marker tokens `diffPartialText`
							// emits survive markdown parsing and become the
							// `<ins>` / `<del>` the editor's schema binds.
							prose={
								review !== null
									? diffPartialText(
											review.baseline,
											review.proposed,
											true,
										)
									: (loadedProposal ?? effective.prose)
							}
							revisionVersion={revisionVersion}
							sourceAnalysisVersion={
								pendingSourceVersion ?? sourceAnalysisVersion
							}
							canEdit={canEdit}
							// A review is not a run: the author is meant to
							// type in it, accepting and rejecting hunks. An
							// assistant run is, though — and it ends before
							// the accept/reject card appears, so the review
							// window is still unlocked.
							isLocked={isGenerating || assistantRunActive}
							changeSummary={
								review !== null
									? {
											bullets: changeSummary,
											isLoading: summarize.isPending,
										}
									: null
							}
							lockReason={
								isGenerating ? "regenerating" : "assistant"
							}
							diffReview={
								review !== null
									? {
											onAcceptAll: acceptReview,
											onRejectAll: rejectReview,
										}
									: null
							}
							onSaved={handleSaved}
							// Inside the editor's surface, as the document's own
							// tail rather than a block after it. It rendered as a
							// sibling below this whole tab, past a clamped editor
							// region, so on a real analysis it was a scroll beyond
							// what looked like the end — and the contents rail,
							// which indexes only the editor's headings, could not
							// see it either.
							footer={
								data ? (
									<AnalysisDataSections doc={data} />
								) : null
							}
						/>
					</div>
				)}

				<AnalysisVersionHistory
					open={historyOpen}
					onOpenChange={setHistoryOpen}
					projectId={projectId}
					topicId={topicId}
					organizationId={organizationId}
					currentVersion={revisionVersion}
					onRestore={refreshAnalysis}
				/>

				<Dialog open={newerOpen} onOpenChange={setNewerOpen}>
					<DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
						<DialogHeader>
							<DialogTitle>
								Planning analysis version {aiVersion}
							</DialogTitle>
							<DialogDescription>
								What the latest run wrote. Your own text is
								untouched until you replace it.
							</DialogDescription>
						</DialogHeader>

						<div className="prose prose-sm max-w-none dark:prose-invert">
							<Markdown>{newerProse ?? ""}</Markdown>
						</div>

						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setNewerOpen(false)}
							>
								Close
							</Button>
							{canEdit ? (
								<Button
									type="button"
									onClick={() => {
										setNewerOpen(false);
										onReview();
									}}
								>
									Review changes
								</Button>
							) : null}
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>
		</TooltipProvider>
	);
}

/**
 * A document with no words in it, said two different ways.
 *
 * "Nobody has written anything" and "somebody deliberately removed what was
 * written" are different facts, and `overridden` is the only thing that can
 * tell them apart — an author who deletes every word has made a decision, and
 * a reader who cannot see that will re-seed the document from the AI text
 * they just took out.
 */
function EmptyProseNotice({
	effective,
	canEdit,
}: {
	effective: EffectiveAnalysis;
	canEdit: boolean;
}) {
	if (effective.overridden) {
		return (
			<p className="rounded-xl border border-border border-dashed bg-muted/40 p-6 text-center text-muted-foreground text-sm">
				Someone cleared this analysis. The text was removed on purpose,
				not lost —{" "}
				{canEdit
					? "write a new one below, or restore an earlier version from the history."
					: "an earlier version is still in the history."}
			</p>
		);
	}

	return (
		<p className="rounded-xl border border-border border-dashed bg-muted/40 p-6 text-center text-muted-foreground text-sm">
			{isEmptyAnalysis(effective)
				? "This analysis came back empty. The topic's sources may not carry enough to plan from yet."
				: "This analysis produced no written summary — only the structured recommendations below."}
		</p>
	);
}

const BANNER_TONES = {
	info: "flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3 text-muted-foreground text-sm",
	warning:
		"flex items-start gap-2 rounded-lg border border-highlight/40 bg-highlight/5 p-3 text-foreground text-sm",
	error: "flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm",
} as const;

function Banner({
	tone,
	children,
}: {
	tone: keyof typeof BANNER_TONES;
	children: React.ReactNode;
}) {
	return (
		<p
			className={BANNER_TONES[tone]}
			// Only an error interrupts. A run that is merely in flight, or an
			// analysis that has moved on without the document, is news the
			// reader gets to when they get to it.
			role={tone === "error" ? "alert" : "status"}
		>
			{tone === "info" ? (
				<Loader2Icon
					className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin"
					aria-hidden="true"
				/>
			) : (
				<AlertTriangleIcon
					className="mt-0.5 size-4 shrink-0"
					aria-hidden="true"
				/>
			)}
			<span>{children}</span>
		</p>
	);
}

/**
 * The content-type buckets are NOT rendered here.
 *
 * They were a fourth rendering of a recommendation the reader already has in
 * three better places: the `+ Add type` popover, the post-types dialog and the
 * inline checklist all show the same per-type rationale, and all three sit at
 * the point where the decision is actually made. Repeating it at the foot of
 * the analysis added length to a section whose whole complaint was that nobody
 * reads it, and gave the reader a list of content types with no control on it.
 *
 * The FIELD stays exactly as it is — `contentTypes` still gates which media
 * tabs are offered and still feeds the picker. Only this echo of it goes.
 */
const UNRENDERED_BUCKET_KEYS = new Set(["contentTypes"]);

/**
 * The half the product reads by NAME: the supporting-asset buckets and the
 * source signals. These are not part of the editable document — `sourceSignals`
 * is provenance, so an author editing prose cannot silently rewrite it.
 */
function AnalysisDataSections({
	doc,
}: {
	doc: ReturnType<typeof readPlanningAnalysis>;
}) {
	const buckets = doc.buckets.filter(
		(section) => !UNRENDERED_BUCKET_KEYS.has(section.key),
	);

	if (buckets.length === 0 && doc.sourceSignals.length === 0) {
		return null;
	}

	return (
		<div className="space-y-6">
			{buckets.map((section) => (
				<Section key={section.key} label={section.label}>
					<div className="space-y-4">
						{section.buckets.map((bucket) => (
							<div key={bucket.key} className="space-y-1.5">
								<p className="font-medium text-foreground text-sm">
									{bucket.label}
								</p>
								<ul className="space-y-1.5">
									{bucket.items.map((item) => (
										<li
											key={`${item.type}-${item.rationale}`}
											className="text-sm leading-relaxed"
										>
											<span className="text-foreground">
												{item.type}
											</span>
											<span className="text-muted-foreground">
												{" "}
												— {item.rationale}
											</span>
										</li>
									))}
								</ul>
							</div>
						))}
					</div>
				</Section>
			))}

			{doc.sourceSignals.length > 0 ? (
				<SourceSignals items={doc.sourceSignals} />
			) : null}
		</div>
	);
}

/**
 * Provenance, collapsed to one line.
 *
 * Source signals are the inventory of what the analysis had to work with. On a
 * topic whose only inputs are its own title and summary they restate what is
 * already at the top of the page, and they were being read as filler; they earn
 * their space only when the analysis had meetings, pull requests or documents
 * behind it and the reader is asking "why does it say that?". So the count is
 * always visible and the list is one click away, rather than the reverse. Same
 * treatment the generalization notes already carry, and a native `<details>`
 * for the same reason: it needs no state and it survives print and find-in-page.
 */
function SourceSignals({ items }: { items: string[] }) {
	return (
		<details className="group space-y-2">
			<summary className="flex cursor-pointer list-none items-center gap-2">
				<h3 className="publishing-label">Source signals</h3>
				<span className="text-muted-foreground text-xs">
					{items.length}
				</span>
				<ChevronDownIcon
					className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
					aria-hidden="true"
				/>
			</summary>
			<ul className="list-disc space-y-1.5 pl-5 text-muted-foreground text-sm leading-relaxed">
				{items.map((item) => (
					<li key={item}>{item}</li>
				))}
			</ul>
		</details>
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
			<h3 className="publishing-label">{label}</h3>
			{children}
		</section>
	);
}

/**
 * Who wrote what is on screen.
 *
 * The prompt note is the load-bearing part of the provenance: an analysis
 * built from the default body because a bound prompt would not render reads
 * exactly like one built from the bound prompt, so it is the one fact about a
 * run a reader cannot recover from the output itself. It describes the READY
 * analysis on screen, and arrives as two scalars for that reason — a line that
 * read it off the newest ATTEMPT would go blank the moment a regeneration
 * failed, and FAILED is terminal: the note would be gone until someone
 * retried, on precisely the analysis a reader has most reason to question.
 *
 * Rendered in the header beside Generate/Regenerate and History rather than in
 * a footer under the document: it is a statement about what those two buttons
 * did and will do, and under a full analysis plus its data sections it sat far
 * below the fold, describing a button the reader could no longer see.
 */
function DocumentProvenance({
	revisionVersion,
	aiVersion,
	author,
	revisionCreatedAt,
	aiModel,
	aiPromptSource,
}: {
	revisionVersion: number | null;
	aiVersion: number | null;
	author: { id: string; name: string } | null;
	revisionCreatedAt: string | Date | null;
	aiModel: string | null;
	aiPromptSource: string | null;
}) {
	const usedDefault =
		aiPromptSource === "DEFAULT_UNBOUND" ||
		aiPromptSource === "DEFAULT_RENDER_FAILED";

	return (
		<p className="text-muted-foreground text-xs">
			{revisionVersion === null
				? `Not edited yet — showing analysis version ${aiVersion ?? "—"}`
				: /* SAVED by, not EDITED by.
				  
				     "Replace with the newer analysis" writes a revision through
				     the same save path as a hand edit — deliberately, so it
				     lands in history and rolls back like anything else — which
				     meant taking the AI's text was reported as having edited
				     it. Somebody reading the line to answer "who wrote this?"
				     was told the wrong thing about the one case where the
				     answer is "the model did".
				  
				     Distinguishing the two properly needs a column on the
				     revision saying how it was made; "saved" is true of both
				     and claims nothing that is not. */
					`Version ${revisionVersion} · saved by ${author?.name?.trim() || UNKNOWN_AUTHOR_LABEL}${
						revisionCreatedAt
							? ` · ${formatWhen(revisionCreatedAt)}`
							: ""
					}`}
			{aiModel ? ` · ${aiModel}` : ""}
			{usedDefault
				? aiPromptSource === "DEFAULT_RENDER_FAILED"
					? " · built from the default prompt (the bound prompt did not render)"
					: " · built from the default prompt"
				: ""}
		</p>
	);
}

function formatWhen(value: string | Date): string {
	return new Intl.DateTimeFormat("en-US", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}
