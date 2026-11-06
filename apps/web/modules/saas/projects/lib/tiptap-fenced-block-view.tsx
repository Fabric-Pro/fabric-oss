"use client";

/**
 * The node spec and node view a Proposal's content fences share (Fizzy
 * #2946): stat tiles, card grids and two columns. Each is a fenced block
 * whose body a person writes as text and the view draws as its form.
 *
 * ## Round trip
 *
 * A node holds the fence body as its text, exactly as a code block does,
 * and `renderHTML` writes the same `<pre><code class="language-…">` that
 * `fromMarkdown` produced. The save rule (`fencedCodeBlocks` in
 * `editor-markdown-save.ts`) turns that back into the fence, so a block
 * comes back byte for byte, valid or not: validity only decides what the
 * view draws, never what the document holds.
 *
 * ## Claiming the fence
 *
 * `MermaidBlock` sniffs the first line of every `<pre>` for a diagram
 * keyword, so a body opening "Timeline savings" or "graph notes" would
 * otherwise become a diagram, and the code block claims any other `<pre>`.
 * ProseMirror tries parse rules in descending `priority` (50 when unset,
 * which both of those use), so each node's rule sets a higher one and claims
 * only a `<pre>` whose `<code>` carries its own language class, in its
 * canonical lower case. A bare `<code>` rule is left out on purpose: a block
 * rule on `<code>` could swallow inline code.
 *
 * ## The source
 *
 * The node's text is its content DOM, and TipTap appends that element to the
 * node itself, where it shows as stray text, whenever a view renders no
 * `NodeViewContent`. So the view renders it on every path, and clips it
 * only while the form draws and no AI edit marks the text.
 */

import { Node } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
	NodeViewContent,
	NodeViewWrapper,
	type ReactNodeViewProps,
	ReactNodeViewRenderer,
} from "@tiptap/react";
import { cn } from "@ui/lib";
import { type ReactNode, useId, useState } from "react";
import { useEditorEditable } from "./when-editor-editable";

/**
 * Above the default 50 that `MermaidBlock` and the code block leave their
 * general `<pre>` rules at, and above the code block's content fence guard
 * (60), so where these nodes are registered their rules are tried first.
 */
const FENCED_BLOCK_PARSE_PRIORITY = 70;

/** The diff marks a pending AI edit carries; see `marks` below. */
const DIFF_MARK_NAMES = new Set(["diffInsert", "diffDelete"]);

/** The class `fromMarkdown` gives the `<code>` of a fence in `language`. */
function fenceCodeClass(language: string): string {
	return `language-${language}`;
}

/**
 * Whether a `<pre>`'s `<code>` names `language`, in exactly that case. A
 * node claims only its own canonical language.
 */
function isFencePre(element: HTMLElement, language: string): boolean {
	const code = element.querySelector("code");
	return code?.classList.contains(fenceCodeClass(language)) ?? false;
}

/**
 * Whether a `<pre>`'s `<code>` names one of `languages`, in any case: the
 * code block's content fence guard keeps a ```` ```Cards ```` fence away
 * from the diagram sniff as surely as a ```` ```cards ```` one.
 */
export function isFencePreInAnyCase(
	element: HTMLElement,
	languages: readonly string[],
): boolean {
	const code = element.querySelector("code");
	if (!code) {
		return false;
	}
	const classes = new Set(
		languages.map((language) => fenceCodeClass(language).toLowerCase()),
	);
	return Array.from(code.classList).some((name) =>
		classes.has(name.toLowerCase()),
	);
}

/** Whether a pending AI edit marks any of the node's text. */
function hasPendingDiff(node: ProseMirrorNode): boolean {
	let pending = false;
	node.forEach((child) => {
		if (child.marks.some((mark) => DIFF_MARK_NAMES.has(mark.type.name))) {
			pending = true;
		}
	});
	return pending;
}

/** A parsed body: its drawing, or the reason it is shown as source. */
export type FencedBlockReading =
	| { ok: true; drawing: ReactNode }
	| { ok: false; reason: string };

