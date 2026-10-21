import type { Editor } from "@tiptap/core";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";
import type { RoomStamp } from "./generation-run-awareness";

/**
 * The bookkeeping of a generation run this editor started or follows, held by
 * `DocumentEditor` beside `isRegenerating` (Fizzy #2946).
 *
 * `CollaborativeDocumentEditor` unmounts `DocumentEditorInner` whenever the
 * collaboration room loses sync and mounts a fresh one when it is back. Kept
 * in the inner editor, this state was reset by that remount in the middle of
 * a run, while `isRegenerating` survived: the review found no baseline, took
 * the body the editor had loaded for the run's result, published this editor
 * as the run's starter (which stops every attached editor from adopting the
 * real result), and later the run's own body was never reviewed. Kept here, a
 * remounted editor picks the run up where it was.
 */
export interface GenerationRunState {
	/** The body the run started from; `null` while this editor holds no run. */
	baselineRef: RefObject<string | null>;
	/** The run in flight is one this editor follows rather than started. */
	attachedRunRef: RefObject<boolean>;
	/** When the server acknowledged the run; dates a later FAILED. */
	ackAtRef: RefObject<number | null>;
	/** The five-minute safety timer of a run this editor started. */
	safetyTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
	/** The assistant's `regenerate_document` call, answered by the review. */
	respondRef: RefObject<((result: { accepted: boolean }) => void) | null>;
	triggeredRef: RefObject<boolean>;
	isDirectRef: RefObject<boolean>;
	autoGenerationStartedRef: RefObject<boolean>;
	/** See `editorBodyVersionRef` in `DocumentEditorInner`. */
	editorBodyVersionRef: RefObject<number | undefined>;
	/**
	 * The server's `contentHash` for the body `editorBodyVersionRef` names,
	 * when known: with it, the base the single-user editor's saves name
	 * (Fizzy #2946).
	 */
	editorBodyHashRef: RefObject<string | undefined>;
	/**
	 * The saved body under review — the run's result — as a room stamp, taken
	 * from the same snapshot as `newContent`. Written into the room with it.
	 */
	reviewStampRef: RefObject<RoomStamp | null>;
	/**
	 * The saved version of the body under review, taken from the same
	 * snapshot, also when the server named no identity for it. A Reject names
	 * it, so the server refuses one whose review a newer write has superseded
	 * (Fizzy #2946).
	 */
	reviewedVersionRef: RefObject<number | null>;
	/**
	 * The reviewed run's identity: the document's `generationStartedAt` (ISO)
	 * from the same snapshot, which dispatch stamps afresh for every run. A
	 * Reject names it, so the server refuses one when a newer run wrote the
	 * document, even with the very same body (Fizzy #2946).
	 */
	reviewedRunStartedAtRef: RefObject<string | null>;
	/**
	 * The editor on screen now, or `null` while none is mounted. A deferred
	 * write reads it when it lands: the editor of the render that scheduled
	 * the write may have been destroyed by then, by a remount or because a
	 * hidden tab held the frame back.
	 */
	liveEditorRef: RefObject<Editor | null>;
	/**
	 * The review's body once it has been written into an editor, while the
	 * review is open. The room keeps it from then on, across remounts.
	 */
	reviewAppliedRef: RefObject<string | null>;
	/**
	 * A Reject sent and not yet settled — answered, refused, or its fallback
	 * save answered. Held here, not in an editor, so a sync-loss remount
	 * neither drops it nor lets the new editor take input before the
	 * outcome is applied (Fizzy #2946).
	 */
	rejectPending: boolean;
	setRejectPending: Dispatch<SetStateAction<boolean>>;
	/**
	 * Whether anything was typed, in any editor of this document, since the
	 * Reject went: offered back before its outcome replaces it.
	 */
	typedSinceRejectRef: RefObject<boolean>;
	isConfirming: boolean;
	setIsConfirming: Dispatch<SetStateAction<boolean>>;
	showConfirmDialog: boolean;
	setShowConfirmDialog: Dispatch<SetStateAction<boolean>>;
	previousContent: string;
	setPreviousContent: Dispatch<SetStateAction<string>>;
	newContent: string;
	setNewContent: Dispatch<SetStateAction<string>>;
}

export function useGenerationRunState(): GenerationRunState {
	const baselineRef = useRef<string | null>(null);
	const attachedRunRef = useRef(false);
	const ackAtRef = useRef<number | null>(null);
	const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const respondRef = useRef<((result: { accepted: boolean }) => void) | null>(
		null,
	);
	const triggeredRef = useRef(false);
	const isDirectRef = useRef(false);
	const autoGenerationStartedRef = useRef(false);
	const editorBodyVersionRef = useRef<number | undefined>(undefined);
	const editorBodyHashRef = useRef<string | undefined>(undefined);
	const reviewStampRef = useRef<RoomStamp | null>(null);
	const reviewedVersionRef = useRef<number | null>(null);
	const reviewedRunStartedAtRef = useRef<string | null>(null);
	const liveEditorRef = useRef<Editor | null>(null);
	const reviewAppliedRef = useRef<string | null>(null);
	const [isConfirming, setIsConfirming] = useState(false);
	const [rejectPending, setRejectPending] = useState(false);
	const typedSinceRejectRef = useRef(false);
	const [showConfirmDialog, setShowConfirmDialog] = useState(false);
	const [previousContent, setPreviousContent] = useState("");
	const [newContent, setNewContent] = useState("");

	// The timer belongs to the run, not to one mount of the editor, so it is
	// cancelled only when the document editor itself goes away.
	useEffect(() => {
		return () => {
			if (safetyTimerRef.current) {
				clearTimeout(safetyTimerRef.current);
				safetyTimerRef.current = null;
			}
		};
	}, []);

	return {
		baselineRef,
		attachedRunRef,
		ackAtRef,
		safetyTimerRef,
		respondRef,
		triggeredRef,
		isDirectRef,
		autoGenerationStartedRef,
		editorBodyVersionRef,
		editorBodyHashRef,
		reviewStampRef,
		reviewedVersionRef,
		reviewedRunStartedAtRef,
		liveEditorRef,
		reviewAppliedRef,
		rejectPending,
		setRejectPending,
		typedSinceRejectRef,
		isConfirming,
		setIsConfirming,
		showConfirmDialog,
		setShowConfirmDialog,
		previousContent,
		setPreviousContent,
		newContent,
		setNewContent,
	};
}
