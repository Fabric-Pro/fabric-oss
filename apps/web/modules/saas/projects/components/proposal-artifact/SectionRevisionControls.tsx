"use client";

import { SECTION_REVISION_INSTRUCTION_MAX_CHARS } from "@repo/utils/proposal-artifact/scoped-revision-codes";
import { buildSectionMap } from "@repo/utils/proposal-artifact/section-hash";
import type { Editor } from "@tiptap/react";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { WandSparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";

/**
 * "Revise this section" (Fizzy #2946): a control beside each `##` heading of
 * a client-document Proposal's Main that asks for a revision of that
 * section on the member's own instruction.
 *
 * The control shows while the pointer is over the heading, the caret is in
 * it or it has keyboard focus; the buttons follow the editor in the tab
 * order, one per heading, each named after its section. It opens a box
 * under the heading; submitting it hands the section's key and the
 * instruction to `onRequest`, which runs the same section revision as Apply
 * recommendation: the editor shows the section's diff for Accept or Reject.
 * Escape closes the box and returns focus to the control.
 *
 * The headings are read from the editor's DOM, never changed: the controls
 * are a layer of their own, positioned over the content, so typing in a
 * heading and the collaborative room are untouched. The section key is
 * resolved when the box is submitted, from the editor's own Markdown: the
 * n-th root `##` of the editor is the n-th `##` section of its section map.
 */

/** One root `##` of the editor, where the layer draws its control. */
interface HeadingSlot {
	/** Its place among the editor's root `##` headings. */
	index: number;
	/** Its text, whitespace collapsed. */
	text: string;
	/** Offsets from the layer's top, in pixels. */
	top: number;
	bottom: number;
	/**
	 * Its edges, in pixels, from the layer's left and right edges. The layer
	 * spans the editor's padding, which a heading's band does not, so the
	 * control and the box are placed by the heading itself.
	 */
	left: number;
	right: number;
}

/** How far the control sits inside its heading's right edge, in pixels. */
const TRIGGER_INSET_PX = 12;

interface SectionRevisionControlsProps {
	editor: Editor | null;
	/**
	 * Whether a revision may be asked for now: the member may revise this
	 * document and nothing else holds the editor. Read beside the editor's
	 * own editability.
	 */
	enabled: boolean;
	/** The editor's body as Markdown, as its save would store it. */
	getMarkdown: () => string | null;
	/**
	 * Starts the revision; `false` when it was not taken (another revision
	 * stands), and the box stays open.
	 */
	onRequest: (request: {
		sectionKey: string;
		instruction: string;
	}) => boolean;
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The editor's root `##` elements, in document order. */
function rootHeadings(root: HTMLElement): HTMLElement[] {
	return Array.from(root.children).filter(
		(child): child is HTMLElement => child.tagName === "H2",
	);
}

/**
 * The key of the section the editor's `index`-th root `##` starts, from the
 * editor's Markdown. By position when the counts agree, else by its text
 * when exactly one `##` section has it; null when neither finds it.
 */
export function resolveHeadingSectionKey(
	markdown: string,
	heading: { index: number; text: string; count: number },
): string | null {
	const sections = buildSectionMap(markdown).sections.filter(
		(section) => section.depth === 2 && section.headingText !== null,
	);
	if (sections.length === heading.count) {
		const byIndex = sections[heading.index];
		if (byIndex && collapse(byIndex.headingText ?? "") === heading.text) {
			return byIndex.key;
		}
	}
	const byText = sections.filter(
		(section) => collapse(section.headingText ?? "") === heading.text,
	);
	return byText.length === 1 ? (byText[0]?.key ?? null) : null;
}

export function SectionRevisionControls({
	editor,
	enabled,
	getMarkdown,
	onRequest,
}: SectionRevisionControlsProps) {
	const t = useTranslations("projects.proposalArtifact.revision.instruction");
	const tRevision = useTranslations("projects.proposalArtifact.revision");
	const layerRef = useRef<HTMLDivElement>(null);
	const triggerRefs = useRef(new Map<number, HTMLButtonElement>());
	const boxId = useId();
	const [editable, setEditable] = useState(false);
	const [slots, setSlots] = useState<HeadingSlot[]>([]);
	const [pointerIndex, setPointerIndex] = useState<number | null>(null);
	const [triggerHoverIndex, setTriggerHoverIndex] = useState<number | null>(
		null,
	);
	const [caretIndex, setCaretIndex] = useState<number | null>(null);
	const [openIndex, setOpenIndex] = useState<number | null>(null);
	// The open box's heading text, to find it again when headings move.
	const openTextRef = useRef<string | null>(null);
	const [instruction, setInstruction] = useState("");
	// Said politely when the open box closes on its own.
	const [announcement, setAnnouncement] = useState("");
	const active = enabled && editable;

	// Where the headings are, and which one holds the caret, after every
	// change of the editor and every resize.
	const measure = useCallback(() => {
		const layer = layerRef.current;
		if (!editor || editor.isDestroyed || !layer) {
			return;
		}
		setEditable(editor.isEditable);
		const root = editor.view.dom as HTMLElement;
		const layerRect = layer.getBoundingClientRect();
		const headings = rootHeadings(root);
		const next = headings.map((element, index) => {
			const rect = element.getBoundingClientRect();
			return {
				index,
				text: collapse(element.textContent ?? ""),
				top: rect.top - layerRect.top,
				bottom: rect.bottom - layerRect.top,
				left: Math.max(0, rect.left - layerRect.left),
				right: Math.max(0, layerRect.right - rect.right),
			};
		});
		setSlots((previous) =>
			previous.length === next.length &&
			previous.every(
				(slot, i) =>
					slot.text === next[i]?.text &&
					slot.top === next[i]?.top &&
					slot.bottom === next[i]?.bottom &&
					slot.left === next[i]?.left &&
					slot.right === next[i]?.right,
			)
				? previous
				: next,
		);
		let caret: number | null = null;
		if (editor.isFocused) {
			try {
				const { node } = editor.view.domAtPos(
					editor.state.selection.from,
				);
				const element =
					node instanceof HTMLElement ? node : node.parentElement;
				const heading = element?.closest("h2");
				const at = heading
					? headings.indexOf(heading as HTMLElement)
					: -1;
				caret = at >= 0 ? at : null;
			} catch {
				// A position the view cannot map yet: no caret heading.
			}
		}
		setCaretIndex(caret);
	}, [editor]);

	useLayoutEffect(() => {
		if (!editor) {
			return;
		}
		let frame: number | null = null;
		const schedule = () => {
			if (frame !== null) {
				return;
			}
			frame = requestAnimationFrame(() => {
				frame = null;
				measure();
			});
		};
		measure();
		editor.on("update", schedule);
		editor.on("transaction", schedule);
		editor.on("focus", schedule);
		editor.on("blur", schedule);
		window.addEventListener("resize", schedule);
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(schedule);
		// The editor scrolls on its own when its content overflows, which
		// moves the headings' edges under the layer.
		const scroller = editor.isDestroyed ? null : editor.view.dom;
		scroller?.addEventListener("scroll", schedule, { passive: true });
		if (!editor.isDestroyed) {
			observer?.observe(editor.view.dom);
		}
		return () => {
			if (frame !== null) {
				cancelAnimationFrame(frame);
			}
			editor.off("update", schedule);
			editor.off("transaction", schedule);
			editor.off("focus", schedule);
			editor.off("blur", schedule);
			window.removeEventListener("resize", schedule);
			scroller?.removeEventListener("scroll", schedule);
			observer?.disconnect();
		};
	}, [editor, measure]);

	// The heading under the pointer.
	useEffect(() => {
		if (!editor || editor.isDestroyed) {
			return;
		}
		const root = editor.view.dom as HTMLElement;
		const onMove = (event: MouseEvent) => {
			const heading =
				event.target instanceof Element
					? event.target.closest("h2")
					: null;
			const at =
				heading && heading.parentElement === root
					? rootHeadings(root).indexOf(heading as HTMLElement)
					: -1;
			setPointerIndex(at >= 0 ? at : null);
		};
		const onLeave = () => setPointerIndex(null);
		root.addEventListener("mousemove", onMove);
		root.addEventListener("mouseleave", onLeave);
		return () => {
			root.removeEventListener("mousemove", onMove);
			root.removeEventListener("mouseleave", onLeave);
		};
	}, [editor]);

	// The open box follows its heading when the headings above it change,
	// and closes, saying so, once that heading is gone. While the editor
	// takes no input (a review elsewhere, a run, the room catching up) the
	// box stays open with what was typed; only its submit waits.
	useEffect(() => {
		const text = openTextRef.current;
		if (openIndex === null || text === null) {
			return;
		}
		if (slots[openIndex]?.text === text) {
			return;
		}
		const moved = slots.findIndex((slot) => slot.text === text);
		if (moved >= 0) {
			setOpenIndex(moved);
			return;
		}
		openTextRef.current = null;
		setOpenIndex(null);
		setInstruction("");
		setAnnouncement(t("headingGone"));
		// Its field had focus, which would otherwise fall to the page.
		if (editor && !editor.isDestroyed && editor.isEditable) {
			editor.view.focus();
		}
	}, [slots, openIndex, editor, t]);

	const close = useCallback(
		(returnFocus: boolean) => {
			const trigger =
				openIndex === null
					? undefined
					: triggerRefs.current.get(openIndex);
			openTextRef.current = null;
			setOpenIndex(null);
			setInstruction("");
			if (returnFocus) {
				trigger?.focus();
			}
		},
		[openIndex],
	);

	const submit = useCallback(() => {
		const slot = openIndex === null ? undefined : slots[openIndex];
		const text = instruction.trim();
		if (!slot || slot.text !== openTextRef.current || !text || !active) {
			return;
		}
		const markdown = getMarkdown();
		const sectionKey =
			markdown === null
				? null
				: resolveHeadingSectionKey(markdown, {
						index: slot.index,
						text: slot.text,
						count: slots.length,
					});
		if (sectionKey === null) {
			toast.error(
				tRevision("notApplied", {
					reason: t("sectionNotFound"),
				}),
			);
			return;
		}
		if (onRequest({ sectionKey, instruction: text })) {
			openTextRef.current = null;
			setOpenIndex(null);
			setInstruction("");
		}
	}, [
		openIndex,
		slots,
		instruction,
		active,
		getMarkdown,
		onRequest,
		t,
		tRevision,
	]);

	if (!editor) {
		return null;
	}

	// Never drawn under another heading for the render before the box
	// follows its own.
	const atIndex = openIndex === null ? undefined : slots[openIndex];
	const open =
		atIndex && atIndex.text === openTextRef.current ? atIndex : undefined;

	return (
		<div
			ref={layerRef}
			className="pointer-events-none absolute inset-x-0 top-0 h-0"
			data-section-revision-controls=""
		>
			<output className="sr-only">{announcement}</output>
			{slots.map((slot) => {
				const isOpen = openIndex === slot.index;
				// While the editor takes no input only the open box's own
				// control stays, so Escape has somewhere to return.
				if (!active && !isOpen) {
					return null;
				}
				const shown =
					isOpen ||
					pointerIndex === slot.index ||
					triggerHoverIndex === slot.index ||
					caretIndex === slot.index;
				return (
					<button
						key={slot.index}
						ref={(element) => {
							if (element) {
								triggerRefs.current.set(slot.index, element);
							} else {
								triggerRefs.current.delete(slot.index);
							}
						}}
						type="button"
						aria-label={t("triggerLabel", {
							section: slot.text,
						})}
						aria-expanded={isOpen}
						aria-controls={isOpen ? boxId : undefined}
						data-shown={shown ? "true" : "false"}
						onMouseEnter={() => setTriggerHoverIndex(slot.index)}
						onMouseLeave={() => setTriggerHoverIndex(null)}
						onClick={() => {
							if (isOpen) {
								close(false);
							} else {
								setInstruction("");
								setAnnouncement("");
								openTextRef.current = slot.text;
								setOpenIndex(slot.index);
							}
						}}
						style={{
							top: Math.max(
								0,
								slot.top + (slot.bottom - slot.top - 28) / 2,
							),
							right: slot.right + TRIGGER_INSET_PX,
						}}
						className={cn(
							"absolute z-20 inline-flex h-7 items-center gap-1.5 rounded-md border bg-background/95 px-2 text-xs font-medium text-muted-foreground shadow-xs transition-opacity hover:bg-muted hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
							shown
								? "pointer-events-auto opacity-100"
								: "opacity-0",
						)}
					>
						<WandSparkles
							className="h-3.5 w-3.5"
							aria-hidden="true"
						/>
						{t("trigger")}
					</button>
				);
			})}
			{open && (
				<form
					id={boxId}
					aria-label={t("boxLabel", { section: open.text })}
					className="pointer-events-auto absolute z-30 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
					style={{
						top: open.bottom + 4,
						left: open.left,
						right: open.right,
					}}
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
					onKeyDown={(event) => {
						// Never into the editor underneath.
						event.stopPropagation();
						if (event.key === "Escape") {
							event.preventDefault();
							close(true);
						}
					}}
				>
					<Label htmlFor={`${boxId}-instruction`} className="text-sm">
						{t("fieldLabel")}
					</Label>
					<Textarea
						id={`${boxId}-instruction`}
						autoFocus
						value={instruction}
						maxLength={SECTION_REVISION_INSTRUCTION_MAX_CHARS}
						rows={3}
						placeholder={t("placeholder")}
						aria-describedby={`${boxId}-hint ${boxId}-count`}
						className="mt-1.5"
						onChange={(event) => setInstruction(event.target.value)}
						onKeyDown={(event) => {
							if (
								event.key === "Enter" &&
								(event.ctrlKey || event.metaKey)
							) {
								event.preventDefault();
								submit();
							}
						}}
					/>
					<div className="mt-1.5 flex items-start justify-between gap-3 text-xs text-muted-foreground">
						<p id={`${boxId}-hint`}>{t("hint")}</p>
						<p
							id={`${boxId}-count`}
							className="shrink-0 tabular-nums"
						>
							{t("counter", {
								count: instruction.length,
								max: SECTION_REVISION_INSTRUCTION_MAX_CHARS,
							})}
						</p>
					</div>
					<div className="mt-2 flex items-center justify-end gap-2">
						<span className="mr-auto text-xs text-muted-foreground">
							{t("shortcut")}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => close(true)}
						>
							{t("cancel")}
						</Button>
						<Button
							type="submit"
							size="sm"
							disabled={!active || instruction.trim() === ""}
							aria-describedby={
								active ? undefined : `${boxId}-paused`
							}
						>
							{t("submit")}
						</Button>
					</div>
					{/* Present while the box is, so the reason is announced
					    when it appears. */}
					<output
						id={`${boxId}-paused`}
						className={cn(
							"block text-xs text-muted-foreground",
							active ? "sr-only" : "mt-2",
						)}
					>
						{active ? "" : t("paused")}
					</output>
				</form>
			)}
		</div>
	);
}
