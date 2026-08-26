import {
	Extension,
	Mark,
	markInputRule,
	markPasteRule,
	mergeAttributes,
} from "@tiptap/core";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Typography } from "@tiptap/extension-typography";
import { Underline } from "@tiptap/extension-underline";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { StarterKit } from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import { ImageLoadFallback } from "./image-load-fallback-extension";
import { MediaImportPlaceholder } from "./media-import-placeholder-extension";
import { buildMentionExtension } from "./mention-extension";
import { ExcalidrawEmbed } from "./tiptap-excalidraw-embed-extension";
import { DocumentImage } from "./tiptap-image-extension";
import { ImageUploadPlaceholder } from "./tiptap-image-upload-extension";
import { MERMAID_LANGUAGES, MermaidBlock } from "./tiptap-mermaid-extension";

// Create lowlight instance for syntax highlighting
const lowlight = createLowlight(common);

/**
 * Extended CodeBlockLowlight that excludes mermaid languages
 * This ensures MermaidBlock handles mermaid diagrams while CodeBlockLowlight handles regular code
 */
const CodeBlockLowlightNoMermaid = CodeBlockLowlight.extend({
	// Code blocks forbid marks by default, and the diff markers are marks — so a
	// `<del class="diff-del">` inside a fence was dropped on parse while its text
	// survived, leaving `stripDiffTags` no pair to match on accept and saving the
	// deleted value concatenated with its replacement (`30` edited to `90` saved
	// as `3090`). Whether a run corrupted anything depended on whether its edit
	// landed in a fence, which is what made it look intermittent.
	//
	// The rejected alternative was diffing a changed fence as one atomic block:
	// it also fixes this, but downgrades every fence in every editor from
	// word-level highlighting to whole-block replace. These two marks only —
	// this is not a general opening-up.
	marks: "diffInsert diffDelete",
	parseHTML() {
		return [
			{
				tag: "pre",
				preserveWhitespace: "full",
				getAttrs: (node) => {
					const element = node as HTMLElement;
					const codeElement = element.querySelector("code");
					const className = codeElement?.getAttribute("class") || "";
					const language = className
						.replace("language-", "")
						.toLowerCase();

					// Skip mermaid languages - let MermaidBlock handle them
					if (language && MERMAID_LANGUAGES.includes(language)) {
						return false;
					}

					// Also check content for mermaid diagram keywords
					const content =
						codeElement?.textContent || element.textContent || "";
					const firstLine =
						content.trim().split("\n")[0]?.toLowerCase() || "";
					const diagramKeywords = [
						"c4context",
						"c4container",
						"c4component",
						"c4deployment",
						"c4dynamic",
						"flowchart",
						"graph ",
						"sequencediagram",
						"classdiagram",
						"statediagram",
						"erdiagram",
						"gantt",
						"pie",
						"mindmap",
						"timeline",
						"gitgraph",
						"journey",
					];
					if (
						diagramKeywords.some((kw) => firstLine.startsWith(kw))
					) {
						return false;
					}

					return {};
				},
			},
		];
	},
});

/**
 * Diff marker marks.
 *
 * DiffInsert / DiffDelete are bound to `<ins class="diff-ins">` /
 * `<del class="diff-del">` — the exact markup `fromMarkdown` emits for AI
 * diff regions. The class check is essential: without it, pasted bare `<del>`
 * (from Google Docs, GitHub rendered markdown, etc.) would bind to DiffDelete
 * and then get deleted on save by the `diffDelDrop` turndown rule. With the
 * class check, bare `<del>` falls through to StarterKit's Strike and survives
 * as user strikethrough.
 *
 * Priority > 100 (StarterKit default) so the class-matched variants always
 * win over Strike, which also parses `<del>`.
 */
const DIFF_INS_CLASS = "diff-ins";
const DIFF_DEL_CLASS = "diff-del";

function hasClass(node: unknown, className: string): boolean {
	return node instanceof HTMLElement && node.classList.contains(className);
}

