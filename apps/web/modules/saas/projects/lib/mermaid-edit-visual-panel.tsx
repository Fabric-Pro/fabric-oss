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
	useRef,
	useState,
} from "react";
import { getOrpcCode } from "../components/field-mapping/orpc-error";
import type { MermaidVisualContextValue } from "./mermaid-visual-context";

/** Where the character count starts to show. */
const COUNTER_FROM = 450;

/** What the diagram holds as the request goes: its source and position. */
export interface VisualEditTarget {
	/** The node's text, marker line included. */
	code: string;
	/** 0-based index among the document's diagrams, in document order. */
	ordinal: number;
	/** The marker id the request names; none for a detached diagram. */
	visualId?: string;
}

type Outcome =
	| "stale"
	| "refused"
	| "unsupported"
	| "providerMissing"
	| "rateLimited"
	| "forbidden"
	| "error";

type Phase =
	| { kind: "idle" }
	| { kind: "generating" }
	| {
			kind: "candidate";
			fence: string;
			sentHash: string;
			sectionFingerprint: string;
			visualId: string;
			svg: string | null;
			renderFailed: boolean;
	  }
	| { kind: "outcome"; outcome: Outcome };

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
 */
export function MermaidEditVisualPanel({
	visual,
	readTarget,
	applyCandidate,
	renderCandidate,
	onClose,
	announce,
	textareaRef,
}: {
	visual: MermaidVisualContextValue;
	/** The diagram as it is now; null once it is gone from the document. */
	readTarget: () => VisualEditTarget | null;
	/**
	 * Replaces the node when it still holds `sentHash`'s source, still keeps
	 * `visualId` when it names one, and its section still has
	 * `sectionFingerprint`.
	 */
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
	const [instruction, setInstruction] = useState("");
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	// Responses to an older or cancelled request are dropped.
	const requestRef = useRef(0);
	const abortRef = useRef<AbortController | null>(null);
	const counterId = useId();
	const errorId = useId();
	// Read by the unmount cleanup, which sees only the first render's phase.
	const generatingRef = useRef(false);
	generatingRef.current = phase.kind === "generating";
	const announceRef = useRef(announce);
	announceRef.current = announce;

	useEffect(
		() => () => {
			requestRef.current += 1;
			abortRef.current?.abort();
			// The live region is shared by every diagram on the page: a panel
			// closed mid-request clears its "Generating" line, or the next
			// request, saying the same words, would not be spoken.
			if (generatingRef.current) {
				announceRef.current("");
			}
		},
		[],
	);

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
		requestRef.current += 1;
		const request = requestRef.current;
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		const current = () => requestRef.current === request;
		const settle = (outcome: Outcome) => {
			setPhase({ kind: "outcome", outcome });
			announce("");
		};

		setPhase({ kind: "generating" });
		announce(t("panel.generating"));

		const saved = await visual.flushSave().catch(() => false);
		if (!current()) {
			return;
		}
		const target = readTarget();
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
				{ signal: controller.signal },
			);
		} catch (error) {
			if (current()) {
				settle(outcomeOfError(error));
			}
			return;
		}
		if (!current()) {
			return;
		}
		if (result.status !== "CANDIDATE") {
			settle(STATUS_OUTCOME[result.status] ?? "error");
			return;
		}

		let svg: string | null = null;
		try {
			svg = await renderCandidate(result.fence);
		} catch {
			svg = null;
		}
		if (!current()) {
			return;
		}
		setPhase({
			kind: "candidate",
			fence: result.fence,
			sentHash,
			sectionFingerprint: result.sectionFingerprint,
			visualId: result.visualId,
			svg,
			renderFailed: svg === null,
		});
		announce(
			svg === null
				? t("panel.candidateRenderFailed")
				: t("panel.candidateReady"),
		);
	}, [
		instruction,
		trimmed,
		visual,
		readTarget,
		renderCandidate,
		announce,
		t,
	]);

	const cancel = () => {
		requestRef.current += 1;
		abortRef.current?.abort();
		abortRef.current = null;
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
