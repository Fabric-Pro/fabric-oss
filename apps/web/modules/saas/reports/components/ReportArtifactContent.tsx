"use client";

import { resolveReportSourceLink } from "@saas/reports/lib/report-source-link";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Whether a report artifact is a whole HTML document rather than Markdown. */
function isHtmlReportArtifact(name: string, content: string): boolean {
	const lowerName = name.toLowerCase();
	const start = content.trim();
	return (
		lowerName.endsWith(".html") ||
		lowerName.endsWith(".htm") ||
		start.startsWith("<!DOCTYPE") ||
		start.startsWith("<html")
	);
}

/**
 * Headings of a report shown inside another section (a template's preview):
 * they sit under that section's own heading, so they start at h4 and stay
 * small enough not to outrank it.
 */
const EMBEDDED_HEADINGS = {
	h1: ({ children }: { children?: ReactNode }) => (
		<h4 className="text-base font-semibold mt-4 mb-2">{children}</h4>
	),
	h2: ({ children }: { children?: ReactNode }) => (
		<h5 className="text-sm font-semibold mt-3 mb-2">{children}</h5>
	),
	h3: ({ children }: { children?: ReactNode }) => (
		<h6 className="text-sm font-medium mt-3 mb-1">{children}</h6>
	),
};

/**
 * A generated report's content as the report page shows it: an HTML document
 * in a sandboxed frame, anything else as Markdown with project citations
 * resolved against the current organization. `embedded` is for a report shown
 * inside another section, with its headings demoted and a bounded frame.
 */
export function ReportArtifactContent({
	name,
	content,
	projectSourcePath,
	embedded = false,
}: {
	name: string;
	content: string;
	/** The organization's projects route, for `projects/…` citations. */
	projectSourcePath: string;
	embedded?: boolean;
}) {
	if (isHtmlReportArtifact(name, content)) {
		return (
			<iframe
				srcDoc={content}
				className={
					embedded
						? "w-full h-80 border-0"
						: "w-full h-full min-h-[500px] border-0"
				}
				title={name}
				sandbox="allow-same-origin"
			/>
		);
	}
	return (
		<div
			className={
				embedded
					? "p-4 prose prose-sm dark:prose-invert max-w-none"
					: "p-6 prose prose-sm dark:prose-invert max-w-none"
			}
		>
			<Markdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ href, children }) => (
						<a
							className="text-primary-ink underline underline-offset-4"
							href={resolveReportSourceLink(
								href,
								projectSourcePath,
							)}
						>
							{children}
						</a>
					),
					h1: ({ children }) => (
						<h1 className="text-2xl font-bold mt-6 mb-4 pb-2 border-b">
							{children}
						</h1>
					),
					h2: ({ children }) => (
						<h2 className="text-xl font-semibold mt-5 mb-3">
							{children}
						</h2>
					),
					h3: ({ children }) => (
						<h3 className="text-lg font-medium mt-4 mb-2">
							{children}
						</h3>
					),
					p: ({ children }) => (
						<p className="mb-3 leading-relaxed">{children}</p>
					),
					ul: ({ children }) => (
						<ul className="list-disc pl-6 mb-3 space-y-1">
							{children}
						</ul>
					),
					ol: ({ children }) => (
						<ol className="list-decimal pl-6 mb-3 space-y-1">
							{children}
						</ol>
					),
					li: ({ children }) => (
						<li className="leading-relaxed">{children}</li>
					),
					blockquote: ({ children }) => (
						// A report's blockquote is a callout: `not-prose` stops
						// the typography plugin adding quotation marks.
						<blockquote className="not-prose border-l-4 border-muted-foreground/30 pl-4 italic text-muted-foreground my-4">
							{children}
						</blockquote>
					),
					code: ({ className, children }) => {
						const isInline = !className;
						if (isInline) {
							return (
								<code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono">
									{children}
								</code>
							);
						}
						return (
							<pre className="bg-muted p-4 rounded-lg overflow-x-auto my-4">
								<code className="text-sm font-mono">
									{children}
								</code>
							</pre>
						);
					},
					table: ({ children }) => (
						<div className="overflow-x-auto my-4">
							<table className="min-w-full border-collapse border border-border">
								{children}
							</table>
						</div>
					),
					thead: ({ children }) => (
						<thead className="bg-muted">{children}</thead>
					),
					th: ({ children }) => (
						<th className="border border-border px-3 py-2 text-left font-medium">
							{children}
						</th>
					),
					td: ({ children }) => (
						<td className="border border-border px-3 py-2">
							{children}
						</td>
					),
					hr: () => <hr className="my-6 border-border" />,
					strong: ({ children }) => (
						<strong className="font-semibold">{children}</strong>
					),
					...(embedded ? EMBEDDED_HEADINGS : {}),
				}}
			>
				{content}
			</Markdown>
		</div>
	);
}