// `inclusive: false` makes the marks stop at their boundary — when the user
// places a cursor at the right edge of a marked span and types, the new
// characters do NOT inherit the mark via ProseMirror's schema-level rules.
// We then let `MarkUserTypedAsDiffInsert` apply `diffInsert` uniformly to
// every user insertion (including the ones inside an existing red span),
// which keeps the typing-paths symmetric and avoids the user's text ever
// silently inheriting the wrong mark.
const DiffInsert = Mark.create({
	name: "diffInsert",
	priority: 1000,
	inclusive: false,

	parseHTML() {
		return [
			{
				tag: "ins",
				getAttrs: (node) =>
					hasClass(node, DIFF_INS_CLASS) ? {} : false,
			},
		];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"ins",
			mergeAttributes(HTMLAttributes, { class: DIFF_INS_CLASS }),
			0,
		];
	},
});

const DiffDelete = Mark.create({
	name: "diffDelete",
	priority: 1000,
	inclusive: false,

	parseHTML() {
		return [
			{
				tag: "del",
				getAttrs: (node) =>
					hasClass(node, DIFF_DEL_CLASS) ? {} : false,
			},
		];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"del",
			mergeAttributes(HTMLAttributes, { class: DIFF_DEL_CLASS }),
			0,
		];
	},
});

/**
 * MarkUserTypedAsDiffInsert
 *
 * Marks user-typed text as `diffInsert` (green) so the user's in-place edits
 * appear as proposed additions next to the AI's diff. This makes the user's
 * own changes show up as real hunks for the per-hunk Accept / Reject controls
 * in DiffReviewBar — the same affordances they get for the AI's proposals —
 * and keeps the diff counter honest.
 *
 * Behaviors that fall out of this plugin:
 *  - Typing in plain text becomes a green hunk.
 *  - Typing adjacent to an existing green range coalesces with it into one
 *    hunk (ProseMirror merges adjacent text nodes carrying the same mark).
 *  - Typing inside a red `diffDelete` range produces `red ‖ green ‖ red`,
 *    because we strip the inherited red and apply green only over the
 *    inserted slice.
 *
 * The "non-wholesale replacement" guard preserves AI streaming:
 * `editor.commands.setContent(...)` rebuilds the entire doc as a single
 * `ReplaceStep` with `from === 0 && to === oldDocSize`. Without the guard we
 * would re-mark the AI's deletions as additions every time the diff renders.
 */
const MarkUserTypedAsDiffInsert = Extension.create({
	name: "markUserTypedAsDiffInsert",

	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: new PluginKey("markUserTypedAsDiffInsert"),
				appendTransaction(transactions, oldState, newState) {
					const diffInsertType = newState.schema.marks.diffInsert;
					const diffDeleteType = newState.schema.marks.diffDelete;
					if (!diffInsertType) {
						return null;
					}

					// Fast path: if no transaction in this batch changed the
					// document, nothing to mark.
					let anyDocChange = false;
					for (const transaction of transactions) {
						if (transaction.docChanged) {
							anyDocChange = true;
							break;
						}
					}
					if (!anyDocChange) {
						return null;
					}

					// Active-diff guard: only mark user-typed text as green
					// when the document is actually in diff-review mode
					// (i.e. carries at least one diffInsert or diffDelete
					// mark somewhere). Without this, every keystroke in a
					// normal document would produce a green hunk and pollute
					// the saved HTML with `<ins>` tags. `rangeHasMark`
					// short-circuits at the first occurrence, so the cost is
					// bounded by where the first diff mark sits in the doc;
					// for docs with no diff marks, the cost is one tree walk
					// per transaction with no per-step ProseMirror churn.
					const oldDocSize = oldState.doc.content.size;
					const inDiffMode =
						oldState.doc.rangeHasMark(
							0,
							oldDocSize,
							diffInsertType,
						) ||
						(diffDeleteType
							? oldState.doc.rangeHasMark(
									0,
									oldDocSize,
									diffDeleteType,
								)
							: false);
					if (!inDiffMode) {
						return null;
					}

					const tr = newState.tr;
					let modified = false;

					for (const transaction of transactions) {
						if (!transaction.docChanged) {
							continue;
						}

						for (const step of transaction.steps) {
							if (!(step instanceof ReplaceStep)) {
								continue;
							}
							if (step.slice.size === 0) {
								continue;
							}
							// Wholesale doc replacement (e.g. setContent that
							// renders the AI diff). Leave its marks in place.
							if (step.from === 0 && step.to === oldDocSize) {
								continue;
							}

							const insertedFrom = step.from;
							const insertedTo = step.from + step.slice.size;

							// Strip any inherited red first so user-typed text
							// inside a red span isn't both deleted and added.
							if (diffDeleteType) {
								tr.removeMark(
									insertedFrom,
									insertedTo,
									diffDeleteType,
								);
							}
							// Apply green only over the inserted slice. Adjacent
							// green coalesces; red on either side stays intact
							// and surfaces as separate hunks via findDiffRanges.
							tr.addMark(
								insertedFrom,
								insertedTo,
								diffInsertType.create(),
							);
							modified = true;
						}
					}

					return modified ? tr : null;
				},
			}),
		];
	},
});

