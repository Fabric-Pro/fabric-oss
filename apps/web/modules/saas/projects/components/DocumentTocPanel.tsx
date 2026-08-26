"use client";

import { ScrollArea } from "@ui/components/scroll-area";
import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import {
	buildDocumentTocTree,
	DOCUMENT_TOC_STORAGE_KEY,
	type DocumentTocItem,
	type DocumentTocTreeNode,
} from "../lib/document-toc";
import { DocumentTocSpine } from "./DocumentTocSpine";

/**
 * Narrowest viewport that still has room for the rail. Surfaces differ in how
 * much of the work area is already spoken for, so the host picks: the document
 * editor opens with the AI assistant closed, while the feature work item
 * workspace opens with it expanded and 28rem already gone.
 */
export type DocumentTocBreakpoint = "lg" | "xl";

/**
 * One class per breakpoint, not two: the spine is a flex child of the rail, so
 * hiding the rail hides the control with it. The old edge handle was
 * absolutely positioned and needed its own visibility class.
 */
const BREAKPOINT_CLASSES: Record<DocumentTocBreakpoint, string> = {
	lg: "hidden lg:flex",
	xl: "hidden xl:flex",
};

/** Spine (36) + list (220) = the 256px the rail has always occupied. */
const LIST_WIDTH_CLASS = "w-[220px]";

interface DocumentTocPanelProps {
	items: DocumentTocItem[];
	onNavigate: (item: DocumentTocItem) => void;
	breakpoint?: DocumentTocBreakpoint;
	className?: string;
}

function TocEntries({
	nodes,
	onNavigate,
	untitledLabel,
}: {
	nodes: DocumentTocTreeNode[];
	onNavigate: (item: DocumentTocItem) => void;
	untitledLabel: string;
}) {
	return (
		<ul className="space-y-0.5">
			{nodes.map(({ item, children }) => {
				const label = item.text || untitledLabel;
				return (
					<li key={item.id}>
						<button
							type="button"
							title={label}
							onClick={() => onNavigate(item)}
							className="block w-full truncate rounded-md py-1.5 pr-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							// Indent by heading level rather than by nesting
							// depth, so a document that skips a level (H1 → H3)
							// still reads at its true depth.
							style={{
								paddingInlineStart: 8 + (item.level - 1) * 12,
							}}
						>
							{label}
						</button>
						{children.length > 0 && (
							<TocEntries
								nodes={children}
								onNavigate={onNavigate}
								untitledLabel={untitledLabel}
							/>
						)}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * Collapsible table-of-contents rail nested inside the document work area.
 *
 * Collapsed by default; the expanded/collapsed choice persists per browser
 * under a single shared key. When the document has no headings the panel
 * renders nothing at all — no spine, no list, no empty state — so a
 * heading-less document keeps its full width.
 *
 * Collapsed does NOT mean zero width: the rail keeps its 36px spine
 * (`DocumentTocSpine`), which names what it holds and is the toggle. The
 * previous edge-pill affordance said only "something opens here", and at
 * 12x32 it also missed the 24x24 target-size floor (WCAG 2.2 SC 2.5.8).
 *
 * Gated at `lg` by default rather than `md`: the work area already gives up
 * 72px to the app rail and 28rem to the AI assistant when it is open, so
 * surfacing a further 256px rail at 768px would leave the document almost no
 * width. A host whose assistant starts expanded should pass `xl`.
 */
export function DocumentTocPanel({
	items,
	onNavigate,
	breakpoint = "lg",
	className,
}: DocumentTocPanelProps) {
	const t = useTranslations("projects.documentToc");
	const [isExpanded, setIsExpanded] = useState(false);
	const listId = useId();

	// Reconcile from storage after mount: server render and first client
	// render both produce the collapsed default, avoiding a hydration
	// mismatch (same pattern as SettingsSidebarLayout / useDiffViewMode).
	useEffect(() => {
		try {
			const stored = localStorage.getItem(DOCUMENT_TOC_STORAGE_KEY);
			if (stored !== null) {
				setIsExpanded(JSON.parse(stored) === true);
			}
		} catch {
			// ignore persisted state failures
		}
	}, []);

	const toggleExpanded = () => {
		setIsExpanded((prev) => {
			const next = !prev;
			try {
				localStorage.setItem(
					DOCUMENT_TOC_STORAGE_KEY,
					JSON.stringify(next),
				);
			} catch {
				// ignore persisted state failures
			}
			return next;
		});
	};

	if (items.length === 0) {
		return null;
	}

	return (
		<div
			className={cn(
				"h-full shrink-0",
				BREAKPOINT_CLASSES[breakpoint],
				className,
			)}
		>
			<DocumentTocSpine
				isExpanded={isExpanded}
				onToggle={toggleExpanded}
				controlsId={listId}
				label={t("title")}
				expandLabel={t("expand")}
				collapseLabel={t("collapse")}
			/>
			<div
				aria-hidden={!isExpanded}
				inert={!isExpanded}
				className={cn(
					"overflow-hidden bg-background motion-safe:transition-[width] motion-safe:duration-200",
					isExpanded
						? cn(LIST_WIDTH_CLASS, "border-border border-r")
						: "w-0",
				)}
			>
				{/* Fixed inner width so the list doesn't reflow mid-animation.
				    No heading row: the spine's vertical caption already names
				    the rail, and repeating it here read as two labels for one
				    thing. */}
				<nav
					id={listId}
					aria-label={t("ariaLabel")}
					className={cn("flex h-full flex-col", LIST_WIDTH_CLASS)}
				>
					{/* Radix wraps the viewport's content in a `display: table`
					    div, which shrink-wraps to its widest child — a long
					    heading would then stretch past the rail instead of
					    truncating. Forcing that wrapper to a block makes it
					    take the viewport width so `truncate` has something to
					    truncate against. */}
					<ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
						<div className="px-2 py-3.5">
							<TocEntries
								nodes={buildDocumentTocTree(items)}
								onNavigate={onNavigate}
								untitledLabel={t("untitled")}
							/>
						</div>
					</ScrollArea>
				</nav>
			</div>
		</div>
	);
}
