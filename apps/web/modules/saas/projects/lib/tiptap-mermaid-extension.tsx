"use client";

import {
	isLiveFigureCounted,
	type LiveDiagramEngine,
	printsAsDrawn,
} from "@repo/utils/proposal-artifact/diagram-printability";
import {
	type ProposalThemePaint,
	withVisualRoleClassDefs,
} from "@repo/utils/proposal-artifact/theme-tokens";
import {
	cleanDiagramCaption,
	diagramSectionFingerprint,
	isFlowchartSource,
	readDiagramCaption,
	readVisualMarker,
	VISUAL_ORIGIN,
	visualSourceHash,
	withDiagramCaption,
} from "@repo/utils/proposal-artifact/visual-identity";
import { mergeAttributes, Node } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import {
	NodeViewContent,
	NodeViewWrapper,
	ReactNodeViewRenderer,
} from "@tiptap/react";
import { DestructiveTooltip } from "@ui/components/destructive-tooltip";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import DOMPurify from "dompurify";
import {
	AlertCircle,
	Check,
	Code,
	EllipsisVertical,
	Eye,
	Loader2,
	RefreshCw,
	Sparkles,
	TextCursorInput,
	Trash2,
	WandSparkles,
} from "lucide-react";
import mermaid from "mermaid";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	cleanDiagramStylesheet,
	isInertDiagramAttribute,
} from "./diagram-svg-url-guard";
import { getEditorMarkdownForSave } from "./editor-markdown-save";
import {
	diagramEditVisualId,
	diagramsOf,
	MERMAID_NODE_NAME,
	useDiagramOrigin,
} from "./mermaid-diagram-index";
import { MermaidEditVisualPanel } from "./mermaid-edit-visual-panel";
import { MermaidFailureView } from "./mermaid-failure-view";
import { withMermaidLock } from "./mermaid-lock";
import {
	drawFigureTemplate,
	FIGURE_MIN_LIVE_WIDTH,
	figureIdPrefix,
	livePrintability,
} from "./mermaid-proposal-figure";
import { useMermaidVisualContext } from "./mermaid-visual-context";
import { useMermaidDiagramSizing } from "./use-mermaid-diagram-sizing";

/**
 * Sanitize rendered diagram markup before it is injected as HTML.
 *
 * Diagram source is user-authored and rendered for every other member of the
 * project, so it is stored cross-user content. The markup reaches the DOM
 * through `dangerouslySetInnerHTML`, and until this existed nothing sanitized
 * it: the suppression comment at that call site asserted the SVG "is
 * sanitized", which was never true. Mermaid's own guard was off — see
 * `securityLevel` below — and the primary renderer is a different library
 * altogether, so a guard tied to either one would cover only half the paths.
 *
 * Applying it at the single assignment point instead covers both renderers by
 * construction: DOMPurify drops `on*` handlers, script content, and
 * `javascript:` targets, while the SVG profile keeps geometry, `<style>`, and
 * `<text>`.
 *
 * The profile deliberately does NOT admit `foreignObject`, and that is coupled
 * to `htmlLabels: false` below. `foreignObject` is the bridge from SVG back
 * into HTML, so admitting it would reopen most of what this closes — and
 * DOMPurify strips its HTML children on the way through anyway, which fails
 * silently: the diagram still draws, every node just loses its text. Neither
 * renderer needs it. The primary one emits `<text>`; the fallback is configured
 * to do the same. If a future renderer starts emitting `foreignObject`, labels
 * will disappear rather than render unsafely, and the test named for it says so.
 *
 * The profile removes what runs, not what loads, so a dedicated DOMPurify
 * instance adds two hooks (`diagram-svg-url-guard.ts`): an attribute whose
 * value loads anything (a `url()` other than a same-document `#id`) is
 * dropped, and every `<style>` loses its at-rules and loading declarations.
 * The instance is the sanitizer's own, so no other DOMPurify caller sees them.
 */
export function sanitizeDiagramSvg(dirty: string): string {
	return diagramPurifier().sanitize(dirty, {
		USE_PROFILES: { svg: true, svgFilters: true },
		// The SVG profile drops `role`, an HTML attribute; a figure template
		// names itself an image with it, and it carries no behaviour.
		ADD_ATTR: ["role"],
	});
}

let purifier: typeof DOMPurify | null = null;

/** The diagram sanitizer's own DOMPurify, made on first use in the browser. */
function diagramPurifier(): typeof DOMPurify {
	if (purifier === null) {
		const instance = DOMPurify();
		instance.addHook("uponSanitizeElement", (node, data) => {
			if (data.tagName === "style") {
				node.textContent = cleanDiagramStylesheet(
					node.textContent ?? "",
				);
			}
		});
		instance.addHook("uponSanitizeAttribute", (node, data) => {
			if (
				!isInertDiagramAttribute(
					node.nodeName,
					data.attrName,
					data.attrValue,
				)
			) {
				data.keepAttr = false;
			}
		});
		purifier = instance;
	}
	return purifier;
}

// Initialize mermaid as fallback only — beautiful-mermaid is the primary renderer
mermaid.initialize({
	startOnLoad: false,
	theme: "default",
	securityLevel: "loose",
	fontFamily: "ui-sans-serif, system-ui, sans-serif",
	flowchart: {
		useMaxWidth: true,
		// SVG text labels, not HTML-in-foreignObject: the sanitizer above admits
		// no bridge back into HTML, so a foreignObject label would be drawn empty.
		htmlLabels: false,
		curve: "basis",
	},
	sequence: {
		useMaxWidth: true,
		diagramMarginX: 50,
		diagramMarginY: 10,
		actorMargin: 50,
		boxMargin: 10,
	},
	c4: {
		useMaxWidth: true,
		diagramMarginX: 50,
		diagramMarginY: 10,
	},
});

/**
 * Render diagram source with native mermaid.js, the fallback for diagram
 * types beautiful-mermaid does not support.
 *
 * mermaid.js keeps one global configuration that the regular and Glossy
 * exports also set, and `mermaid.render` yields mid-render. So this runs
 * under the shared `withMermaidLock` and restores the configuration it
 * replaced: an export rendering at the same moment never draws under this
 * preview's `securityLevel: "loose"`, nor this preview under its settings.
 */
export async function renderNativeMermaidSvg(
	code: string,
	isDark: boolean,
): Promise<string> {
	return withMermaidLock(async () => {
		const previous = mermaid.mermaidAPI.getSiteConfig();
		try {
			mermaid.initialize({
				startOnLoad: false,
				theme: isDark ? "dark" : "default",
				securityLevel: "loose",
				fontFamily: "ui-sans-serif, system-ui, sans-serif",
				themeVariables: isDark
					? {
							primaryColor: "#3b3b5c",
							primaryTextColor: "#e4e4e7",
							primaryBorderColor: "#52525b",
							lineColor: "#71717a",
							secondaryColor: "#27273f",
							tertiaryColor: "#1c1c2e",
							background: "transparent",
							mainBkg: "#27272a",
							nodeBorder: "#52525b",
							clusterBkg: "#1c1c2e",
							titleColor: "#fafafa",
							edgeLabelBackground: "#27272a",
							textColor: "#e4e4e7",
						}
					: {
							primaryColor: "#f4f4f5",
							primaryTextColor: "#18181b",
							primaryBorderColor: "#d4d4d8",
							lineColor: "#a1a1aa",
							secondaryColor: "#fafafa",
							tertiaryColor: "#f4f4f5",
							background: "transparent",
							mainBkg: "#fafafa",
							nodeBorder: "#d4d4d8",
							clusterBkg: "#f4f4f5",
							titleColor: "#18181b",
							edgeLabelBackground: "#ffffff",
							textColor: "#18181b",
						},
				flowchart: {
					useMaxWidth: true,
					// See `sanitizeDiagramSvg` — foreignObject labels do not survive it.
					htmlLabels: false,
					curve: "basis",
				},
				sequence: { useMaxWidth: true },
				c4: { useMaxWidth: true },
			});

			const id = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
			const { svg } = await mermaid.render(id, code.trim());
			return svg;
		} finally {
			mermaid.initialize(previous);
		}
	});
}

/** The colour slots beautiful-mermaid reads, bridged to the page's tokens. */
const BEAUTIFUL_MERMAID_COLORS = {
	bg: "var(--mermaid-bg)",
	fg: "var(--mermaid-fg)",
	line: "var(--mermaid-line)",
	accent: "var(--mermaid-accent)",
	muted: "var(--mermaid-muted)",
	surface: "var(--mermaid-surface)",
	border: "var(--mermaid-border)",
	font: "ui-sans-serif, system-ui, -apple-system, sans-serif",
	transparent: true,
} as const;

