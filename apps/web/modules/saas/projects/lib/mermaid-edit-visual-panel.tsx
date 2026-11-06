"use client";

import {
	VISUAL_EDIT_INSTRUCTION_MAX_CHARS,
	visualSourceHash,
} from "@repo/utils/proposal-artifact/visual-identity";
import { orpcClient } from "@shared/lib/orpc-client";
import { Loader2, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useSyncExternalStore,
} from "react";
import { getOrpcCode } from "../components/field-mapping/orpc-error";
import type {
	VisualEditOutcome as Outcome,
	VisualEditPhase as Phase,
	VisualEditStore,
} from "./mermaid-edit-visual-store";
import type { MermaidVisualContextValue } from "./mermaid-visual-context";

/** Where the character count starts to show. */
const COUNTER_FROM = 450;

const IDLE: Phase = { kind: "idle" };

/** The outcomes whose instruction is sent again by Try again. */
const RETRYABLE: ReadonlySet<Outcome> = new Set([
	"stale",
	"refused",
	"error",
	"rateLimited",
]);

type EditVisualResult = Awaited<
	ReturnType<typeof orpcClient.projects.proposalArtifact.editVisual>
>;

const STATUS_OUTCOME: Record<
	Exclude<EditVisualResult["status"], "CANDIDATE">,
	Outcome
> = {
	STALE: "stale",
	FACT_CHECK_REFUSED: "refused",
	UNSUPPORTED_DIAGRAM: "unsupported",
	AI_PROVIDER_NOT_CONFIGURED: "providerMissing",
	RATE_LIMITED: "rateLimited",
};

function outcomeOfError(error: unknown): Outcome {
	const code = getOrpcCode(error);
	if (code === "FORBIDDEN" || code === "NOT_FOUND") {
		return "forbidden";
	}
	if (code === "TOO_MANY_REQUESTS") {
		return "rateLimited";
	}
	return "error";
}

/** The generate button's label: Try again or Retry after a retryable outcome. */
function generateLabelKey(
	phase: Phase,
): "panel.generate" | "panel.tryAgain" | "panel.retry" {
	if (phase.kind !== "outcome" || !RETRYABLE.has(phase.outcome)) {
		return "panel.generate";
	}
	return phase.outcome === "error" ? "panel.retry" : "panel.tryAgain";
}

/**
 * Edit with instructions on one diagram of a client-document Proposal
 * (Fizzy #2946): the person describes a change, the server returns a
 * fact-checked candidate, and the candidate shows below the current diagram
 * until it is applied or discarded.
 *
 * The server reads Main from the database, so the editor is saved first.
 * Applying happens here, not on the server: the node's source hash is
 * checked against the one the request was made from, its marker id against
 * the candidate's, and its section's text against the fingerprint of the
 * section the server checked the candidate against, and only that node is
 * replaced, so the normal save (and the collaborative room) persist it.
 *
 * What is typed, the request and its candidate live in `visual.editStore`
 * under `entryKey`, not here: the diagram's node view is drawn again when a
 * collaborative editor gets its room back, and the panel it then shows is
 * this one, a request in flight included. A candidate shown again is checked
 * against the diagram as it is then, and reads as stale when it no longer
 * applies.
 */