/**
 * Inline `Code` mark — replaces StarterKit's default Code.
 *
 * Why we override it: TipTap's default Code mark sets `excludes: "_"` which
 * means it cannot coexist with ANY other mark on the same text node. During
 * parse of AI diffs like `<del class="diff-del">empty <code>foo</code></del>`,
 * the schema silently strips `diffDelete` from the code-marked text. The
 * Approve flow (DiffReviewBar.findDiffRanges) then can't see that text as part
 * of the deletion, and after Accept-All the code snippet survives orphaned.
 *
 * Setting `excludes: ""` lets `diffInsert` / `diffDelete` coexist with code,
 * so deletions that wrap inline code are detected and removed cleanly.
 *
 * Behavior change for end-user authoring: code can now technically coexist
 * with other inline marks (bold, italic, etc.). This is acceptable — the
 * toolbar doesn't expose those combinations in normal use, and the diff
 * round-trip correctness is the higher-priority guarantee here.
 */
const codeInputRegex = /(^|[^`])`([^`]+)`(?!`)$/;
const codePasteRegex = /(^|[^`])`([^`]+)`(?!`)/g;

const InlineCode = Mark.create({
	name: "code",
	excludes: "",
	code: true,
	exitable: true,

	addOptions() {
		return { HTMLAttributes: {} as Record<string, unknown> };
	},

	parseHTML() {
		return [{ tag: "code" }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"code",
			mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
			0,
		];
	},

	addCommands() {
		return {
			setCode:
				() =>
				({ commands }) =>
					commands.setMark(this.name),
			toggleCode:
				() =>
				({ commands }) =>
					commands.toggleMark(this.name),
			unsetCode:
				() =>
				({ commands }) =>
					commands.unsetMark(this.name),
		};
	},

	addKeyboardShortcuts() {
		return {
			"Mod-e": () => this.editor.commands.toggleMark(this.name),
		};
	},

	addInputRules() {
		return [markInputRule({ find: codeInputRegex, type: this.type })];
	},

	addPasteRules() {
		return [markPasteRule({ find: codePasteRegex, type: this.type })];
	},
});

/**
 * Build the shared rich document extension list with concrete
 * projectId + documentId values bound into the @-mention suggestion
 * query.
 *
 * Use `createSharedRichDocumentExtensions({ projectId, documentId })`
 * from any editor that knows the active project + document (e.g.
 * DocumentEditor passes its props). Pass `null` for either in read-only
 * contexts — the mention popover will then resolve to an empty list.
 */
export function createSharedRichDocumentExtensions({
	projectId,
	documentId,
}: {
	projectId: string | null;
	documentId: string | null;
}) {
	return buildSharedRichDocumentExtensions(projectId, documentId);
}

