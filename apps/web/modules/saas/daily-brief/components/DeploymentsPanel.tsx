"use client";

/**
 * DeploymentsPanel — renders published GitHub Releases (the brief's
 * `sections.deployments`) as a "Deployments" section. Distinct from the
 * PR-derived ReleaseNotesPanel. Items arrive newest-first from the collector.
 *
 * Hide-when-empty: renders nothing when there are no releases AND no failure.
 * On a partial failure it shows a non-alarming fallback banner (FR-5) and still
 * lists any releases that were fetched.
 */

import type { DeploymentItem } from "@repo/database";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { ChevronRightIcon, RocketIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatRelativeOccurredAt } from "./format";

export interface DeploymentsPanelProps {
	deployments: DeploymentItem[] | undefined;
	/** Set when deployment collection failed/truncated — shows a fallback banner. */
	error?: string;
}

function sanitizeReason(raw: string): string {
	const oneLine = raw.replace(/\s+/g, " ").trim();
	const capped = oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
	return `Note: ${capped}`;
}

export function DeploymentsPanel({
	deployments,
	error,
}: DeploymentsPanelProps) {
	const items = deployments ?? [];
	if (items.length === 0 && !error) {
		return null;
	}

	return (
		<section
			aria-label="Deployments"
			className="rounded-2xl border border-border bg-card p-6"
		>
			<header className="flex items-center gap-2">
				<RocketIcon
					className="size-4 text-muted-foreground"
					aria-hidden="true"
				/>
				<span className="editorial-label">Deployments</span>
			</header>

			{error ? (
				<p className="mt-4 rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
					{sanitizeReason(error)}
				</p>
			) : null}

			{items.length > 0 ? (
				<ul className="mt-5 space-y-4">
					{items.map((item) => (
						<DeploymentRow
							key={`${item.repoFullName}-${item.tagName}`}
							item={item}
						/>
					))}
				</ul>
			) : null}
		</section>
	);
}

function DeploymentRow({ item }: { item: DeploymentItem }) {
	return (
		<li className="rounded-md border border-border/70 bg-muted/30 p-4">
			<header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="inline-flex items-center rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
						{item.tagName}
					</span>
					<a
						href={item.url}
						target="_blank"
						rel="noreferrer noopener"
						className="min-w-0 truncate font-sans text-sm font-medium text-foreground hover:text-primary hover:underline"
					>
						{item.title}
					</a>
				</div>
				<span className="text-[11px] text-muted-foreground">
					{item.repoFullName}
					{item.author ? ` · ${item.author}` : ""} ·{" "}
					{formatRelativeOccurredAt(item.occurredAt)}
				</span>
			</header>

			<div className="mt-2">
				{item.body ? (
					<Collapsible className="group/collapsible">
						<CollapsibleTrigger className="flex items-center gap-1.5 rounded text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
							<ChevronRightIcon
								aria-hidden="true"
								className="size-3 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90"
							/>
							Release notes
						</CollapsibleTrigger>
						<CollapsibleContent>
							<div className="prose prose-sm mt-2 max-w-none text-foreground/90 prose-headings:text-foreground prose-a:text-primary">
								<ReactMarkdown remarkPlugins={[remarkGfm]}>
									{item.body}
								</ReactMarkdown>
							</div>
						</CollapsibleContent>
					</Collapsible>
				) : (
					<p className="text-xs italic text-muted-foreground">
						No release notes provided.
					</p>
				)}
			</div>
		</li>
	);
}
