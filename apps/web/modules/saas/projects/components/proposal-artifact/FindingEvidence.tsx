"use client";

import { Badge } from "@ui/components/badge";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { ExternalLinkIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ProposalAnalysisEvidence } from "./use-proposal-analysis";

type ReadableEvidence = Exclude<ProposalAnalysisEvidence, { kind: "removed" }>;

/**
 * The sources one analysis finding cites (Fizzy #2946), as chips under the
 * finding.
 *
 *  - a LINK or MEETING_TRANSCRIPT project context opens its in-app page in a
 *    new tab, saying so to sight and to screen readers;
 *  - another project context or a company source with text opens a popover
 *    with its title and an excerpt of the text it holds now — never the text
 *    the analysis read, which may since have been removed;
 *  - a source with no text to show (the project summary, other material, a
 *    source with no text yet) is a plain chip with its title;
 *  - a source that no longer resolves says "Source removed" and offers
 *    nothing else, since the server returns nothing else for it.
 *
 * Internal review material: this renders only inside the Internal Analysis
 * tab, never in the Main Document, and it never shows the `[S#]` numbers the
 * analysis used — a chip is named by its source. Titles and excerpts are
 * text from sources and render escaped.
 */
export function FindingEvidence({
	evidence,
}: {
	evidence: readonly ProposalAnalysisEvidence[];
}) {
	const t = useTranslations("projects.proposalArtifact.analysis.evidence");
	if (evidence.length === 0) {
		return null;
	}

	return (
		<div className="mt-2 flex flex-wrap items-center gap-1.5">
			<span className="text-muted-foreground text-xs">{t("label")}</span>
			<ul className="flex flex-wrap items-center gap-1.5">
				{evidence.map((item, index) => (
					<li
						// The same source may be cited twice; the position keeps
						// each chip apart.
						key={`${item.kind}-${item.source}-${index}`}
						className="flex"
					>
						<EvidenceChip evidence={item} />
					</li>
				))}
			</ul>
		</div>
	);
}

function EvidenceChip({ evidence }: { evidence: ProposalAnalysisEvidence }) {
	const t = useTranslations("projects.proposalArtifact.analysis.evidence");

	if (evidence.kind === "removed") {
		return <Badge variant="outline">{t("removed")}</Badge>;
	}

	const title = evidenceTitle(evidence, t);
	const excerpt = "excerpt" in evidence ? evidence.excerpt : null;

	if (evidence.kind === "projectContext" && evidence.link) {
		return (
			<Badge variant="outline" asChild>
				<a
					href={evidence.link.href}
					target="_blank"
					rel="noopener noreferrer"
				>
					{title}
					<ExternalLinkIcon aria-hidden="true" />
					<span className="sr-only">{t("opensInNewTab")}</span>
				</a>
			</Badge>
		);
	}

	if (!excerpt) {
		return <Badge variant="outline">{title}</Badge>;
	}

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Badge variant="outline" asChild>
					<button
						type="button"
						aria-label={t("viewSource", { title })}
					>
						{title}
					</button>
				</Badge>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-80 max-w-[min(90vw,20rem)] space-y-2 text-sm"
			>
				<p className="font-medium text-foreground">{title}</p>
				<p className="text-muted-foreground text-xs">
					{t(`kind.${evidence.kind}`)}
				</p>
				<p className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-muted-foreground text-xs">
					{excerpt}
				</p>
			</PopoverContent>
		</Popover>
	);
}

/** The source's own title, else the name of its kind. */
function evidenceTitle(
	evidence: ReadableEvidence,
	t: ReturnType<typeof useTranslations>,
): string {
	const title = evidence.title?.trim();
	return title ? title : t(`kind.${evidence.kind}`);
}
