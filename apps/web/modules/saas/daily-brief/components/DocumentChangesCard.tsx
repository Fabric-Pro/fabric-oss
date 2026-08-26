"use client";

/**
 * DocumentChangesCard — renders project-document change items for a Daily Brief.
 *
 * Items are grouped by document (one section per documentCuid) so that multiple
 * version events on the same doc collapse into a single header with the version
 * history beneath it. Within each group, versions are ordered newest-first.
 */

import type { DocumentChangeItem, PartialFailure } from "@repo/database";
import { FileTextIcon } from "lucide-react";
import { useMemo } from "react";
import { formatRelativeOccurredAt, occurredAtMs } from "./format";
import { SourceCard } from "./SourceCard";

const KIND_LABEL: Record<DocumentChangeItem["kind"], string> = {
	created: "Created",
	updated: "Updated",
	version_added: "New version",
};

interface DocumentGroup {
	documentCuid: string;
	title: string;
	documentType: string;
	versions: DocumentChangeItem[];
	latestOccurredAt: number;
}

function groupByDocument(items: DocumentChangeItem[]): DocumentGroup[] {
	const map = new Map<string, DocumentGroup>();
	for (const item of items) {
		let group = map.get(item.documentCuid);
		if (!group) {
			group = {
				documentCuid: item.documentCuid,
				title: item.title,
				documentType: item.documentType,
				versions: [],
				latestOccurredAt: 0,
			};
			map.set(item.documentCuid, group);
		}
		group.versions.push(item);
		const t = occurredAtMs(item);
		if (t > group.latestOccurredAt) {
			group.latestOccurredAt = t;
		}
	}

	for (const group of map.values()) {
		group.versions.sort((a, b) => {
			// Prefer ordering by version desc when both have one; fall back to time.
			if (a.version != null && b.version != null) {
				return b.version - a.version;
			}
			return occurredAtMs(b) - occurredAtMs(a);
		});
	}

	return [...map.values()].sort(
		(a, b) => b.latestOccurredAt - a.latestOccurredAt,
	);
}

export interface DocumentChangesCardProps {
	items: DocumentChangeItem[];
	partialFailure?: PartialFailure;
	emptyMessage?: string;
}

export function DocumentChangesCard({
	items,
	partialFailure,
	emptyMessage = "No document changes in this window.",
}: DocumentChangesCardProps) {
	const groups = useMemo(() => groupByDocument(items), [items]);

	return (
		<SourceCard
			title="Document changes"
			sourceLabel="Source — Documents"
			count={items.length}
			emptyMessage={emptyMessage}
			icon={<FileTextIcon className="size-4" />}
			partialFailure={partialFailure}
		>
			<ul className="divide-y divide-border">
				{groups.map((group) => (
					<li
						key={group.documentCuid}
						className="py-3 first:pt-0 last:pb-0"
					>
						<header className="flex items-center gap-2">
							<span className="inline-flex items-center rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
								{group.documentType}
							</span>
							<p className="min-w-0 flex-1 truncate font-sans text-sm font-medium text-foreground">
								{group.title}
							</p>
							<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
								{group.versions.length}{" "}
								{group.versions.length === 1
									? "change"
									: "changes"}
							</span>
						</header>

						<ol className="mt-2 space-y-1.5 border-l border-border/60 pl-3">
							{group.versions.map((version, index) => (
								<li
									key={`${group.documentCuid}-${version.version ?? "na"}-${index}`}
									className="text-xs"
								>
									<div className="flex items-center gap-2">
										{version.version != null ? (
											<span className="font-mono text-[11px] font-medium text-foreground">
												v{version.version}
											</span>
										) : null}
										<span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
											{KIND_LABEL[version.kind]}
										</span>
										<span className="text-[11px] text-muted-foreground">
											{formatRelativeOccurredAt(
												version.occurredAt,
											)}
										</span>
									</div>
									{version.changeDescription ? (
										<p className="mt-0.5 text-xs leading-5 text-muted-foreground">
											{version.changeDescription}
										</p>
									) : null}
								</li>
							))}
						</ol>
					</li>
				))}
			</ul>
		</SourceCard>
	);
}
