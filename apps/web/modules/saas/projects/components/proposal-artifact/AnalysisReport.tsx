"use client";

import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { ChevronRightIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	Component,
	type ReactNode,
	type RefObject,
	useId,
	useMemo,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { EvidenceChip } from "./FindingEvidence";
import { remarkReportCitations } from "./report-citations-remark";
import type {
	ProposalAnalysis,
	ProposalAnalysisEvidence,
} from "./use-proposal-analysis";

/** The report of the shown run, as `getAnalysis` returns it. */
export type ProposalAnalysisReport = NonNullable<ProposalAnalysis["report"]>;
type ReportCitation = ProposalAnalysisReport["citations"][number];

/**
 * The elements the report's Markdown may produce. Anything else is replaced
 * by its children (`unwrapDisallowed`): a link reads as its text, and an
 * image, which has none, is dropped. `span` is the citation element the
 * remark plugin adds; raw HTML never reaches this list, since `skipHtml`
 * drops it first.
 */
const REPORT_ELEMENTS = [
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"ul",
	"ol",
	"li",
	"em",
	"strong",
	"del",
	"code",
	"pre",
	"blockquote",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
	"hr",
	"br",
	"span",
];

/** No URL survives: the report links to nothing and loads nothing. */
function noUrl(): string {
	return "";
}

/**
 * The report of the analysis run the Internal Analysis tab shows
 * (Fizzy #2946): its assessment, summary and before-sending list at once,
 * and its full text on demand, inline under "Full report".
 *
 * Renders nothing when the report is missing or has nothing to show. The
 * assessment, summary and list are model output rendered as plain text. The
 * full text is the tab's one Markdown surface, rendered without HTML:
 *
 *  - raw HTML is dropped and only an allowlist of elements renders; a link
 *    reads as its text, an image is dropped, and no URL survives;
 *  - headings render one level below the "Full report" trigger, and code
 *    blocks render as plain code, never as diagrams;
 *  - `[S<N>]` in the text becomes a source chip only for a number the server
 *    resolved, through the same chips as the findings' evidence;
 *  - it mounts only while open, and its parse is memoised, so typing an
 *    answer or a poll that brings the same report does not parse it again;
 *  - a report stored as plain text (`plainText`) or one whose rendering
 *    fails shows as escaped text under a note.
 *
 * The open state belongs to the caller, so it outlives polls and remounts.
 */
export function AnalysisReport({
	report,
	open,
	onOpenChange,
	regionRef,
}: {
	report: ProposalAnalysisReport | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The report's root, for the caller to place focus within it. */
	regionRef?: RefObject<HTMLElement | null>;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis.report");
	const headingId = useId();
	const text = report?.text?.trim() ? report.text : null;
	const citations = report?.citations;
	// The server's list may arrive as a new array on a read; its content, not
	// the array, decides whether the text must be parsed again, so the memo
	// is keyed on `citationsKey` and reads `citations` of that content.
	const citationsKey = useMemo(
		() => JSON.stringify(citations ?? []),
		[citations],
	);
	const markdown = useMemo(
		() =>
			text === null ? null : (
				<ReportMarkdown text={text} citations={citations ?? []} />
			),
		[text, citationsKey],
	);

	if (!report) {
		return null;
	}
	const assessment = report.assessment.trim();
	const summary = report.summary.trim() ? report.summary : "";
	const beforeSending = report.beforeSending.filter((item) => item.trim());
	if (!assessment && !summary && beforeSending.length === 0 && !text) {
		return null;
	}

	return (
		<section
			ref={regionRef}
			aria-labelledby={headingId}
			className="space-y-2 rounded-lg border border-border p-3"
		>
			<h3
				id={headingId}
				// Focusable by script only: where focus lands after a re-run
				// leaves no "Full report" to take it.
				tabIndex={-1}
				className="font-medium text-base"
			>
				{t("title")}
			</h3>
			{assessment ? (
				<p className="break-words font-medium text-sm">{assessment}</p>
			) : null}
			{summary ? (
				<p className="whitespace-pre-line break-words text-sm leading-relaxed">
					{summary}
				</p>
			) : null}
			{beforeSending.length > 0 ? (
				<div className="space-y-1">
					<h4 className="font-medium text-sm">
						{t("beforeSending")}
					</h4>
					<ul className="list-disc space-y-1 pl-5 text-sm">
						{beforeSending.map((item, index) => (
							<li
								// The same line may appear twice; the position
								// keeps each apart.
								key={`${index}-${item}`}
								className="whitespace-pre-line break-words"
							>
								{item}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{text ? (
				<Collapsible
					open={open}
					onOpenChange={onOpenChange}
					className="space-y-2"
				>
					<h4 className="font-medium text-sm">
						<CollapsibleTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="[&[data-state=open]>svg]:rotate-90"
							>
								<ChevronRightIcon aria-hidden="true" />
								{t("fullReport")}
								{report.textTruncated ? (
									<>
										{" "}
										<span className="text-muted-foreground">
											{t("shortened")}
										</span>
									</>
								) : null}
							</Button>
						</CollapsibleTrigger>
					</h4>
					<CollapsibleContent>
						{report.plainText ? (
							<PlainTextReport text={text} />
						) : (
							<ReportRenderBoundary
								text={text}
								fallback={<PlainTextReport text={text} />}
							>
								{markdown}
							</ReportRenderBoundary>
						)}
					</CollapsibleContent>
				</Collapsible>
			) : null}
		</section>
	);
}

/** The full text as escaped plain text, under a note saying why. */
function PlainTextReport({ text }: { text: string }) {
	const t = useTranslations("projects.proposalArtifact.analysis.report");
	return (
		<div className="space-y-2">
			<p className="text-muted-foreground text-xs">
				{t("plainTextNote")}
			</p>
			<p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
				{text}
			</p>
		</div>
	);
}

/**
 * Shows `fallback` instead of the Markdown once rendering it throws, so a
 * report the renderer cannot handle never takes the findings with it. A
 * different text tries again.
 */
class ReportRenderBoundary extends Component<
	{ text: string; fallback: ReactNode; children: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidUpdate(previous: { text: string }) {
		if (this.state.failed && previous.text !== this.props.text) {
			this.setState({ failed: false });
		}
	}

	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

/** The full text as Markdown, with the server's citations as chips. */
function ReportMarkdown({
	text,
	citations,
}: {
	text: string;
	citations: readonly ReportCitation[];
}) {
	const bySource = new Map<number, ProposalAnalysisEvidence>(
		citations.map((citation) => [citation.source, citation.evidence]),
	);

	return (
		<div className="prose prose-sm dark:prose-invert max-w-none break-words">
			<ReactMarkdown
				remarkPlugins={[
					remarkGfm,
					[
						remarkReportCitations,
						{ sources: new Set(bySource.keys()) },
					],
				]}
				skipHtml
				allowedElements={REPORT_ELEMENTS}
				unwrapDisallowed
				urlTransform={noUrl}
				components={reportComponents(bySource)}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}

function reportComponents(
	bySource: ReadonlyMap<number, ProposalAnalysisEvidence>,
): Components {
	// One level below the "Full report" trigger, whatever level the text
	// asked for.
	const heading: Components["h1"] = ({ children }) => (
		<h5 className="font-semibold">{children}</h5>
	);
	return {
		h1: heading,
		h2: heading,
		h3: heading,
		h4: heading,
		h5: heading,
		h6: heading,
		// Never reached while `a` is outside the allowlist; a link reads as
		// its text either way.
		a: ({ children }) => <>{children}</>,
		pre: ({ children }) => (
			<div className="overflow-x-auto">
				<pre>{children}</pre>
			</div>
		),
		table: ({ children }) => (
			<div className="overflow-x-auto">
				<table>{children}</table>
			</div>
		),
		span: ({ node, children }) => {
			const source = Number(node?.properties?.dataCitation);
			const evidence = bySource.get(source);
			if (!evidence) {
				return <span>{children}</span>;
			}
			return (
				<ReportCitationChip
					source={source}
					evidence={evidence}
					first={node?.properties?.dataFirst === "true"}
				/>
			);
		},
	};
}

function ReportCitationChip({
	source,
	evidence,
	first,
}: {
	source: number;
	evidence: ProposalAnalysisEvidence;
	first: boolean;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis.report");
	return (
		<span
			data-slot="report-citation"
			className="not-prose mx-0.5 inline-flex items-baseline gap-1 align-baseline"
		>
			<EvidenceChip
				evidence={evidence}
				citation={{
					label: t("citationLabel", { source: String(source) }),
					showTitle: first,
				}}
			/>
		</span>
	);
}
