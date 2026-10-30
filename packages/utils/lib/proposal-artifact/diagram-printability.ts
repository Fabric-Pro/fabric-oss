/**
 * Which Proposal diagrams the export can draw (Fizzy #2946), shared by the
 * export's renderer and the live editor, so the editor's figure numbers,
 * its "not in PDF" note and what prints never disagree.
 *
 * The export draws a diagram fence with beautiful-mermaid (or a figure
 * template, decided before this), by that engine's own header rules:
 * xychart, sequence, class and ER diagrams are recognised on the fence's
 * very first line; anything else goes to its flowchart parser, which skips
 * `%%` lines and accepts only a `stateDiagram` or a `graph`/`flowchart` with
 * a direction. Anything else (a frontmatter block, gantt, pie, mindmap, a
 * mermaid `timeline`, a header it rejects) the live page draws with
 * mermaid.js, and print keeps only a captioned placeholder for it, as long
 * as mermaid.js knows the kind. A fence neither engine knows draws nowhere
 * and prints nothing.
 *
 * Both sides read the fence's `diagramPrintability`, and the live page
 * numbers a figure (`isLiveFigureCounted`) exactly when the export does, so
 * "Figure n." on the live page is "Figure n." in the PDF and the DOCX.
 *
 * Pure functions and data only: client components import this module.
 */

import type { FigurePalette } from "./proposal-figures";
import type { ProposalThemePaint } from "./theme-tokens";

/**
 * The kinds beautiful-mermaid takes. "graph" covers flowcharts and state
 * diagrams, whose node labels are drawn at one size; "other" is a chart,
 * sequence, class or ER diagram, whose text follows rules of its own.
 */
export type PrintableDiagramKind = "graph" | "other";

/** The first line that is not blank and not a `%%` comment, trimmed. */
function headerLine(trimmed: string): string | undefined {
	return trimmed
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0 && !line.startsWith("%%"));
}

/**
 * Which kind the export would draw the trimmed fence as, or null when only
 * the live page can draw it. Fed the fence as written, without its caption
 * line and before anything else is stripped from it.
 */
export function printableDiagramKind(
	trimmed: string,
): PrintableDiagramKind | null {
	const firstLine = trimmed.split(/[\n;]/)[0]?.trim().toLowerCase() ?? "";
	if (
		/^xychart(-beta)?\b/.test(firstLine) ||
		/^sequencediagram\s*$/.test(firstLine) ||
		/^classdiagram\s*$/.test(firstLine) ||
		/^erdiagram\s*$/.test(firstLine)
	) {
		return "other";
	}
	const header = headerLine(trimmed);
	if (
		header !== undefined &&
		(/^stateDiagram(-v2)?\s*$/i.test(header) ||
			/^(?:graph|flowchart)\s+(?:TD|TB|LR|BT|RL)\s*$/i.test(header))
	) {
		return "graph";
	}
	return null;
}

/**
 * How the export treats a fence: `printable` draws it with beautiful-mermaid
 * (left out when that fails), `liveOnly` is a kind only mermaid.js draws (a
 * numbered placeholder in print), and `unknown` is a fence neither engine
 * knows, empty or broken (left out).
 */
export type DiagramPrintability = "printable" | "liveOnly" | "unknown";

/**
 * The headers mermaid.js 11 recognises, by its own detectors, which run
 * after it strips a frontmatter block, directives and `%%` comments. Its
 * keywords are case-sensitive. It matches them as prefixes; here a keyword
 * must end where the word does, so a misspelt one (`sequenceDiagramm`) is
 * unknown rather than a kind print keeps a placeholder for. The printable
 * kinds are here too, for a fence whose header beautiful-mermaid rejects (a
 * frontmatter block, a comment before a sequence header, a bare `graph`).
 */
const MERMAID_JS_HEADER =
	/^(?:graph|flowchart(?:-elk)?|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|xychart(?:-beta)?|gantt|pie|mindmap|timeline|journey|gitGraph|quadrantChart|requirement(?:Diagram)?|C4(?:Context|Container|Component|Dynamic|Deployment)|sankey(?:-beta)?|block(?:-beta)?|packet(?:-beta)?|architecture(?:-beta)?|kanban|radar-beta|treemap(?:-beta)?)(?![\w-])/;

/** A leading `---` frontmatter block, which mermaid.js reads and drops. */
const FRONTMATTER = /^---[ \t]*\n(?:[\s\S]*?\n)?---[ \t]*(?:\n|$)/;

/**
 * How the export treats the trimmed fence, fed as `printableDiagramKind` is.
 * A flowchart whose header names no direction it knows is `unknown`, though
 * mermaid.js detects it: it fails to draw on the live page too.
 */
export function diagramPrintability(trimmed: string): DiagramPrintability {
	if (printableDiagramKind(trimmed) !== null) {
		return "printable";
	}
	const body = trimmed.replace(FRONTMATTER, "");
	if (hasBrokenFlowchartHeader(body)) {
		return "unknown";
	}
	const header = headerLine(body);
	return header !== undefined && MERMAID_JS_HEADER.test(header)
		? "liveOnly"
		: "unknown";
}

/**
 * Which engine drew a diagram on the live page: its figure template,
 * beautiful-mermaid, or mermaid.js when beautiful-mermaid refused it.
 */
export type LiveDiagramEngine = "template" | "beautiful-mermaid" | "mermaid";

/**
 * Whether a diagram on the live page takes a figure number, as the export
 * numbers the same fence: a figure template and a beautiful-mermaid drawing
 * of a printable kind print drawn, and a `liveOnly` kind prints as a
 * numbered placeholder whether or not the live page could draw it. A
 * printable kind only mermaid.js drew, and an `unknown` fence, are left out
 * of print. `engine` is null when the live page did not draw it.
 */
export function isLiveFigureCounted(
	printability: DiagramPrintability,
	engine: LiveDiagramEngine | null,
): boolean {
	return (
		engine === "template" ||
		printability === "liveOnly" ||
		(printability === "printable" && engine === "beautiful-mermaid")
	);
}

/**
 * Whether a diagram the live page drew prints as drawn. Not when only
 * mermaid.js could draw it: print then keeps a placeholder (a `liveOnly`
 * kind) or leaves it out.
 */
export function printsAsDrawn(
	printability: DiagramPrintability,
	engine: LiveDiagramEngine,
): boolean {
	return (
		engine === "template" ||
		(printability === "printable" && engine === "beautiful-mermaid")
	);
}

/**
 * Whether the trimmed fence is a flowchart whose header names something
 * after `graph`/`flowchart` that is not a direction (`flowchart LRt0TD`):
 * a broken source rather than a kind only the live page draws. A bare
 * `graph`, which mermaid.js reads as top-down, is not one, nor is a
 * one-line `graph TD; A --> B`, which mermaid.js draws too.
 */
export function hasBrokenFlowchartHeader(trimmed: string): boolean {
	const header = headerLine(trimmed);
	const direction =
		header === undefined
			? undefined
			: /^(?:graph|flowchart)\s+([^\s;]+)/i.exec(header)?.[1];
	return direction !== undefined && !/^(?:TD|TB|LR|BT|RL)$/i.test(direction);
}

/**
 * A figure template's palette, from the same paint the diagram roles
 * (`withVisualRoleClassDefs`) are coloured from.
 */
export function figurePaletteOf(paint: ProposalThemePaint): FigurePalette {
	return {
		ink: paint.ink,
		onInk: paint.onInk,
		primary: paint.primary,
		onPrimary: paint.onPrimary,
		tint: paint.tint,
		border: paint.border,
		surface: paint.surface,
		muted: paint.muted,
	};
}
