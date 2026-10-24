/**
 * The editor's diagrams by document order, and each one's classification as
 * generated or a person's diagram (Fizzy #2946). Both are computed once per
 * document, since every diagram's node view reads them.
 */

import {
	classifyVisualFences,
	readVisualMarker,
	type VisualFenceClassification,
	type VisualOrigin,
	type VisualSpecSummary,
} from "@repo/utils/proposal-artifact/visual-identity";
import { useCallback, useSyncExternalStore } from "react";

/** The diagram node's schema name. */
export const MERMAID_NODE_NAME = "mermaidBlock";

type DocNodeLike = {
	type: { name: string };
	textContent: string;
};

type DocLike = {
	descendants: (
		callback: (node: DocNodeLike, pos: number) => boolean | undefined,
	) => void;
};

interface DiagramIndex {
	/** Each diagram's position, by ordinal. */
	positions: number[];
	texts: string[];
}

/** The part of the editor a diagram's origin is read from. */
interface DiagramIndexEditor {
	state: { doc: DocLike };
	on: (event: "update", listener: () => void) => unknown;
	off: (event: "update", listener: () => void) => unknown;
}

const diagramsByDoc = new WeakMap<DocLike, DiagramIndex>();

/**
 * Every diagram node of `doc` in document order, nested ones included.
 * Documents are immutable, so each is walked once for all its diagrams.
 */
export function diagramsOf(doc: DocLike): DiagramIndex {
	const cached = diagramsByDoc.get(doc);
	if (cached) {
		return cached;
	}
	const index: DiagramIndex = { positions: [], texts: [] };
	doc.descendants((node, pos) => {
		if (node.type.name === MERMAID_NODE_NAME) {
			index.positions.push(pos);
			index.texts.push(node.textContent);
			return false;
		}
		return true;
	});
	diagramsByDoc.set(doc, index);
	return index;
}

const classificationsByDoc = new WeakMap<
	DocLike,
	WeakMap<readonly VisualSpecSummary[], VisualFenceClassification[]>
>();

/** {@link classifyEditorDiagrams} once per document and spec summaries. */
function classificationsOf(
	doc: DocLike,
	specs: readonly VisualSpecSummary[],
): VisualFenceClassification[] {
	let bySpecs = classificationsByDoc.get(doc);
	if (!bySpecs) {
		bySpecs = new WeakMap();
		classificationsByDoc.set(doc, bySpecs);
	}
	let result = bySpecs.get(specs);
	if (!result) {
		result = classifyEditorDiagrams(diagramsOf(doc).texts, specs);
		bySpecs.set(specs, result);
	}
	return result;
}

/**
 * The marker id an edit of the `ordinal`-th diagram may name: none for a
 * detached diagram (a second copy, or an id without a stored spec), since
 * the id is the first occurrence's. While the summaries load or when their
 * read failed, only a second copy is known to be detached.
 */
export function diagramEditVisualId(
	doc: DocLike,
	specs: readonly VisualSpecSummary[] | undefined,
	ordinal: number,
): string | undefined {
	const { texts } = diagramsOf(doc);
	const text = texts[ordinal];
	if (text === undefined) {
		return undefined;
	}
	if (specs) {
		const classification = classificationsOf(doc, specs)[ordinal];
		return classification?.state === "detached"
			? undefined
			: classification?.visualId;
	}
	const visualId = readVisualMarker(text).visualId;
	const duplicate = texts
		.slice(0, ordinal)
		.some((earlier) => readVisualMarker(earlier).visualId === visualId);
	return visualId && !duplicate ? visualId : undefined;
}

/**
 * A generated diagram's origin, from its current position among the
 * document's diagrams: re-read on every document change, since a diagram
 * inserted or deleted above moves this one without re-rendering it. Null
 * while the summaries load, when their read failed, or when the diagram is
 * not generated.
 */
export function useDiagramOrigin(
	editor: DiagramIndexEditor,
	getPos: () => number | undefined,
	specs: readonly VisualSpecSummary[] | undefined,
): VisualOrigin | null {
	const subscribe = useCallback(
		(onChange: () => void) => {
			editor.on("update", onChange);
			return () => {
				editor.off("update", onChange);
			};
		},
		[editor],
	);
	const read = (): VisualOrigin | null => {
		const pos = getPos();
		if (!specs || pos === undefined) {
			return null;
		}
		const doc = editor.state.doc;
		const ordinal = diagramsOf(doc).positions.indexOf(pos);
		const classification =
			ordinal === -1 ? undefined : classificationsOf(doc, specs)[ordinal];
		return classification?.state === "generated"
			? (classification.origin ?? null)
			: null;
	};
	return useSyncExternalStore(subscribe, read, read);
}

/**
 * Classify the editor's diagrams, in document order, exactly as the server
 * classifies a saved body's diagram fences: each diagram becomes one
 * mermaid fence of a synthetic body, fenced longer than any backtick run it
 * holds.
 */
function classifyEditorDiagrams(
	texts: readonly string[],
	specs: readonly VisualSpecSummary[],
): VisualFenceClassification[] {
	const markdown = texts
		.map((text) => {
			const longestRun = Math.max(
				0,
				...(text.match(/`+/g) ?? []).map((run) => run.length),
			);
			const fence = "`".repeat(Math.max(3, longestRun + 1));
			return `${fence}mermaid\n${text}\n${fence}`;
		})
		.join("\n\n");
	return classifyVisualFences(markdown, specs);
}