function buildSharedRichDocumentExtensions(
	projectId: string | null,
	documentId: string | null,
) {
	return [
		// Styles the pull ingester's "could not be imported" placeholders via a
		// decoration, so the token text is never rewritten (the push side
		// strips it by exact wording) and the styling survives re-render.
		MediaImportPlaceholder,

		// Stands a readable message in for an image whose src never resolves,
		// instead of the browser's native broken-image icon. Also a decoration,
		// so the message is never saved into the document body.
		ImageLoadFallback,

		// Mermaid diagram rendering
		// Supports: flowcharts, sequence diagrams, class diagrams, C4 diagrams, ER diagrams, etc.
		// NOTE: This is a Node extension and does NOT conflict with diff highlighting
		// which uses Mark extensions (<em>, <s>) - they are processed independently
		MermaidBlock,

		// Excalidraw diagram embed — interactive canvas inline in the document.
		// Recognizes `<excalidraw-embed data-resource-uri=… data-config-id=…>`
		// tags written by the AI Assistant after a `create_view` MCP call.
		// Fetches scenes fresh from the MCP server on every mount so edits
		// users make in the chat sidebar reflect here automatically.
		ExcalidrawEmbed,

		// Enhanced code blocks with syntax highlighting (excludes mermaid - handled by MermaidBlock)
		CodeBlockLowlightNoMermaid.configure({
			lowlight,
		}),

		// Placeholder text
		Placeholder.configure({
			placeholder: ({ node }) => {
				if (node.type.name === "heading") {
					return "Heading";
				}
				return "Type '/' for commands, or start writing...";
			},
			showOnlyWhenEditable: true,
		}),

		// Smart typography (auto-convert quotes, dashes, etc.)
		Typography,

		// Text styling foundations
		TextStyle,

		// Text color
		Color.configure({
			types: ["textStyle"],
		}),

		// Text highlighting
		Highlight.configure({
			multicolor: true,
		}),

		// Task lists
		TaskList.configure({
			HTMLAttributes: {
				class: "task-list",
			},
		}),
		TaskItem.configure({
			nested: true,
			HTMLAttributes: {
				class: "task-item",
			},
		}),

		// Links — extended to preserve `data-s3-key` (+ `download`) so file
		// attachments pulled from PM tools survive editing and have their signed
		// URL refreshed on reload (mirrors DocumentImage's data-s3-key tracking).
		Link.extend({
			addAttributes() {
				return {
					...this.parent?.(),
					"data-s3-key": {
						default: null,
						parseHTML: (element: HTMLElement) =>
							element.getAttribute("data-s3-key"),
						renderHTML: (attributes: Record<string, unknown>) =>
							attributes["data-s3-key"]
								? { "data-s3-key": attributes["data-s3-key"] }
								: {},
					},
					download: {
						default: null,
						parseHTML: (element: HTMLElement) =>
							element.hasAttribute("download") ? "" : null,
						renderHTML: (attributes: Record<string, unknown>) =>
							attributes.download !== null
								? { download: "" }
								: {},
					},
				};
			},
		}).configure({
			openOnClick: false,
			HTMLAttributes: {
				class: "tiptap-link",
			},
		}),

		// Images with S3 key tracking and alignment
		DocumentImage.configure({
			HTMLAttributes: {
				class: "tiptap-image",
			},
			inline: true,
			allowBase64: true,
		}),

		// Image upload placeholder (shows progress during upload)
		ImageUploadPlaceholder,

		// Tables — extended to catch RangeError from malformed table data.
		// prosemirror-tables throws "No cell with offset X found" when stored
		// document content has a corrupted table map. We patch plugin.props
		// directly because ProseMirror binds spec.props at construction time.
		Table.extend({
			// `data-diff` marks a table as an AI-proposed addition or deletion.
			// The `<div class="diff-table-…">` wrapper `fromMarkdown` emits is
			// not a schema node, so ProseMirror drops it on parse and the save
			// path can no longer tell a deleted table from a kept one — both
			// survive and the document ends up with the table twice. An
			// attribute on the table node itself round-trips, so `stripDiffTags`
			// can drop deleted tables and unmark added ones on accept.
			addAttributes() {
				return {
					...this.parent?.(),
					diff: {
						default: null,
						parseHTML: (element: HTMLElement) =>
							element.getAttribute("data-diff"),
						renderHTML: (attributes: Record<string, unknown>) =>
							attributes.diff
								? { "data-diff": attributes.diff as string }
								: {},
					},
				};
			},
			addProseMirrorPlugins() {
				const plugins = this.parent?.() ?? [];
				for (const plugin of plugins) {
					const props = plugin.props as Record<string, any>;

					if (props.decorations) {
						const orig = props.decorations;
						props.decorations = (state: any) => {
							try {
								return orig.call(plugin, state);
							} catch (e) {
								if (e instanceof RangeError) {
									return null;
								}
								throw e;
							}
						};
					}

					if (props.handleDOMEvents?.mousemove) {
						const origMm = props.handleDOMEvents.mousemove;
						props.handleDOMEvents.mousemove = (
							view: any,
							event: any,
						) => {
							try {
								return origMm.call(plugin, view, event);
							} catch (e) {
								if (e instanceof RangeError) {
									return false;
								}
								throw e;
							}
						};
					}
				}
				return plugins;
			},
		}).configure({
			resizable: true,
			HTMLAttributes: {
				class: "tiptap-table",
			},
		}),
		TableRow,
		TableCell,
		TableHeader,

		// Text formatting
		Underline,

		// Text alignment
		TextAlign.configure({
			types: ["heading", "paragraph"],
			alignments: ["left", "center", "right", "justify"],
		}),

		// Diff highlighting marks for AI streaming.
		// These render <ins> and <del> tags for additions/deletions.
		// `MarkUserTypedAsDiffInsert` marks user-typed text as a green addition
		// so the user's in-place edits become real hunks alongside the AI's,
		// available for per-hunk Accept / Reject in DiffReviewBar.
		DiffInsert,
		DiffDelete,
		MarkUserTypedAsDiffInsert,

		// @-mention node + suggestion popover (resolves to project
		// owner + accepted ProjectMembers — see
		// docs/superpowers/specs/2026-05-12-mention-scope-project-collaborators-design.md).
		buildMentionExtension({
			getProjectId: () => projectId,
			getDocumentId: () => documentId,
		}),

		// Image paste and drag-and-drop are handled via handlePaste/handleDrop
		// in DocumentEditor's editorProps, routing through the S3 upload pipeline.
	];
}

