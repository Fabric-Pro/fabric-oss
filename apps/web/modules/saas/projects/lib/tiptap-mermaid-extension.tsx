"use client";

import { mergeAttributes, Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { DestructiveTooltip } from "@ui/components/destructive-tooltip";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import DOMPurify from "isomorphic-dompurify";
import {
	AlertCircle,
	Check,
	Code,
	Eye,
	Loader2,
	RefreshCw,
	Sparkles,
	TextCursorInput,
	Trash2,
} from "lucide-react";
import mermaid from "mermaid";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
 */
export function sanitizeDiagramSvg(dirty: string): string {
	return DOMPurify.sanitize(dirty, {
		USE_PROFILES: { svg: true, svgFilters: true },
	});
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

interface MermaidNodeViewProps {
	node: {
		attrs: Record<string, unknown>;
		textContent: string;
		nodeSize: number;
	};
	updateAttributes: (attrs: Record<string, unknown>) => void;
	editor: {
		isEditable: boolean;
		chain: () => any;
		state: any;
		view: any;
	};
	getPos: () => number | undefined;
}

function MermaidNodeView({
	node,
	editor,
	getPos,
	updateAttributes,
}: MermaidNodeViewProps) {
	const tTooltips = useTranslations("tooltips.common");
	const tEditorTooltips = useTranslations("tooltips.editor");
	const diagramRef = useRef<HTMLDivElement>(null);
	const [svg, setSvg] = useState<string>("");
	const [error, setError] = useState<string | null>(null);
	const [showCode, setShowCode] = useState(false);
	const [isRendering, setIsRendering] = useState(false);
	const [mounted, setMounted] = useState(false);
	const [editableCode, setEditableCode] = useState<string | null>(null);
	const [showCaptionInput, setShowCaptionInput] = useState(false);
	const [captionValue, setCaptionValue] = useState(
		(node.attrs.caption as string) || "",
	);
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
					saveCode(generated);
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
		[
			node.textContent,
			node.attrs.diagramType,
			saveCode,
			docContext,
			useFullDoc,
		],
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
		const code = node.textContent;
		if (!code.trim()) {
			setSvg("");
			setError(null);
			return;
		}

		setIsRendering(true);
		setError(null);

		try {
			let enhancedSvg = "";

			try {
				const beautifulMermaid = await import("beautiful-mermaid");
				// Use CSS variables so the SVG adapts to light/dark theme automatically.
				// The SVG references CSS custom properties defined on .mermaid-diagram-area,
				// which inherit from the app's design tokens. No re-render needed on theme switch.
				enhancedSvg = beautifulMermaid.renderMermaidSVG(code.trim(), {
					bg: "var(--mermaid-bg)",
					fg: "var(--mermaid-fg)",
					line: "var(--mermaid-line)",
					accent: "var(--mermaid-accent)",
					muted: "var(--mermaid-muted)",
					surface: "var(--mermaid-surface)",
					border: "var(--mermaid-border)",
					font: "ui-sans-serif, system-ui, -apple-system, sans-serif",
					transparent: true,
				});
			} catch {
				// Fallback to native mermaid.js for unsupported diagram types
				// (gantt, pie, mindmap, C4, timeline, etc.)
				const isDark = resolvedTheme === "dark";
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
				const { svg: renderedSvg } = await mermaid.render(
					id,
					code.trim(),
				);
				enhancedSvg = renderedSvg;
			}

			setSvg(sanitizeDiagramSvg(enhancedSvg));
			setError(null);
		} catch (err) {
			console.error("Mermaid render error:", err);
			setError(
				err instanceof Error ? err.message : "Failed to render diagram",
			);
			setSvg("");
		} finally {
			setIsRendering(false);
		}
	}, [node.textContent, resolvedTheme]);

	useEffect(() => {
		setMounted(true);
	}, []);

	useEffect(() => {
		if (!mounted) {
			return;
		}
		renderDiagram();
	}, [mounted, renderDiagram]);

	const code = node.textContent;

	const hasDocContext = Boolean(
		docContext.fullText || docContext.section || docContext.outline.length,
	);
	const showFullDocToggle =
		hasDocContext &&
		docContext.estimatedTokens >= FULL_DOC_AUTO_TOKEN_BUDGET;

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

	if (!mounted) {
		return (
			<NodeViewWrapper className="mermaid-wrapper">
				<div className="my-4 flex min-h-[200px] items-center justify-center rounded-xl border bg-muted/30">
					<div className="text-sm text-muted-foreground">
						Loading diagram...
					</div>
				</div>
			</NodeViewWrapper>
		);
	}

	// If showing code or there's an error, show the code view
	if (showCode || error) {
		const isEditing = editableCode !== null;
		const displayCode = isEditing ? editableCode : code;
		const hasChanges = isEditing && editableCode !== code;

		return (
			<NodeViewWrapper className="mermaid-wrapper">
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
											saveCode(editableCode);
										}
									}}
									className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
								>
									<Check className="h-3 w-3" />
									Save
								</button>
							)}
							{editor.isEditable && (
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
							{!error && (
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											onClick={() => {
												setShowCode(false);
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
										aria-label="Delete diagram"
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

					{/* Code - editable textarea when editor is editable, read-only pre otherwise */}
					{editor.isEditable ? (
						<textarea
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
										saveCode(editableCode);
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

	// Show rendered diagram
	return (
		<NodeViewWrapper className="mermaid-wrapper">
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
											onClick={() => setShowCode(true)}
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
											onClick={() => {
												setShowCaptionInput(true);
												requestAnimationFrame(() =>
													captionInputRef.current?.focus(),
												);
											}}
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
										aria-label="Delete diagram"
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
				<div
					ref={diagramRef}
					className="mermaid-diagram-area flex items-center justify-center p-6 overflow-auto"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: run through sanitizeDiagramSvg above, which is the only writer of this state
					dangerouslySetInnerHTML={{ __html: svg }}
				/>

				{/* Caption display / edit */}
				{(showCaptionInput || captionValue) && (
					<div
						className="px-3 py-2 border-t text-center"
						contentEditable={false}
					>
						{showCaptionInput ? (
							<input
								ref={captionInputRef}
								type="text"
								value={captionValue}
								onChange={(e) =>
									setCaptionValue(e.target.value)
								}
								onKeyDown={(e) => {
									e.stopPropagation();
									if (e.key === "Enter") {
										e.preventDefault();
										const trimmed =
											captionValue.trim() || null;
										updateAttributes({ caption: trimmed });
										setCaptionValue(trimmed || "");
										setShowCaptionInput(false);
									}
									if (e.key === "Escape") {
										e.preventDefault();
										setCaptionValue(
											(node.attrs.caption as string) ||
												"",
										);
										setShowCaptionInput(false);
									}
								}}
								onBlur={() => {
									const trimmed = captionValue.trim() || null;
									updateAttributes({ caption: trimmed });
									setCaptionValue(trimmed || "");
									setShowCaptionInput(false);
								}}
								placeholder="Add a caption..."
								className="w-full max-w-md mx-auto bg-transparent text-sm text-muted-foreground text-center outline-none border-none"
								aria-label="Diagram caption"
							/>
						) : (
							<button
								type="button"
								onClick={() => {
									if (editor.isEditable) {
										setShowCaptionInput(true);
										requestAnimationFrame(() =>
											captionInputRef.current?.focus(),
										);
									}
								}}
								className="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-text"
							>
								{captionValue || "Add a caption..."}
							</button>
						)}
					</div>
				)}
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
	name: "mermaidBlock",

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

	defining: true,

	isolating: true,

	addAttributes() {
		return {
			language: {
				default: "mermaid",
				parseHTML: () => "mermaid",
				renderHTML: () => ({ "data-language": "mermaid" }),
			},
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