type FencedBlockViewProps = ReactNodeViewProps & {
	/** The body read by its rule; see `FencedBlockReading`. */
	reading: FencedBlockReading;
	/** The toggle's visible text. */
	toggleLabel: string;
	/** The `data-*` attributes that name the block on its wrapper. */
	wrapperAttributes: Record<`data-${string}`, string>;
};

/**
 * Draws a valid block as its form and keeps its source one toggle away; an
 * invalid one as its source, with the rule beside it in an editable editor.
 *
 * The source is the node's own content DOM, edited in place like any code
 * block. It stays mounted while the form shows (ProseMirror needs it to map
 * positions), clipped and hidden from assistive tech so the block is not read
 * twice. It opens whenever the selection is inside the block, so a person who
 * arrows into it never types into text they cannot see, and while a pending
 * AI edit marks it, so the change under review stays visible.
 */
export function FencedBlockView({
	node,
	editor,
	getPos,
	selectionInside,
	reading,
	toggleLabel,
	wrapperAttributes,
}: FencedBlockViewProps) {
	const sourceId = useId();
	const [sourceToggled, setSourceToggled] = useState(false);
	const pendingDiff = hasPendingDiff(node);

	// Read again on every update: ProseMirror does not draw a node view
	// again for `setEditable`, so a block drawn while the editor took no
	// input kept no toggle once it took input again (Fizzy #2946).
	const editable = useEditorEditable(editor);
	const showForm = reading.ok && !pendingDiff;
	const sourceOpen =
		!showForm || (editable && (sourceToggled || selectionInside === true));

	const toggleSource = () => {
		if (sourceOpen && selectionInside) {
			// The source stays open while the selection is in it, so closing
			// it selects the block as a whole instead.
			const pos = getPos();
			if (typeof pos === "number") {
				editor.commands.setNodeSelection(pos);
			}
		}
		setSourceToggled(!sourceOpen);
	};

	return (
		<NodeViewWrapper
			className="relative my-4"
			{...wrapperAttributes}
			data-valid={reading.ok ? "true" : "false"}
		>
			{showForm && reading.drawing}
			{/* While an AI change is pending the body holds both its deleted and
			   its inserted text, so a reason read from it would be about neither. */}
			{editable && !reading.ok && !pendingDiff && (
				<output
					contentEditable={false}
					className="mb-1 block text-muted-foreground text-xs"
				>
					{reading.reason}
				</output>
			)}
			{editable && showForm && (
				<button
					type="button"
					contentEditable={false}
					aria-expanded={sourceOpen}
					aria-controls={sourceId}
					onClick={toggleSource}
					className="rounded-sm text-muted-foreground text-xs underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				>
					{toggleLabel}
				</button>
			)}
			<NodeViewContent<"pre">
				as="pre"
				id={sourceId}
				aria-hidden={sourceOpen ? undefined : true}
				// Clipped rather than removed, so ProseMirror can still map
				// positions into it.
				className={cn(!sourceOpen && "sr-only")}
			/>
		</NodeViewWrapper>
	);
}

/**
 * The node spec every content fence shares; only the name, the language and
 * the view differ.
 */
export function fencedBlockNode({
	name,
	language,
	view,
}: {
	name: string;
	/** The fence's canonical, lower-case language. */
	language: string;
	view: (props: ReactNodeViewProps) => ReactNode;
}) {
	const codeClass = fenceCodeClass(language);
	return Node.create({
		name,

		group: "block",

		content: "text*",

		// The two diff markers only, as the code block and `MermaidBlock`
		// admit: under `marks: ""` a `<del class="diff-del">` inside the
		// fence is dropped on parse while its text survives, so accepting an
		// AI edit of `3` to `7` would save `37`.
		marks: "diffInsert diffDelete",

		code: true,

		defining: true,

		parseHTML() {
			return [
				{
					tag: "pre",
					priority: FENCED_BLOCK_PARSE_PRIORITY,
					preserveWhitespace: "full",
					getAttrs: (node) =>
						isFencePre(node as HTMLElement, language) ? {} : false,
				},
			];
		},

		renderHTML() {
			return [
				"pre",
				{ "data-language": language },
				["code", { class: codeClass }, 0],
			];
		},

		addNodeView() {
			return ReactNodeViewRenderer(view, {
				contentDOMElementTag: "code",
			});
		},
	});
}