export function MermaidEditVisualPanel({
	visual,
	entryKey,
	candidateApplies,
	applyCandidate,
	renderCandidate,
	onClose,
	announce,
	textareaRef,
}: {
	visual: MermaidVisualContextValue;
	/** The diagram's panel in `visual.editStore`, open. */
	entryKey: string;
	/**
	 * Whether the node still holds `sentHash`'s source, still keeps
	 * `visualId` when it names one, and its section still has
	 * `sectionFingerprint`.
	 */
	candidateApplies: (
		sentHash: string,
		sectionFingerprint: string,
		visualId: string,
	) => boolean;
	/** Replaces the node when `candidateApplies`. */
	applyCandidate: (
		fence: string,
		sentHash: string,
		sectionFingerprint: string,
		visualId: string,
	) => "applied" | "stale";
	/** The candidate's sanitized SVG; throws when it cannot be drawn. */
	renderCandidate: (code: string) => Promise<string>;
	/** The panel is done: applied, discarded or cancelled. */
	onClose: (result: "applied" | "discarded" | "cancelled") => void;
	/** Says progress and outcomes in the diagrams' polite live region. */
	announce: (message: string) => void;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
	const t = useTranslations("projects.proposalArtifact.visuals");
	const store: VisualEditStore = visual.editStore;
	const readEntry = () => store.get(entryKey);
	const entry = useSyncExternalStore(store.subscribe, readEntry, readEntry);
	const instruction = entry?.instruction ?? "";
	const phase = entry?.phase ?? IDLE;
	const setInstruction = (text: string) =>
		store.update(entryKey, { instruction: text });
	const setPhase = useCallback(
		(next: Phase) => store.update(entryKey, { phase: next }),
		[store, entryKey],
	);
	const counterId = useId();
	const errorId = useId();

	// A candidate shown again, by a node view drawn anew or once the editor
	// takes input again, is checked against the diagram as it is now.
	useEffect(() => {
		const shown = store.get(entryKey)?.phase;
		if (
			shown?.kind === "candidate" &&
			!candidateApplies(
				shown.sentHash,
				shown.sectionFingerprint,
				shown.visualId,
			)
		) {
			setPhase({ kind: "outcome", outcome: "stale" });
		}
	}, [store, entryKey, candidateApplies, setPhase]);

	const trimmed = instruction.trim();
	const tooLong = instruction.length > VISUAL_EDIT_INSTRUCTION_MAX_CHARS;
	const canGenerate =
		trimmed.length > 0 && !tooLong && phase.kind !== "generating";

	const generate = useCallback(async () => {
		if (
			!trimmed ||
			instruction.length > VISUAL_EDIT_INSTRUCTION_MAX_CHARS
		) {
			return;
		}
		const request = store.begin(entryKey);
		// Read, drawn and spoken through the node view drawing the diagram
		// when each step comes: not necessarily this panel's. With none, the
		// diagram is gone, and the progress line is only cleared.
		const say = (message: string) => {
			const host = store.host(entryKey);
			(host?.announce ?? announce)(host ? message : "");
		};
		const settle = (outcome: Outcome) => {
			request.finish();
			setPhase({ kind: "outcome", outcome });
			say("");
		};
		const texts = {
			generating: t("panel.generating"),
			ready: t("panel.candidateReady"),
			renderFailed: t("panel.candidateRenderFailed"),
		};

		setPhase({ kind: "generating" });
		say(texts.generating);

		const saved = await visual.flushSave().catch(() => false);
		if (!request.current()) {
			return;
		}
		const target = store.host(entryKey)?.readTarget() ?? null;
		if (!saved || !target) {
			settle("stale");
			return;
		}
		const sentHash = visualSourceHash(target.code);
		const { visualId } = target;

		let result: EditVisualResult;
		try {
			result = await orpcClient.projects.proposalArtifact.editVisual(
				{
					projectId: visual.projectId,
					documentId: visual.documentId,
					...(visualId ? { visualId } : {}),
					fenceOrdinal: target.ordinal,
					fenceSourceHash: sentHash,
					instruction: trimmed,
				},
				{ signal: request.signal },
			);
		} catch (error) {
			if (request.current()) {
				settle(outcomeOfError(error));
			}
			return;
		}
		if (!request.current()) {
			return;
		}
		if (result.status !== "CANDIDATE") {
			settle(STATUS_OUTCOME[result.status] ?? "error");
			return;
		}

		let svg: string | null = null;
		try {
			svg = await (
				store.host(entryKey)?.renderCandidate ?? renderCandidate
			)(result.fence);
		} catch {
			svg = null;
		}
		if (!request.current()) {
			return;
		}
		request.finish();
		setPhase({
			kind: "candidate",
			fence: result.fence,
			sentHash,
			sectionFingerprint: result.sectionFingerprint,
			visualId: result.visualId,
			svg,
			renderFailed: svg === null,
		});
		say(svg === null ? texts.renderFailed : texts.ready);
	}, [
		instruction,
		trimmed,
		store,
		entryKey,
		visual,
		renderCandidate,
		announce,
		setPhase,
		t,
	]);

	const cancel = () => {
		store.stop(entryKey);
		if (phase.kind === "generating") {
			// Back to the instruction, which stays for another try.
			setPhase({ kind: "idle" });
			announce("");
			requestAnimationFrame(() => textareaRef.current?.focus());
			return;
		}
		onClose("cancelled");
	};

	const apply = () => {
		if (phase.kind !== "candidate" || phase.renderFailed) {
			return;
		}
		if (
			applyCandidate(
				phase.fence,
				phase.sentHash,
				phase.sectionFingerprint,
				phase.visualId,
			) === "stale"
		) {
			setPhase({ kind: "outcome", outcome: "stale" });
			announce("");
			return;
		}
		visual.onVisualReplaced();
		announce(t("panel.applied"));
		onClose("applied");
	};

	const discard = () => {
		announce(t("panel.discarded"));
		onClose("discarded");
	};

	const outcomeMessage = (outcome: Outcome): string => {
		switch (outcome) {
			case "providerMissing":
				return visual.isMember
					? t("states.providerMissingMember")
					: t("states.providerMissingGuest");
			default:
				return t(`states.${outcome}`);
		}
	};

	const isGenerating = phase.kind === "generating";
	const describedBy = [
		instruction.length >= COUNTER_FROM ? counterId : null,
		tooLong ? errorId : null,
	]
		.filter(Boolean)
		.join(" ");

	return (
		<div
			className="mermaid-edit-visual-panel border-b bg-muted/20 px-3 py-3"
			contentEditable={false}
		>
			<p className="mb-2 text-xs font-medium text-foreground">
				{t("panel.title")}
			</p>
			<label className="sr-only" htmlFor={`${counterId}-instruction`}>
				{t("panel.instructionLabel")}
			</label>
			<textarea
				id={`${counterId}-instruction`}
				ref={textareaRef}
				className="min-h-[60px] w-full resize-none rounded-md border bg-background p-2 text-sm outline-none focus:ring-1 focus:ring-primary/50"
				placeholder={t("panel.placeholder")}
				value={instruction}
				onChange={(event) => setInstruction(event.target.value)}
				onKeyDown={(event) => {
					// The editor must not see keys typed into the panel.
					event.stopPropagation();
					if (
						event.key === "Enter" &&
						(event.ctrlKey || event.metaKey) &&
						canGenerate
					) {
						event.preventDefault();
						void generate();
					}
					if (event.key === "Escape") {
						event.preventDefault();
						cancel();
					}
				}}
				disabled={isGenerating}
				aria-describedby={describedBy || undefined}
				aria-invalid={tooLong || undefined}
			/>
			<div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
				{tooLong && (
					<span id={errorId} className="text-destructive">
						{t("panel.tooLong", {
							max: VISUAL_EDIT_INSTRUCTION_MAX_CHARS,
						})}
					</span>
				)}
				{instruction.length >= COUNTER_FROM && (
					<span
						id={counterId}
						className={
							tooLong ? "ml-auto text-destructive" : "ml-auto"
						}
					>
						{t("panel.counter", {
							count: instruction.length,
							max: VISUAL_EDIT_INSTRUCTION_MAX_CHARS,
						})}
					</span>
				)}
			</div>

			{phase.kind === "outcome" && (
				<div
					role="alert"
					className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
				>
					{outcomeMessage(phase.outcome)}
				</div>
			)}

			{phase.kind === "candidate" && (
				<div className="mt-3 rounded-md border bg-card">
					<p className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
						{t("panel.proposed")}
					</p>
					{phase.svg ? (
						<div
							className="mermaid-diagram-area mermaid-candidate-area flex items-center justify-center overflow-auto p-4"
							// biome-ignore lint/security/noDangerouslySetInnerHtml: the candidate is run through sanitizeDiagramSvg by renderCandidate
							dangerouslySetInnerHTML={{ __html: phase.svg }}
						/>
					) : (
						<p
							role="alert"
							className="px-3 py-2 text-xs text-destructive"
						>
							{t("panel.candidateRenderFailed")}
						</p>
					)}
				</div>
			)}

			<div className="mt-2 flex flex-wrap items-center gap-2">
				{phase.kind === "candidate" ? (
					<>
						<button
							type="button"
							onClick={apply}
							disabled={phase.renderFailed}
							className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{t("panel.apply")}
						</button>
						<button
							type="button"
							onClick={discard}
							className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
						>
							{t("panel.discard")}
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							onClick={() => void generate()}
							disabled={!canGenerate}
							className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{isGenerating ? (
								<Loader2
									className="h-3.5 w-3.5 animate-spin"
									aria-hidden="true"
								/>
							) : (
								<Sparkles
									className="h-3.5 w-3.5"
									aria-hidden="true"
								/>
							)}
							{t(generateLabelKey(phase))}
						</button>
						<button
							type="button"
							onClick={cancel}
							className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
						>
							{t("panel.cancel")}
						</button>
					</>
				)}
			</div>
		</div>
	);
}