interface DiagramRenderOptions {
	isDark: boolean;
	paint?: ProposalThemePaint | null;
	/** Prefix of a figure template's ids, unique to the diagram. */
	figureIdPrefix?: string;
}

/**
 * Draw diagram source as sanitized SVG, saying which engine drew it:
 * beautiful-mermaid first, mermaid.js for the types it does not support.
 *
 * With a theme `paint` (a client-document Proposal's page, Fizzy #2946) a
 * fence with a `%% figure:` line draws its SVG template instead, and a
 * flowchart gets the theme's role class definitions appended first, so a
 * generated diagram's `class <id> surface` lines take the brand's colours
 * and follow a Style change without its text changing. Without one the
 * source is drawn as written, without its caption line.
 */
async function drawDiagram(
	code: string,
	{
		isDark,
		paint,
		figureIdPrefix: idPrefix = "figure",
	}: DiagramRenderOptions,
): Promise<{ svg: string; engine: LiveDiagramEngine }> {
	// A template the parser refuses draws as Mermaid, below.
	const template = paint ? drawFigureTemplate(code, paint, idPrefix) : null;
	if (template !== null) {
		return { svg: sanitizeDiagramSvg(template), engine: "template" };
	}
	// The caption is printed under the diagram, never drawn in it.
	const drawn = withDiagramCaption(code, null);
	const source = paint ? withVisualRoleClassDefs(drawn, paint) : drawn;
	let svg = "";
	let engine: LiveDiagramEngine = "beautiful-mermaid";
	try {
		const beautifulMermaid = await import("beautiful-mermaid");
		// Use CSS variables so the SVG adapts to light/dark theme automatically.
		// The SVG references CSS custom properties defined on .mermaid-diagram-area,
		// which inherit from the app's design tokens. No re-render needed on theme switch.
		svg = beautifulMermaid.renderMermaidSVG(
			source.trim(),
			BEAUTIFUL_MERMAID_COLORS,
		);
	} catch {
		// Fallback to native mermaid.js for unsupported diagram types
		// (gantt, pie, mindmap, C4, timeline, etc.)
		svg = await renderNativeMermaidSvg(source, isDark);
		engine = "mermaid";
	}
	return { svg: sanitizeDiagramSvg(svg), engine };
}

/** A `style`, `classDef` or `linkStyle` line with a literal hex colour. */
const BAKED_COLOUR_LINE =
	/^\s*(?:style|classDef|linkStyle)\b.*#[0-9a-f]{3,8}\b/im;

/**
 * A diagram whose colours are written into its source and that is not a
 * generated visual: the theme cannot repaint it, and Edit with instructions
 * is its restyle path.
 */
function hasFixedColours(code: string): boolean {
	return (
		readVisualMarker(code).visualId === null && BAKED_COLOUR_LINE.test(code)
	);
}

/**
 * Maps a DIAGRAM_TEMPLATES id to the specific Mermaid syntax keyword
 * and a human-readable label used in AI system prompts. `null` means the
 * user did not pick a specific type (blank/generic mermaid block) and the
 * model is free to choose the most appropriate diagram type.
 */
const DIAGRAM_TYPE_TO_MERMAID: Record<
	string,
	{ keyword: string; label: string } | undefined
> = {
	flowchart: { keyword: "flowchart", label: "flowchart" },
	"sequence-diagram": {
		keyword: "sequenceDiagram",
		label: "sequence diagram",
	},
	"class-diagram": { keyword: "classDiagram", label: "class diagram" },
	"er-diagram": {
		keyword: "erDiagram",
		label: "entity-relationship diagram",
	},
	mindmap: { keyword: "mindmap", label: "mindmap" },
};

/**
 * Rough token estimate used to decide whether to send the full document
 * as context or just the current section. ~4 chars per token is a safe
 * under-estimate for English prose.
 */
const CHARS_PER_TOKEN = 4;
/** Auto-include full doc when it fits under this token budget. */
const FULL_DOC_AUTO_TOKEN_BUDGET = 4000;
/** Hard cap for section context so we never blow past the model context. */
const SECTION_MAX_CHARS = 8000;

export interface MermaidDocContext {
	/** First h1 (or first heading) text found in the document. */
	title: string | null;
	/** Compact outline of all headings — acts as a map of the doc. */
	outline: Array<{ level: number; text: string }>;
	/** Plain text from the nearest preceding heading up to the block position. */
	section: string;
	/** Plain text of the entire document. */
	fullText: string;
	/** Rough token estimate of the full document. */
	estimatedTokens: number;
}

/**
 * Extract surrounding-document context from the editor for AI generation.
 *
 * Walks `editor.state.doc` once and returns title, outline, nearest-section
 * text, and full-doc text. Pure (no React state) so it can be memoised by
 * the caller when the document or cursor position changes.
 *
 * Fails gracefully: on any error returns an empty context and the caller
 * falls back to today's context-free generation path.
 */
export function extractDocContext(
	editor: { state: any } | null,
	blockPos: number | undefined,
): MermaidDocContext {
	const empty: MermaidDocContext = {
		title: null,
		outline: [],
		section: "",
		fullText: "",
		estimatedTokens: 0,
	};

	if (!editor?.state?.doc) {
		return empty;
	}

	try {
		const doc = editor.state.doc;
		const outline: Array<{ level: number; text: string }> = [];
		let title: string | null = null;
		let nearestHeadingPos = 0;

		doc.descendants((node: any, pos: number) => {
			if (node.type?.name === "heading") {
				const text = (node.textContent || "").trim();
				const level = Number(node.attrs?.level) || 1;
				if (text) {
					outline.push({ level, text });
					if (!title && level <= 2) {
						title = text;
					}
					if (
						blockPos !== undefined &&
						pos < blockPos &&
						pos >= nearestHeadingPos
					) {
						nearestHeadingPos = pos;
					}
				}
			}
			return true;
		});

		const fullText = (
			doc.textBetween(0, doc.content.size, "\n\n", " ") || ""
		).trim();

		let section = "";
		if (blockPos !== undefined) {
			const start = nearestHeadingPos;
			const end = Math.min(blockPos, doc.content.size);
			if (end > start) {
				section = doc.textBetween(start, end, "\n\n", " ").trim();
			}
		}

		if (section.length > SECTION_MAX_CHARS) {
			// Keep the tail (closest to cursor) — most relevant for the diagram
			section = `…${section.slice(-SECTION_MAX_CHARS)}`;
		}

		const estimatedTokens = Math.ceil(fullText.length / CHARS_PER_TOKEN);

		return {
			title,
			outline,
			section,
			fullText,
			estimatedTokens,
		};
	} catch {
		return empty;
	}
}

/**
 * Build the "context block" prepended to the user prompt for AI generation.
 * Always includes the outline (cheap). Includes full-text when the doc fits
 * under the auto budget OR the user explicitly opted in, otherwise falls
 * back to the current section only.
 */
export type ContextMode = "section" | "auto" | "full";

export function buildContextBlock(
	ctx: MermaidDocContext,
	mode: ContextMode,
): string {
	if (!ctx.fullText && !ctx.section && ctx.outline.length === 0) {
		return "";
	}

	const parts: string[] = [];
	if (ctx.title) {
		parts.push(`Document title: ${ctx.title}`);
	}
	if (ctx.outline.length > 0) {
		const outlineText = ctx.outline
			.slice(0, 40)
			.map((h) => `${"  ".repeat(Math.max(0, h.level - 1))}- ${h.text}`)
			.join("\n");
		parts.push(`Document outline:\n${outlineText}`);
	}

	const shouldUseFull =
		mode === "full" ||
		(mode === "auto" && ctx.estimatedTokens < FULL_DOC_AUTO_TOKEN_BUDGET);

	if (shouldUseFull && ctx.fullText) {
		parts.push(`Full document content:\n${ctx.fullText}`);
	} else if (ctx.section) {
		parts.push(
			`Current section (text immediately before the diagram):\n${ctx.section}`,
		);
	}

	return parts.join("\n\n");
}

/**
 * All mermaid diagram languages that should be rendered as diagrams.
 * Exported for use in CodeBlockLowlight exclusion.
 */
