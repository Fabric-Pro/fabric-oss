"use client";

/**
 * TipTap node for a Proposal's cover details (Fizzy #2946): the eyebrow,
 * the line under the logos, who the Proposal is prepared for and by, and its
 * version.
 *
 * The markdown form is a fenced block in the preamble, owned by
 * `@repo/utils/proposal-artifact/cover-fence`:
 *
 *   ```cover
 *   eyebrow: Proposal · Operations board
 *   for: Example Harbor Co
 *   by: Example Delivery Team
 *   version: 12
 *   ```
 *
 * The print and Word covers read the fence and their bodies never print it,
 * so the editor has no page form to draw: it shows the fields as a compact
 * summary card, with the source one toggle away. The node and its view are
 * the shared content fence shell in `tiptap-fenced-block-view.tsx`, as the
 * stat tiles node is, which keeps the round trip byte for byte and claims
 * the fence ahead of the mermaid sniff.
 *
 * ## Opt-in
 *
 * The node rides the stat tiles opt-in (`statTiles: true` on the shared
 * extension builders): only the project document editor of a client
 * Proposal and the Proposal live pane register it. Every other editor keeps
 * the fence as an ordinary code block of its language, through the code
 * block's guard rule, so saving never rewrites it as a diagram. The guard
 * matches the language in any case and this node only in lower case, so a
 * ```` ```Cover ```` fence that reaches the editor with its case kept stays
 * a code block of its own language in every editor.
 *
 * ## Labels
 *
 * Each field is labelled with its key as written in the fence (`for`,
 * `by`…), set in mono: the card summarises the source, it does not stand in
 * for the cover. Values render as React text, so markup typed into one
 * stays text.
 */

import {
	COVER_LANGUAGE,
	type CoverDetails,
	parseCover,
} from "@repo/utils/proposal-artifact/cover-fence";
import type { ReactNodeViewProps } from "@tiptap/react";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import {
	type FencedBlockReading,
	FencedBlockView,
	fencedBlockNode,
} from "./tiptap-fenced-block-view";

export const COVER_NODE_NAME = "coverBlock";

/** One field of the summary: its fence key and its lines. */
interface CoverField {
	key: string;
	values: readonly string[];
}

/** The fields a block sets, in the order the cover shows them. */
function coverFields(details: CoverDetails): CoverField[] {
	const fields: CoverField[] = [
		{ key: "eyebrow", values: details.eyebrow ? [details.eyebrow] : [] },
		{
			key: "organization",
			values: details.organization ? [details.organization] : [],
		},
		{ key: "for", values: details.forLines },
		{ key: "by", values: details.byLines },
		{ key: "version", values: details.version ? [details.version] : [] },
	];
	return fields.filter((field) => field.values.length > 0);
}

function CoverSummary({
	details,
	visualId,
}: {
	details: CoverDetails;
	visualId: string | null;
}) {
	return (
		<dl
			contentEditable={false}
			className="not-prose my-4 flex flex-col gap-1.5 rounded-lg border p-4 text-sm"
			data-visual-id={visualId ?? undefined}
		>
			{coverFields(details).map((field) => (
				<div
					key={field.key}
					className="grid grid-cols-[6rem_1fr] gap-x-3"
				>
					{/* As written in the fence, where a key in another case is refused. */}
					<dt className="font-mono text-muted-foreground text-xs leading-5">
						{field.key}
					</dt>
					{field.values.map((value, index) => (
						<dd
							// A line has no identity beyond its place in the
							// field.
							key={index}
							className={cn(
								"m-0 break-words",
								index > 0 && "col-start-2",
							)}
						>
							{value}
						</dd>
					))}
				</div>
			))}
		</dl>
	);
}

function readCover(body: string): FencedBlockReading {
	const parsed = parseCover(body);
	if (!parsed.ok) {
		return parsed;
	}
	return {
		ok: true,
		drawing: <CoverSummary details={parsed} visualId={parsed.visualId} />,
	};
}

function CoverNodeView(props: ReactNodeViewProps) {
	const tEditorTooltips = useTranslations("tooltips.editor");
	const body = props.node.textContent;
	const reading = useMemo(() => readCover(body), [body]);
	return (
		<FencedBlockView
			{...props}
			reading={reading}
			toggleLabel={tEditorTooltips("editBlockSource")}
			wrapperAttributes={{ "data-proposal-block": COVER_LANGUAGE }}
		/>
	);
}

export const CoverBlock = fencedBlockNode({
	name: COVER_NODE_NAME,
	language: COVER_LANGUAGE,
	view: CoverNodeView,
});