/**
 * Advanced TipTap extensions for Notion-like document editing
 * Includes rich formatting, AI features, and interactive elements.
 *
 * Pass `projectId` + `documentId` so the @-mention suggestion popover
 * can resolve project collaborators for that document; pass `null` for
 * either in read-only contexts where the popover is not needed.
 */
export function createAdvancedExtensions({
	projectId,
	documentId,
}: {
	projectId: string | null;
	documentId: string | null;
}) {
	return [
		StarterKit.configure({
			heading: {
				levels: [1, 2, 3, 4, 5, 6],
			},
			bulletList: {
				keepMarks: true,
				keepAttributes: false,
			},
			orderedList: {
				keepMarks: true,
				keepAttributes: false,
			},
			// Disable default code block to use CodeBlockLowlight instead
			codeBlock: false,
			// Disable default inline code mark — replaced by InlineCode below,
			// which sets `excludes: ""` so DiffInsert / DiffDelete can coexist
			// with code on the same text node (required for AI diff round-trips
			// where `<del class="diff-del">…<code>…</code>…</del>` must keep the
			// deletion mark on the code-wrapped text).
			code: false,
			// Disable link and underline — configured separately in buildSharedRichDocumentExtensions
			link: false,
			underline: false,
		}),
		InlineCode,
		...buildSharedRichDocumentExtensions(projectId, documentId),
	];
}

/**
 * Backward-compat shim: advancedExtensions with the mention popover
 * disabled (null projectId + documentId). Use
 * `createAdvancedExtensions({ projectId, documentId })` from editors
 * that need the popover to function.
 */
export const advancedExtensions = createAdvancedExtensions({
	projectId: null,
	documentId: null,
});