export const MERMAID_LANGUAGES = [
	"mermaid",
	// C4 diagrams
	"c4context",
	"c4container",
	"c4component",
	"c4deployment",
	"c4dynamic",
	// Other diagram types
	"flowchart",
	"sequencediagram",
	"sequence",
	"classdiagram",
	"statediagram",
	"erdiagram",
	"gantt",
	"pie",
	"mindmap",
	"timeline",
];

/**
 * A diagram node's caption: its body's `%% caption:` line, else the caption
 * attribute an older document set, else empty.
 */
function captionOf(node: {
	attrs: Record<string, unknown>;
	textContent: string;
}): string {
	const legacy = node.attrs.caption;
	return (
		readDiagramCaption(node.textContent) ??
		cleanDiagramCaption(typeof legacy === "string" ? legacy : null) ??
		""
	);
}

/** The diff marks a pending AI edit carries; the node admits only these. */
const DIFF_MARK_NAMES = new Set(["diffInsert", "diffDelete"]);

interface MermaidNodeViewProps {
	node: {
		attrs: Record<string, unknown>;
		textContent: string;
		nodeSize: number;
		forEach: (
			f: (child: {
				text?: string | null;
				marks: readonly { type: { name: string } }[];
			}) => void,
		) => void;
	};
	updateAttributes: (attrs: Record<string, unknown>) => void;
	editor: {
		isEditable: boolean;
		getHTML: () => string;
		chain: () => any;
		state: any;
		view: any;
		on: (event: "update", listener: () => void) => unknown;
		off: (event: "update", listener: () => void) => unknown;
	};
	getPos: () => number | undefined;
}

/** A diagram menu item with a description below its label. */
function DescribedMenuItem({
	id,
	icon: Icon,
	label,
	description,
	onSelect,
}: {
	id: string;
	icon: typeof Sparkles;
	label: string;
	description: string;
	onSelect: () => void;
}) {
	return (
		<DropdownMenuItem
			className="flex-col items-start gap-0.5"
			aria-labelledby={id}
			aria-describedby={`${id}-description`}
			onSelect={onSelect}
		>
			<span id={id} className="flex items-center gap-2">
				<Icon className="h-4 w-4" aria-hidden="true" />
				{label}
			</span>
			<span
				id={`${id}-description`}
				className="text-xs text-muted-foreground"
			>
				{description}
			</span>
		</DropdownMenuItem>
	);
}

/** What a diagram menu item does once the menu has closed. */
type MenuAction = "instruction" | "ai" | "source" | "caption" | "delete";

/** Where focus goes after a menu item or a panel closes. */
type FocusTarget = "instruction" | "ai" | "caption" | "code" | "trigger";

/**
 * The node's text lives in ProseMirror's content element, which TipTap
 * appends visibly to the node when the view renders no `NodeViewContent`.
 * The view shows the source in its own editor, so the content element stays
 * in the document but out of sight.
 */
function HiddenSource() {
	return <NodeViewContent className="hidden" aria-hidden="true" />;
}

/**
 * The source a diagram under review would have once its pending AI edit is
 * accepted: its text without the ranges marked deleted. Each changed line
 * carries its own line break inside the mark, so dropping a range drops its
 * line. `null` when nothing in the text is marked: no review is pending.
 */
function proposedSourceOf(node: MermaidNodeViewProps["node"]): string | null {
	let marked = false;
	let proposed = "";
	node.forEach((child) => {
		const names = child.marks.map((mark) => mark.type.name);
		if (names.some((name) => DIFF_MARK_NAMES.has(name))) {
			marked = true;
		}
		if (!names.includes("diffDelete")) {
			proposed += child.text ?? "";
		}
	});
	return marked ? proposed : null;
}

