/**
 * Shared harness for the client-document Proposal diagram tests (Fizzy
 * #2946): the document editor's own extensions loaded through the real
 * markdown path, rendered with the React node view under the theme root and
 * the diagrams' context. Each test file mocks `next-intl` and the oRPC
 * client itself (mocks are hoisted per file).
 */

import type { ProposalThemePaint } from "@repo/utils/proposal-artifact/theme-tokens";
import { fromMarkdown } from "@saas/projects/lib/diff-utils";
import { MermaidVisualProvider } from "@saas/projects/lib/mermaid-visual-context";
import { createAdvancedExtensions } from "@saas/projects/lib/tiptap-extensions-advanced";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect } from "react";

// jsdom has no layout: ProseMirror measures a range when it scrolls the
// selection into view.
const emptyRect = () => new DOMRect(0, 0, 0, 0);
if (typeof Range !== "undefined") {
	Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
	Range.prototype.getBoundingClientRect ??= emptyRect;
}

export const VISUAL_ID = "k3v9q2m7x1a8c4d6";
export const MARKER = `%% fabric-visual: ${VISUAL_ID}`;

export function fence(lines: string[]): string {
	return ["```mermaid", ...lines, "```"].join("\n");
}

export const FLOWCHART_BODY = [
	MARKER,
	"flowchart LR",
	'  t0["Discovery"]',
	'  t1["Launch"]',
	"  t0 --> t1",
	"  class t0 surface",
	"  class t1 surface",
];

export const GANTT_BODY = [
	"gantt",
	"  title Plan",
	"  dateFormat YYYY-MM-DD",
	"  section Build",
	"  Design :a1, 2026-01-01, 10d",
];

export function newQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
}

export interface HarnessProps {
	markdown: string;
	/** Omitted: no diagrams context, as every other document. */
	visual?: {
		isMember?: boolean;
		paint?: ProposalThemePaint | null;
		flushSave?: () => Promise<boolean>;
	};
	editable?: boolean;
	themeRoot?: boolean;
	onEditor?: (editor: Editor) => void;
	queryClient?: QueryClient;
}

function EditorUnderTest({
	markdown,
	editable = true,
	onEditor,
}: Pick<HarnessProps, "markdown" | "editable" | "onEditor">) {
	const editor = useEditor({
		extensions: createAdvancedExtensions({
			projectId: null,
			documentId: null,
			statTiles: true,
		}),
		content: fromMarkdown(markdown),
		editable,
		immediatelyRender: true,
	});
	useEffect(() => {
		if (editor) {
			onEditor?.(editor);
		}
	}, [editor, onEditor]);
	return <EditorContent editor={editor} />;
}

export function DiagramHarness({
	markdown,
	visual,
	editable,
	themeRoot = true,
	onEditor,
	queryClient,
}: HarnessProps) {
	const client = queryClient ?? newQueryClient();
	const content = (
		<EditorUnderTest
			markdown={markdown}
			editable={editable}
			onEditor={onEditor}
		/>
	);
	return (
		<QueryClientProvider client={client}>
			<MermaidVisualProvider
				enabled={visual !== undefined}
				projectId="project-1"
				documentId="document-1"
				isMember={visual?.isMember ?? true}
				paint={visual?.paint ?? null}
				flushSave={visual?.flushSave ?? (() => Promise.resolve(true))}
			>
				{themeRoot ? (
					<div className="proposal-theme" data-proposal-theme="live">
						{content}
					</div>
				) : (
					content
				)}
			</MermaidVisualProvider>
		</QueryClientProvider>
	);
}