function MermaidNodeView({ node, editor, getPos }: MermaidNodeViewProps) {
	const tTooltips = useTranslations("tooltips.common");
	const tEditorTooltips = useTranslations("tooltips.editor");
	const [svg, setSvg] = useState<string>("");
	const [error, setError] = useState<string | null>(null);
	// The source view, and where it was opened from: from the failure view,
	// a save returns to it while the source still does not draw.
	const [sourceOrigin, setSourceOrigin] = useState<"menu" | "failure" | null>(
		null,
	);
	const showCode = sourceOrigin !== null;
	const [isRendering, setIsRendering] = useState(false);
	const [mounted, setMounted] = useState(false);
	const [editableCode, setEditableCode] = useState<string | null>(null);
	const [showCaptionInput, setShowCaptionInput] = useState(false);
	// The caption lives in the body's `%% caption:` line; a caption attribute
	// from an older document is shown until a new caption replaces it, and
	// the save writes it into the body.
	const storedCaption = captionOf(node);
	const [captionDraft, setCaptionDraft] = useState("");
	// Cleared by Enter and Escape, so the blur that follows does not commit.
	const captionOpenRef = useRef(false);
	const captionValue = showCaptionInput ? captionDraft : storedCaption;
	const captionInputRef = useRef<HTMLInputElement>(null);
	const aiPromptInputRef = useRef<HTMLTextAreaElement>(null);
	const [showAIPrompt, setShowAIPrompt] = useState(false);
	const [aiPrompt, setAiPrompt] = useState("");
	const [isGenerating, setIsGenerating] = useState(false);
	const [aiError, setAiError] = useState<string | null>(null);
	const [isSuggesting, setIsSuggesting] = useState(false);
	const [suggestionApplied, setSuggestionApplied] = useState(false);
	const [useFullDoc, setUseFullDoc] = useState(false);
	const suggestionAttemptedRef = useRef(false);

	// A client-document Proposal's page (Fizzy #2946): the diagram's actions
	// sit in one menu, with Edit with instructions and the diagram's origin.
	// Without the context every diagram keeps its header bar.
	const visual = useMermaidVisualContext();
	const paint = visual?.paint ?? null;
	const tMenu = useTranslations("tooltips.editor.diagramMenu");
	const tVisuals = useTranslations("projects.proposalArtifact.visuals");
	const [showInstructionPanel, setShowInstructionPanel] = useState(false);
	const instructionInputRef = useRef<HTMLTextAreaElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const codeTextareaRef = useRef<HTMLTextAreaElement>(null);
	const menuActionRef = useRef<MenuAction | null>(null);
	const [focusRequest, setFocusRequest] = useState<FocusTarget | null>(null);
	const menuIds = useId();
	// Which engine drew the diagram; a figure template's ids are unique to
	// this block.
	const [engine, setEngine] = useState<LiveDiagramEngine | null>(null);
	const figureIds = figureIdPrefix(menuIds);

	// While an AI edit of the diagram is under review its text holds the
	// removed and the added lines together, marked. Drawn as one diagram they
	// make a picture that is neither version, so the view shows the marked
	// source and draws the proposed diagram beside it.
	const tReview = useTranslations("tooltips.editor.diagramReview");
	const proposedSource = proposedSourceOf(node);
	const underReview = proposedSource !== null;
	const [reviewSvg, setReviewSvg] = useState("");

	/**
	 * Context from the surrounding document used to ground AI generation
	 * and produce in-place prompt suggestions. Recomputed whenever the
	 * doc content or block position changes.
	 */
	const docContext = useMemo(
		() => extractDocContext(editor, getPos()),
		// editor.state.doc is the source of truth for textual content;
		// re-extract whenever a transaction updates the doc.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[editor, editor?.state?.doc, getPos],
	);
	const { resolvedTheme } = useTheme();

	/** Delete this diagram node from the document. */
	const deleteNode = useCallback(() => {
		const pos = getPos();
		if (pos === undefined) {
			return;
		}
		const { state, view } = editor;
		const tr = state.tr.delete(pos, pos + node.nodeSize);
		view.dispatch(tr);
	}, [editor, getPos, node.nodeSize]);

	/**
	 * Save edited code back into the TipTap node content.
	 * Replaces the entire node with a new mermaidBlock containing the updated text.
	 */
	const saveCode = useCallback(
		(newCode: string) => {
			const pos = getPos();
			if (pos === undefined) {
				return;
			}

			const { state, view } = editor;
			const nodeSize = node.nodeSize;
			const tr = state.tr;

			// Create a new mermaidBlock node with the updated text content
			const nodeType = state.schema.nodes.mermaidBlock;
			if (!nodeType) {
				return;
			}

			const textNode = newCode ? state.schema.text(newCode) : undefined;
			const newNode = nodeType.create(
				node.attrs,
				textNode ? [textNode] : [],
			);

			tr.replaceWith(pos, pos + nodeSize, newNode);
			view.dispatch(tr);
			setEditableCode(null);
		},
		[editor, getPos, node.attrs, node.nodeSize],
	);

	/** Generate diagram code from a natural-language description using AI. */
	const generateWithAI = useCallback(
		async (description: string) => {
			if (!description.trim()) {
				return;
			}

			setIsGenerating(true);
			setAiError(null);

			try {
				const diagramType = node.attrs.diagramType as string | null;
				const typeInfo = diagramType
					? DIAGRAM_TYPE_TO_MERMAID[diagramType]
					: undefined;

				const existingCode = node.textContent.trim();
				// Treat the default blank-mermaid placeholder as "no existing content"
				// so the first prompt generates from scratch rather than trying to
				// "update" a comment. Templates (flowchart/sequence/etc.) ARE treated
				// as existing content so follow-up prompts extend them.
				const isBlankPlaceholder =
					existingCode ===
					"graph TD\n    %% Start typing your diagram here";
				const hasExisting =
					Boolean(existingCode) && !isBlankPlaceholder;

				const typeConstraint = typeInfo
					? `The user has selected a ${typeInfo.label}. You MUST generate valid Mermaid \`${typeInfo.keyword}\` syntax. Do NOT switch to a different diagram type under any circumstances.`
					: "Choose the most appropriate diagram type (flowchart, sequenceDiagram, classDiagram, erDiagram, mindmap, stateDiagram, gantt, pie, etc.) based on what the user is describing.";

				const contextBlock = buildContextBlock(
					docContext,
					useFullDoc ? "full" : "auto",
				);
				const contextPreamble = contextBlock
					? `You are working inside a document. Use the context below to ground the diagram in the document's actual names, roles, and rules — do not invent generic placeholders when the document provides specifics.\n\n--- DOCUMENT CONTEXT ---\n${contextBlock}\n--- END DOCUMENT CONTEXT ---\n\n`
					: "";

				const userPrompt = hasExisting
					? `${contextPreamble}Here is an existing Mermaid diagram:\n\`\`\`mermaid\n${existingCode}\n\`\`\`\n\nUpdate it based on this request: ${description}`
					: typeInfo
						? `${contextPreamble}Create a Mermaid ${typeInfo.label} for: ${description}`
						: `${contextPreamble}Create a Mermaid diagram for: ${description}`;

				const response = await fetch("/api/ai/generate", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						prompt: userPrompt,
						systemPrompt: `You are an expert at creating Mermaid diagrams. Generate ONLY valid Mermaid syntax — no markdown fences, no explanation, no surrounding text. Output raw Mermaid code only.

${typeConstraint}

When document context is provided, prefer concrete names, roles, and steps from that context over generic ones. Keep diagrams clear and well-structured with descriptive node labels.`,
					}),
				});

				if (!response.ok) {
					const data = await response.json().catch(() => null);
					throw new Error(
						data?.error || `Request failed (${response.status})`,
					);
				}

				const data = await response.json();
				let generated = (data.text || "").trim();

				// Strip markdown fences if the model included them
				if (generated.startsWith("```")) {
					generated = generated
						.replace(/^```(?:mermaid)?\s*\n?/, "")
						.replace(/\n?```\s*$/, "");
				}

				if (generated) {
					saveCode(withDiagramCaption(generated, captionOf(node)));
					setShowAIPrompt(false);
					setAiPrompt("");
				}
			} catch (err) {
				setAiError(
					err instanceof Error
						? err.message
						: "Failed to generate diagram",
				);
			} finally {
				setIsGenerating(false);
			}
		},
		[node, saveCode, docContext, useFullDoc],
	);

	/**
	 * Ask the model for a short one-line diagram description based on the
	 * surrounding document context. Prefills the prompt textarea so the user
	 * has a relevant starting point instead of a blank box.
	 */
	const suggestPrompt = useCallback(async () => {
		// No surrounding text → nothing to suggest from; leave the box blank.
		if (!docContext.section && !docContext.fullText) {
			return;
		}

		setIsSuggesting(true);
		try {
			const diagramType = node.attrs.diagramType as string | null;
			const typeInfo = diagramType
				? DIAGRAM_TYPE_TO_MERMAID[diagramType]
				: undefined;
			const typeHint = typeInfo
				? `The user has already selected a ${typeInfo.label}, so suggest something that fits that diagram type.`
				: "";

			const contextBlock = buildContextBlock(docContext, "section");

			const response = await fetch("/api/ai/generate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prompt: `--- DOCUMENT CONTEXT ---\n${contextBlock}\n--- END DOCUMENT CONTEXT ---\n\nBased on the section immediately before the diagram, suggest the single most useful diagram the author would want to insert here. Respond with a short description only.`,
					systemPrompt: `You suggest diagram descriptions for a technical writer. Given a section of a document, return a single short description (under 15 words) of the most useful diagram to insert at the end of that section. ${typeHint}

Rules:
- Return ONLY the description, nothing else.
- No quotes, no markdown, no "Here is…" preamble.
- Use the concrete names and concepts from the document, not generic ones.
- If the section does not suggest a clear diagram, return an empty string.`,
				}),
			});

			if (!response.ok) {
				return;
			}
			const data = await response.json();
			const suggestion = String(data.text || "")
				.trim()
				.replace(/^["'`]|["'`]$/g, "");
			if (suggestion && !aiPrompt.trim()) {
				setAiPrompt(suggestion);
				setSuggestionApplied(true);
			}
		} catch {
			// Silent — suggestion is best-effort, user can type their own prompt.
		} finally {
			setIsSuggesting(false);
		}
	}, [docContext, node.attrs.diagramType, aiPrompt]);

	/**
	 * When the AI panel opens on an empty block with no existing prompt,
	 * fire a one-shot suggestion using the surrounding document context.
	 * Guarded by suggestionAttemptedRef so we only try once per mount.
	 */
	useEffect(() => {
		if (!showAIPrompt) {
			suggestionAttemptedRef.current = false;
			return;
		}
		if (suggestionAttemptedRef.current) {
			return;
		}
		const hasExistingCode =
			node.textContent.trim() !== "" &&
			node.textContent.trim() !==
				"graph TD\n    %% Start typing your diagram here";
		if (hasExistingCode || aiPrompt.trim()) {
			return;
		}
		suggestionAttemptedRef.current = true;
		suggestPrompt();
	}, [showAIPrompt, aiPrompt, node.textContent, suggestPrompt]);

	const renderDiagram = useCallback(async () => {
		// Under review the text mixes both versions; the review view draws
		// the proposed one, and this runs again once the review is resolved.
		if (underReview) {
			return;
		}
		const code = node.textContent;
		if (!code.trim()) {
			setSvg("");
			setError(null);
			return;
		}

		setIsRendering(true);
		setError(null);

		try {
			const drawn = await drawDiagram(code, {
				isDark: resolvedTheme === "dark",
				paint,
				figureIdPrefix: figureIds,
			});
			setSvg(drawn.svg);
			setEngine(drawn.engine);
			setError(null);
		} catch (err) {
			console.error("Mermaid render error:", err);
			setError(
				err instanceof Error ? err.message : "Failed to render diagram",
			);
			setSvg("");
			setEngine(null);
		} finally {
			setIsRendering(false);
		}
	}, [node.textContent, resolvedTheme, paint, underReview, figureIds]);

	useEffect(() => {
		setMounted(true);
	}, []);

	useEffect(() => {
		if (!mounted) {
			return;
		}
		renderDiagram();
	}, [mounted, renderDiagram]);

	// The proposed diagram under review. One that does not draw leaves the
	// marked source on its own, without an error: the review is of the
	// change, and the source shows it either way.
	useEffect(() => {
		if (!mounted || !proposedSource?.trim()) {
			setReviewSvg("");
			return;
		}
		let current = true;
		drawDiagram(proposedSource, {
			isDark: resolvedTheme === "dark",
			paint,
			figureIdPrefix: `${figureIds}-review`,
		}).then(
			(drawn) => {
				if (current) {
					setReviewSvg(drawn.svg);
				}
			},
			() => {
				if (current) {
					setReviewSvg("");
				}
			},
		);
		return () => {
			current = false;
		};
	}, [mounted, proposedSource, resolvedTheme, paint, figureIds]);

	const code = node.textContent;

	const hasDocContext = Boolean(
		docContext.fullText || docContext.section || docContext.outline.length,
	);
	const showFullDocToggle =
		hasDocContext &&
		docContext.estimatedTokens >= FULL_DOC_AUTO_TOKEN_BUDGET;

	// The menu's focus moves: after an item, focus goes to what it opened;
	// a request waits until that element has mounted.
	useLayoutEffect(() => {
		if (!focusRequest) {
			return;
		}
		const target = {
			instruction: instructionInputRef,
			ai: aiPromptInputRef,
			caption: captionInputRef,
			code: codeTextareaRef,
			trigger: triggerRef,
		}[focusRequest].current;
		if (target) {
			target.focus();
			setFocusRequest(null);
		}
	});

	/** Delete the node and put the caret where it was. */
	const deleteNodeKeepingCaret = useCallback(() => {
		const pos = getPos();
		if (pos === undefined) {
			return;
		}
		const { state, view } = editor;
		const current = state.doc.nodeAt(pos);
		if (!current) {
			return;
		}
		const tr = state.tr.delete(pos, pos + current.nodeSize);
		tr.setSelection(
			TextSelection.near(
				tr.doc.resolve(Math.min(pos, tr.doc.content.size)),
			),
		);
		view.dispatch(tr.scrollIntoView());
		view.focus();
	}, [editor, getPos]);

	/** Open the caption field on the caption as it is now. */
	const openCaptionInput = useCallback(() => {
		setCaptionDraft(storedCaption);
		captionOpenRef.current = true;
		setShowCaptionInput(true);
		setFocusRequest("caption");
	}, [storedCaption]);

	/**
	 * Write `caption` into the node's `%% caption:` line in one transaction,
	 * dropping a caption attribute an older document carried. Nothing is
	 * dispatched when neither changes.
	 */
	const commitCaption = useCallback(
		(caption: string) => {
			captionOpenRef.current = false;
			setShowCaptionInput(false);
			const pos = getPos();
			if (pos === undefined) {
				return;
			}
			const { state, view } = editor;
			const current = state.doc.nodeAt(pos);
			if (!current || current.type.name !== MERMAID_NODE_NAME) {
				return;
			}
			const text = withDiagramCaption(current.textContent, caption);
			if (text === current.textContent && !current.attrs.caption) {
				return;
			}
			const replacement = current.type.create(
				{ ...current.attrs, caption: null },
				text ? [state.schema.text(text)] : [],
			);
			view.dispatch(
				state.tr.replaceWith(pos, pos + current.nodeSize, replacement),
			);
		},
		[editor, getPos],
	);

	const openInstructionPanel = useCallback(() => {
		setShowAIPrompt(false);
		setAiError(null);
		setShowInstructionPanel(true);
		setFocusRequest("instruction");
	}, []);

	/** Runs the chosen item once the menu has closed, and moves focus. */
	const runMenuAction = useCallback(
		(action: MenuAction) => {
			switch (action) {
				case "instruction":
					openInstructionPanel();
					return;
				case "ai":
					setShowInstructionPanel(false);
					setShowAIPrompt(true);
					setFocusRequest("ai");
					return;
				case "source":
					setSourceOrigin("menu");
					setFocusRequest("code");
					return;
				case "caption":
					openCaptionInput();
					return;
				case "delete":
					deleteNodeKeepingCaret();
					return;
			}
		},
		[openInstructionPanel, openCaptionInput, deleteNodeKeepingCaret],
	);

	/** The diagram as it is now, with its position among the document's diagrams. */
	const readEditTarget = useCallback(() => {
		const pos = getPos();
		if (pos === undefined) {
			return null;
		}
		const current = editor.state.doc.nodeAt(pos);
		if (!current || current.type.name !== MERMAID_NODE_NAME) {
			return null;
		}
		const doc = editor.state.doc;
		const ordinal = diagramsOf(doc).positions.indexOf(pos);
		if (ordinal === -1) {
			return null;
		}
		const visualId = diagramEditVisualId(doc, visual?.specs, ordinal);
		return {
			code: current.textContent,
			ordinal,
			...(visualId ? { visualId } : {}),
		};
	}, [editor, getPos, visual?.specs]);

	/**
	 * Replace only this node with the candidate, in one transaction, when it
	 * still holds the source the candidate was made from, the marker id an
	 * edit of it names (if any) is the candidate's, and its section, as the
	 * editor would save it, still has the fingerprint of the section the
	 * server checked the candidate against. Two diagrams with the same source
	 * in one section pass the other checks alike.
	 */
	const applyCandidate = useCallback(
		(
			fence: string,
			sentHash: string,
			sectionFingerprint: string,
			visualId: string,
		): "applied" | "stale" => {
			const pos = getPos();
			if (pos === undefined) {
				return "stale";
			}
			const { state, view } = editor;
			const current = state.doc.nodeAt(pos);
			if (
				!current ||
				current.type.name !== MERMAID_NODE_NAME ||
				visualSourceHash(current.textContent) !== sentHash
			) {
				return "stale";
			}
			const ordinal = diagramsOf(state.doc).positions.indexOf(pos);
			const saved = getEditorMarkdownForSave(editor);
			const namedId =
				ordinal === -1
					? undefined
					: diagramEditVisualId(state.doc, visual?.specs, ordinal);
			if (
				ordinal === -1 ||
				saved === null ||
				(namedId !== undefined && namedId !== visualId) ||
				diagramSectionFingerprint(saved, ordinal) !== sectionFingerprint
			) {
				return "stale";
			}
			// The caption is the person's, whatever the candidate carries.
			const text = withDiagramCaption(fence, captionOf(current));
			const replacement = current.type.create(
				{ ...current.attrs, caption: null },
				text ? [state.schema.text(text)] : [],
			);
			view.dispatch(
				state.tr.replaceWith(pos, pos + current.nodeSize, replacement),
			);
			return "applied";
		},
		[editor, getPos, visual?.specs],
	);

	const renderCandidate = useCallback(
		async (candidate: string) =>
			(
				await drawDiagram(candidate, {
					isDark: resolvedTheme === "dark",
					paint,
					figureIdPrefix: `${figureIds}-candidate`,
				})
			).svg,
		[resolvedTheme, paint, figureIds],
	);

	const closeInstructionPanel = useCallback(() => {
		setShowInstructionPanel(false);
		setFocusRequest("trigger");
	}, []);

	const origin = useDiagramOrigin(editor, getPos, visual?.specs);
	const originLabel =
		origin === null
			? null
			: tVisuals(
					origin === VISUAL_ORIGIN.INSTRUCTION
						? "origin.instruction"
						: "origin.step",
				);
	const canEditWithInstructions =
		visual !== null &&
		editor.isEditable &&
		isFlowchartSource(node.textContent);
	// Only where Edit with instructions is offered, since the line names it.
	const fixedColours =
		visual !== null &&
		isFlowchartSource(node.textContent) &&
		hasFixedColours(node.textContent);
	// What the export does with the fence (`diagram-printability.ts`). A
	// drawn diagram that does not print as drawn (a kind only mermaid.js
	// draws, which prints as a placeholder, or a fence only mermaid.js could
	// draw, which is left out) is noted to the people who can change it.
	const printability = livePrintability(node.textContent);
	const notPrintable =
		visual !== null &&
		editor.isEditable &&
		svg !== "" &&
		engine !== null &&
		!printsAsDrawn(printability, engine);

	const {
		areaRef: diagramRef,
		sizing,
		scrollEdge,
		onScroll: onDiagramScroll,
	} = useMermaidDiagramSizing(svg, {
		// The review view, like the code view, has no diagram area.
		showCode: showCode || underReview,
		error,
		mounted,
		// A template keeps its text at 10 px or more down to this width.
		minWidth: engine === "template" ? FIGURE_MIN_LIVE_WIDTH : undefined,
	});
	const scrollable = sizing?.scrollable === true;

	/**
	 * Shared "Build with AI" input panel. Rendered inside both the code view
	 * and the rendered diagram view so behaviour stays in sync. Pulls all
	 * state from the enclosing closure — no props needed.
	 */
	const renderAIPanel = () => {
		if (!showAIPrompt || !editor.isEditable) {
			return null;
		}
		return (
			<div className="px-3 py-3 border-b bg-muted/20">
				<div className="flex gap-2">
					<textarea
						ref={aiPromptInputRef}
						className="flex-1 min-h-[60px] p-2 text-sm rounded-md border bg-background resize-none outline-none focus:ring-1 focus:ring-primary/50"
						placeholder={
							isSuggesting
								? "Suggesting a diagram based on your document…"
								: "Describe the diagram you want, e.g. 'User authentication flow with login, 2FA, and password reset'"
						}
						value={aiPrompt}
						onChange={(e) => {
							setAiPrompt(e.target.value);
							if (suggestionApplied) {
								setSuggestionApplied(false);
							}
						}}
						onKeyDown={(e) => {
							e.stopPropagation();
							if (
								e.key === "Enter" &&
								!e.shiftKey &&
								(e.ctrlKey || e.metaKey)
							) {
								e.preventDefault();
								generateWithAI(aiPrompt);
							}
							if (e.key === "Escape") {
								e.preventDefault();
								setShowAIPrompt(false);
								setAiError(null);
							}
						}}
						disabled={isGenerating}
						aria-label="Describe the diagram for AI to generate"
					/>
					<div className="flex flex-col gap-1">
						<button
							type="button"
							onClick={() => generateWithAI(aiPrompt)}
							disabled={isGenerating || !aiPrompt.trim()}
							className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						>
							{isGenerating ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Sparkles className="h-3.5 w-3.5" />
							)}
							{isGenerating ? "Generating..." : "Generate"}
						</button>
						<button
							type="button"
							onClick={() => {
								setShowAIPrompt(false);
								setAiError(null);
							}}
							className="px-3 py-1.5 text-xs rounded-md text-muted-foreground hover:bg-muted transition-colors"
						>
							Cancel
						</button>
					</div>
				</div>
				{suggestionApplied && !isGenerating && (
					<p className="mt-2 text-xs text-muted-foreground italic">
						<Sparkles className="inline h-3 w-3 mr-1" />
						AI suggestion based on the section above — edit or press
						Generate.
					</p>
				)}
				{showFullDocToggle && (
					<label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
						<input
							type="checkbox"
							className="h-3.5 w-3.5 rounded border-border accent-primary"
							checked={useFullDoc}
							onChange={(e) => setUseFullDoc(e.target.checked)}
							disabled={isGenerating}
						/>
						Use full document as context (otherwise only the current
						section is sent)
					</label>
				)}
				{aiError && (
					<p className="mt-2 text-xs text-destructive">{aiError}</p>
				)}
				<p className="mt-1.5 text-xs text-muted-foreground">
					Ctrl+Enter to generate · Esc to cancel
				</p>
			</div>
		);
	};

	/**
	 * Edit with instructions (Fizzy #2946), on a client-document Proposal's
	 * flowcharts only. Its candidate shows below the current diagram.
	 */
	const renderInstructionPanel = () => {
		if (!showInstructionPanel || !visual || !canEditWithInstructions) {
			return null;
		}
		return (
			<MermaidEditVisualPanel
				visual={visual}
				readTarget={readEditTarget}
				applyCandidate={applyCandidate}
				renderCandidate={renderCandidate}
				onClose={closeInstructionPanel}
				announce={visual.announce}
				textareaRef={instructionInputRef}
			/>
		);
	};

	if (!mounted) {
		return (
			<NodeViewWrapper className="mermaid-wrapper">
				<HiddenSource />
				<div className="my-4 flex min-h-[200px] items-center justify-center rounded-xl border bg-muted/30">
					<div className="text-sm text-muted-foreground">
						Loading diagram...
					</div>
				</div>
			</NodeViewWrapper>
		);
	}

	// An AI edit under review: the source with its marks, which the review
	// bar's Accept and Reject act on, and the diagram it proposes. No source
	// editor or menu here: their saves would write the mixed text unmarked.
	if (underReview) {
		const reviewLabelId = `${menuIds}-review`;
		const previewLabelId = `${menuIds}-review-preview`;
		return (
			<NodeViewWrapper className="mermaid-wrapper">
				{/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> groups form controls; this names the source under review, which ProseMirror edits as document text */}
				<div
					role="group"
					aria-labelledby={reviewLabelId}
					className="mermaid-container my-4 rounded-lg border bg-card overflow-hidden"
				>
					<div
						id={reviewLabelId}
						contentEditable={false}
						className="flex items-center gap-2 px-3 py-2 border-b bg-muted/50 text-xs text-muted-foreground"
					>
						<Code className="h-3.5 w-3.5" aria-hidden="true" />
						{tReview("label")}
					</div>
					{/* A div, not a pre: the editor's code block colours would
					    leave the deletion marks unreadable. */}
					<NodeViewContent className="px-4 py-3 font-mono text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words" />
					{reviewSvg && (
						<figure
							contentEditable={false}
							// Named by its caption outright: not every reader
							// takes a figure's name from its figcaption.
							aria-labelledby={previewLabelId}
							className="m-0 border-t"
						>
							<figcaption
								id={previewLabelId}
								className="px-3 pt-2 text-xs text-muted-foreground"
							>
								{tReview("preview")}
							</figcaption>
							<div
								className="mermaid-diagram-area flex items-center justify-center p-6 overflow-auto"
								// biome-ignore lint/security/noDangerouslySetInnerHtml: run through sanitizeDiagramSvg in drawDiagram, the only writer of this state
								dangerouslySetInnerHTML={{ __html: reviewSvg }}
							/>
						</figure>
					)}
				</div>
			</NodeViewWrapper>
		);
	}

	// A client-document Proposal's diagram that does not draw: the page
	// says what the exports do in its place (`MermaidFailureView`).
	if (visual !== null && error && !showCode) {
		return (
			<NodeViewWrapper className="mermaid-wrapper">
				<HiddenSource />
				<MermaidFailureView
					labelId={`${menuIds}-failure`}
					caption={storedCaption}
					readOnly={!editor.isEditable}
					variant={
						isLiveFigureCounted(printability, null)
							? "placeholder"
							: "omitted"
					}
					onEditSource={() => {
						setShowInstructionPanel(false);
						setSourceOrigin("failure");
						setFocusRequest("code");
					}}
					onEditWithInstructions={
						canEditWithInstructions
							? openInstructionPanel
							: undefined
					}
					onDelete={deleteNodeKeepingCaret}
					instructionsTriggerRef={triggerRef}
				>
					{renderInstructionPanel()}
				</MermaidFailureView>
			</NodeViewWrapper>
		);
	}

	// If showing code or there's an error, show the code view
	if (showCode || error) {
		const isEditing = editableCode !== null;
		const displayCode = isEditing ? editableCode : code;
		const hasChanges = isEditing && editableCode !== code;
		/**
		 * Save the edited source. Opened from the failure view, the view
		 * closes: the diagram draws, or the failure view returns.
		 */
		const saveSource = (text: string) => {
			saveCode(text);
			if (sourceOrigin === "failure") {
				setSourceOrigin(null);
			}
		};

		return (
			<NodeViewWrapper className="mermaid-wrapper">
				<HiddenSource />
				<div className="mermaid-container border rounded-lg overflow-hidden my-4 bg-muted/30">
					{/* Header */}
					<div className="flex items-center justify-between px-3 py-2 border-b bg-muted/50">
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Code className="h-4 w-4" />
							<span>Mermaid Diagram</span>
							{error && (
								<span className="flex items-center gap-1 text-destructive">
									<AlertCircle className="h-3 w-3" />
									Error
								</span>
							)}
						</div>
						<div className="flex items-center gap-1">
							{hasChanges && editor.isEditable && (
								<button
									type="button"
									onClick={() => {
										if (editableCode) {
											saveSource(editableCode);
										}
									}}
									className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
								>
									<Check className="h-3 w-3" />
									Save
								</button>
							)}
							{error && canEditWithInstructions && (
								<button
									type="button"
									onClick={openInstructionPanel}
									className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
								>
									<WandSparkles
										className="h-3.5 w-3.5"
										aria-hidden="true"
									/>
									{tMenu("editWithInstructions")}
								</button>
							)}
							{editor.isEditable && (
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											onClick={() => {
												setShowInstructionPanel(false);
												setShowAIPrompt((v) => !v);
												requestAnimationFrame(() =>
													aiPromptInputRef.current?.focus(),
												);
											}}
											className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
										>
											<Sparkles className="h-3.5 w-3.5" />
											AI
										</button>
									</TooltipTrigger>
									<TooltipContent>
										{tEditorTooltips("buildDiagramWithAi")}
									</TooltipContent>
								</Tooltip>
							)}
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										onClick={() => renderDiagram()}
										className="p-1.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground transition-colors"
										aria-label={tTooltips("reload")}
									>
										<RefreshCw
											className={`h-4 w-4 ${isRendering ? "animate-spin" : ""}`}
										/>
									</button>
								</TooltipTrigger>
								<TooltipContent>
									{tTooltips("reload")}
								</TooltipContent>
							</Tooltip>
							{(!error || sourceOrigin === "failure") && (
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											onClick={() => {
												setSourceOrigin(null);
												setEditableCode(null);
											}}
											className="p-1.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground transition-colors"
											aria-label={tEditorTooltips(
												"showDiagram",
											)}
										>
											<Eye className="h-4 w-4" />
										</button>
									</TooltipTrigger>
									<TooltipContent>
										{tEditorTooltips("showDiagram")}
									</TooltipContent>
								</Tooltip>
							)}
							{editor.isEditable && (
								<DestructiveTooltip
									copy={tTooltips.raw("delete")}
								>
									<button
										type="button"
										onClick={deleteNode}
										className="p-1.5 hover:bg-destructive/10 rounded text-muted-foreground hover:text-destructive transition-colors"
										aria-label={tMenu("deleteDiagram")}
									>
										<Trash2 className="h-4 w-4" />
									</button>
								</DestructiveTooltip>
							)}
						</div>
					</div>

					{/* Error message */}
					{error && (
						<div className="px-3 py-2 bg-destructive/10 text-destructive text-sm border-b">
							{error}
						</div>
					)}

					{/* AI prompt panel */}
					{renderAIPanel()}

					{error && renderInstructionPanel()}

					{/* Code - editable textarea when editor is editable, read-only pre otherwise */}
					{editor.isEditable ? (
						<textarea
							ref={codeTextareaRef}
							className="w-full p-4 text-sm font-mono bg-muted/20 border-0 outline-none resize-y min-h-[120px]"
							value={displayCode}
							onChange={(e) => setEditableCode(e.target.value)}
							onFocus={() => {
								if (editableCode === null) {
									setEditableCode(code);
								}
							}}
							onKeyDown={(e) => {
								// Ctrl/Cmd+Enter to save
								if (
									e.key === "Enter" &&
									(e.ctrlKey || e.metaKey)
								) {
									e.preventDefault();
									if (editableCode) {
										saveSource(editableCode);
									}
								}
								// Tab inserts spaces instead of moving focus
								if (e.key === "Tab") {
									e.preventDefault();
									const target =
										e.target as HTMLTextAreaElement;
									const start = target.selectionStart;
									const end = target.selectionEnd;
									const val = target.value;
									const newVal = `${val.substring(0, start)}    ${val.substring(end)}`;
									setEditableCode(newVal);
									requestAnimationFrame(() => {
										target.selectionStart = start + 4;
										target.selectionEnd = start + 4;
									});
								}
								// Prevent TipTap from capturing keyboard events
								e.stopPropagation();
							}}
							spellCheck={false}
							aria-label="Mermaid diagram code"
						/>
					) : (
						<pre className="p-4 overflow-x-auto text-sm font-mono bg-muted/20">
							<code>{displayCode}</code>
						</pre>
					)}
					{editor.isEditable && (
						<div className="px-3 py-1.5 border-t bg-muted/30 text-xs text-muted-foreground">
							Ctrl+Enter to save changes
						</div>
					)}
				</div>
			</NodeViewWrapper>
		);
	}

	const scrollRegionLabel = captionValue
		? `${tMenu("scrollRegion")}: ${captionValue}`
		: tMenu("scrollRegion");
	const diagramArea = (
		<div
			ref={diagramRef}
			className="mermaid-diagram-area flex items-center justify-center p-6 overflow-auto"
			// A diagram wider than its column scrolls sideways (see `sizing`):
			// it is then a named region a keyboard can reach and scroll.
			{...(scrollable
				? {
						// A scrolling region is reachable by keyboard so it can be scrolled.
						tabIndex: 0,
						role: "region",
						"aria-label": scrollRegionLabel,
						"data-diagram-scroll": "",
						"data-scroll-edge": scrollEdge,
						style: {
							"--pa-diagram-width": `${sizing?.width ?? 0}px`,
						} as CSSProperties,
						onScroll: onDiagramScroll,
					}
				: {})}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: run through sanitizeDiagramSvg above, which is the only writer of this state
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);

	// A drawn diagram on a client-document Proposal's page is a numbered
	// figure when the export numbers it too (`isLiveFigureCounted`): the
	// theme's stylesheet counts each `pa-figure-counted` wrapper and prints
	// "Figure n." before its `pa-figure-caption`. A fence only mermaid.js
	// could draw, of a kind the export draws, is left out of print and takes
	// no number here either; the failure view numbers itself.
	const counted =
		visual !== null &&
		svg !== "" &&
		engine !== null &&
		isLiveFigureCounted(printability, engine);
	const captionClassName = counted
		? "pa-figure-caption px-3 py-2 border-t text-center"
		: "px-3 py-2 border-t text-center";

	// Caption display / edit
	const captionSection = (
		<>
			{(showCaptionInput || captionValue) && (
				<div className={captionClassName} contentEditable={false}>
					{showCaptionInput ? (
						<input
							ref={captionInputRef}
							type="text"
							value={captionDraft}
							onChange={(e) => setCaptionDraft(e.target.value)}
							onKeyDown={(e) => {
								e.stopPropagation();
								if (e.key === "Enter") {
									e.preventDefault();
									commitCaption(captionDraft);
								}
								if (e.key === "Escape") {
									e.preventDefault();
									captionOpenRef.current = false;
									setShowCaptionInput(false);
								}
							}}
							onBlur={() => {
								if (captionOpenRef.current) {
									commitCaption(captionDraft);
								}
							}}
							placeholder={tMenu("captionPlaceholder")}
							className="w-full max-w-md mx-auto bg-transparent text-sm text-muted-foreground text-center outline-none border-none"
							aria-label={tMenu("captionLabel")}
						/>
					) : (
						<button
							type="button"
							onClick={() => {
								if (editor.isEditable) {
									openCaptionInput();
								}
							}}
							className="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-text"
						>
							{captionValue || tMenu("captionPlaceholder")}
						</button>
					)}
				</div>
			)}
			{/* An uncaptioned figure still reads "Figure n." under the
			    theme, whose stylesheet prints the number into this line. */}
			{counted &&
				paint !== null &&
				!showCaptionInput &&
				!captionValue && (
					<div className={captionClassName} contentEditable={false} />
				)}
		</>
	);

	if (visual !== null) {
		const selectAction = (action: MenuAction) => () => {
			menuActionRef.current = action;
		};
		return (
			<NodeViewWrapper className="mermaid-wrapper">
				<HiddenSource />
				<div
					className={`mermaid-container mermaid-visual group relative my-4 rounded-lg border bg-card overflow-hidden${counted ? " pa-figure-counted" : ""}`}
					data-visual-menu=""
				>
					{/* A strip of its own above the scrolling area, so the
					    menu never covers the diagram or scrolls away. */}
					{(editor.isEditable || originLabel || fixedColours) && (
						<div
							className="mermaid-visual-strip flex min-h-9 items-center justify-between gap-2 px-3 py-1"
							contentEditable={false}
						>
							<div className="min-w-0 text-xs text-muted-foreground">
								{originLabel && <p>{originLabel}</p>}
								{fixedColours && (
									<p>{tVisuals("fixedColours")}</p>
								)}
								{notPrintable && (
									<p data-diagram-not-printable="">
										{tVisuals("notPrintable")}
									</p>
								)}
							</div>
							{editor.isEditable && (
								// Not modal: a menu inside the document must neither
								// lock the page's scroll nor hide the rest of the
								// editor from assistive technology.
								<DropdownMenu modal={false}>
									<DropdownMenuTrigger asChild>
										<button
											ref={triggerRef}
											type="button"
											aria-label={tMenu("trigger")}
											className="mermaid-visual-trigger ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										>
											<EllipsisVertical
												className="h-4 w-4"
												aria-hidden="true"
											/>
										</button>
									</DropdownMenuTrigger>
									<DropdownMenuContent
										align="end"
										className="w-64"
										onCloseAutoFocus={(event) => {
											const action =
												menuActionRef.current;
											menuActionRef.current = null;
											if (action) {
												// Focus goes where the item says, not
												// back to the trigger.
												event.preventDefault();
												runMenuAction(action);
											}
										}}
									>
										{canEditWithInstructions && (
											<>
												<DescribedMenuItem
													id={`${menuIds}-instruction`}
													icon={WandSparkles}
													label={tMenu(
														"editWithInstructions",
													)}
													description={tMenu(
														"editWithInstructionsDescription",
													)}
													onSelect={selectAction(
														"instruction",
													)}
												/>
												<DropdownMenuSeparator />
											</>
										)}
										{visual.isMember && (
											<DescribedMenuItem
												id={`${menuIds}-ai`}
												icon={Sparkles}
												label={tMenu("buildWithAi")}
												description={tMenu(
													"buildWithAiDescription",
												)}
												onSelect={selectAction("ai")}
											/>
										)}
										<DropdownMenuItem
											className="gap-2"
											onSelect={selectAction("source")}
										>
											<Code
												className="h-4 w-4"
												aria-hidden="true"
											/>
											{tMenu("editSource")}
										</DropdownMenuItem>
										<DropdownMenuItem
											className="gap-2"
											onSelect={selectAction("caption")}
										>
											<TextCursorInput
												className="h-4 w-4"
												aria-hidden="true"
											/>
											{tMenu("caption")}
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
											onSelect={selectAction("delete")}
										>
											<Trash2
												className="h-4 w-4"
												aria-hidden="true"
											/>
											{tMenu("delete")}
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							)}
						</div>
					)}

					{/* Build with AI */}
					{renderAIPanel()}

					{diagramArea}

					{renderInstructionPanel()}

					{captionSection}
				</div>
			</NodeViewWrapper>
		);
	}

	// Show rendered diagram
	return (
		<NodeViewWrapper className="mermaid-wrapper">
			<HiddenSource />
			<div className="mermaid-container group relative my-4 rounded-lg border bg-card overflow-hidden">
				{/* Header bar */}
				<div className="flex items-center justify-between px-3 py-2 border-b bg-muted/50">
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<svg
							className="h-3.5 w-3.5"
							viewBox="0 0 24 24"
							fill="currentColor"
							aria-hidden="true"
						>
							<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
						</svg>
						<span>Mermaid</span>
					</div>
					<div className="flex items-center gap-1">
						{editor.isEditable && (
							<>
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											onClick={() => {
												setShowAIPrompt((v) => !v);
												requestAnimationFrame(() =>
													aiPromptInputRef.current?.focus(),
												);
											}}
											className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
										>
											<Sparkles className="h-3.5 w-3.5" />
											Build with AI
										</button>
									</TooltipTrigger>
									<TooltipContent>
										{tEditorTooltips("buildDiagramWithAi")}
									</TooltipContent>
								</Tooltip>
								<div className="w-px h-4 bg-border mx-0.5" />
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											onClick={() =>
												setSourceOrigin("menu")
											}
											className="p-1.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
											aria-label={tEditorTooltips(
												"editDiagramSource",
											)}
										>
											<Code className="h-4 w-4" />
										</button>
									</TooltipTrigger>
									<TooltipContent>
										{tEditorTooltips("editDiagramSource")}
									</TooltipContent>
								</Tooltip>
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											onClick={openCaptionInput}
											className="p-1.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
											aria-label="Add or edit caption"
										>
											<TextCursorInput className="h-4 w-4" />
										</button>
									</TooltipTrigger>
									<TooltipContent>
										{tEditorTooltips("addCaption")}
									</TooltipContent>
								</Tooltip>
								<DestructiveTooltip
									copy={tTooltips.raw("delete")}
								>
									<button
										type="button"
										onClick={deleteNode}
										className="p-1.5 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
										aria-label={tMenu("deleteDiagram")}
									>
										<Trash2 className="h-4 w-4" />
									</button>
								</DestructiveTooltip>
							</>
						)}
					</div>
				</div>

				{/* AI prompt panel */}
				{renderAIPanel()}

				{/* Diagram rendering area */}
				{diagramArea}

				{captionSection}
			</div>
		</NodeViewWrapper>
	);
}

/**
 * Custom TipTap extension for rendering Mermaid diagrams
 * Supports: flowcharts, sequence diagrams, class diagrams, C4 diagrams, etc.
 *
 * COMPATIBILITY NOTES:
 * - This is a Node extension (block-level), NOT a Mark extension
 * - Diff highlighting uses Mark extensions (<em>, <s>) which are processed separately
 * - This extension will NOT interfere with diff highlighting or streaming updates
 * - renderHTML outputs <pre><code class="language-mermaid"> which Turndown's
 *   fencedCodeBlocks rule will correctly convert back to ```mermaid code fences
 * - Priority is set higher than CodeBlockLowlight to capture mermaid blocks first
 */
export const MermaidBlock = Node.create({
	name: MERMAID_NODE_NAME,

	// LOWER priority than CodeBlockLowlight (default is ~100) to capture mermaid blocks first
	// In TipTap, lower priority = registered first = parseHTML rules checked first
	priority: 50,

	group: "block",

	content: "text*",

	// The two diff markers only — same reason `CodeBlockLowlightNoMermaid`
	// admits them (see the comment there); this node just claims mermaid fences
	// first. Under `marks: ""` a `<del>` inside a diagram was dropped on parse
	// while its text survived, so an accepted edit saved `A --> BC`.
	marks: "diffInsert diffDelete",

	// The source is code: its whitespace is kept as written. Without it,
	// ProseMirror reading the node back from the DOM (an overlay's
	// `aria-hidden` on the blocks around it is enough) turned every line
	// break into a space, and the autosave kept the one-line diagram
	// (Fizzy #2946). Enter inside the source adds a line, as in a code
	// block, rather than splitting the diagram in two.
	code: true,

	defining: true,

	isolating: true,

	addAttributes() {
		return {
			language: {
				default: "mermaid",
				parseHTML: () => "mermaid",
				renderHTML: () => ({ "data-language": "mermaid" }),
			},
			// Read from older documents only: the caption is the body's
			// `%% caption:` line, and the save folds this one into it.
			caption: {
				default: null,
				parseHTML: (element: HTMLElement) =>
					element.getAttribute("data-caption") || null,
				renderHTML: (attributes: Record<string, unknown>) => {
					if (!attributes.caption) {
						return {};
					}
					return { "data-caption": attributes.caption as string };
				},
			},
			diagramType: {
				default: null,
				parseHTML: (element: HTMLElement) =>
					element.getAttribute("data-diagram-type") || null,
				renderHTML: (attributes: Record<string, unknown>) => {
					if (!attributes.diagramType) {
						return {};
					}
					return {
						"data-diagram-type": attributes.diagramType as string,
					};
				},
			},
		};
	},

	parseHTML() {
		return [
			{
				tag: "pre",
				preserveWhitespace: "full",
				getAttrs: (node) => {
					const element = node as HTMLElement;
					const codeElement = element.querySelector("code");
					const language =
						codeElement
							?.getAttribute("class")
							?.replace("language-", "")
							?.toLowerCase() ||
						element.getAttribute("data-language")?.toLowerCase();

					// Match mermaid and all C4/diagram-specific code blocks
					if (language && MERMAID_LANGUAGES.includes(language)) {
						return { language: "mermaid" };
					}

					// Also check if the code content starts with a mermaid diagram type
					const content =
						codeElement?.textContent || element.textContent || "";
					const firstLine = content
						.trim()
						.split("\n")[0]
						.toLowerCase();
					const diagramKeywords = [
						"c4context",
						"c4container",
						"c4component",
						"c4deployment",
						"c4dynamic",
						"flowchart",
						"graph",
						"sequencediagram",
						"classdiagram",
						"statediagram",
						"statediagram-v2",
						"erdiagram",
						"gantt",
						"pie",
						"mindmap",
						"timeline",
						"gitgraph",
						"journey",
						"quadrantchart",
						"sankey",
						"xychart",
						"block",
					];

					if (
						diagramKeywords.some((keyword) =>
							firstLine.startsWith(keyword),
						)
					) {
						return { language: "mermaid" };
					}

					return false;
				},
			},
			{
				tag: 'code[class="language-mermaid"]',
				preserveWhitespace: "full",
			},
			// Also match C4-specific code blocks
			{
				tag: 'code[class*="language-c4"]',
				preserveWhitespace: "full",
			},
		];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"pre",
			mergeAttributes(HTMLAttributes, {
				"data-language": "mermaid",
				class: "mermaid-block",
			}),
			["code", { class: "language-mermaid" }, 0],
		];
	},

	addNodeView() {
		return ReactNodeViewRenderer(MermaidNodeView);
	},
});
