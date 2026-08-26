"use client";

import type { GraphNode } from "@repo/atlas/types";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { ChevronDownIcon, ListFilterIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import {
	type AtlasCategory,
	CATEGORY_DESC_KEY,
	CATEGORY_ORDER,
	CUSTOM_CATEGORY_COLOR_VAR,
	categoryColorVar,
	resolveNodeCategory,
} from "./atlas-categories";

/** One row of the colour key: a known preset, or a user-defined custom category. */
interface LegendEntry {
	/** Stable list key (preset key, or `custom:<value>`). */
	id: string;
	/** The matching preset, or null for a custom category. */
	known: AtlasCategory | null;
	/** Raw value — used as the label for custom categories. */
	value: string;
	/** Swatch colour token. */
	colorVar: string;
}

/**
 * One row of the "Connections" key: a relationship KIND present on the current
 * graph. The host (`AtlasGraph`) precomputes these — including the
 * localised label + the per-kind colour token — so the legend stays purely
 * presentational and host-agnostic (the System map could feed its own kinds the
 * same way).
 */
export interface LegendConnection {
	/** The edge kind enum (stable React key). */
	kind: string;
	/** Localised connection-kind label (e.g. "Depends on"). */
	label: string;
	/** Per-kind colour token (`edgeKindColorVar(kind)`). */
	colorVar: string;
}

/**
 * The on-map colour key. A small, solid panel docked to the top-left of the
 * canvas (NOT glassmorphism — a warm `bg-card/95` + border) that lists the
 * product categories actually present on the current graph, each as a coloured
 * dot + translated label. Mode-agnostic: it categorises whatever nodes are on
 * screen (business capabilities or technical modules), so the key never drifts
 * from what's drawn.
 *
 * Collapsible to keep the map clean: it opens as a labelled panel (default) and
 * collapses to a single icon button. Auto-collapses on small viewports. Renders
 * nothing when the graph is empty.
 */
interface AtlasGraphLegendProps {
	nodes: GraphNode[];
	/**
	 * The distinct connection KINDS present on the current graph (host-computed,
	 * already localised + coloured). When non-empty, a second "Connections"
	 * section lists them below the categories. Defaults to none, so hosts that
	 * don't colour edges by kind keep the categories-only legend.
	 */
	connections?: LegendConnection[];
}

export function AtlasGraphLegend({
	nodes,
	connections = [],
}: AtlasGraphLegendProps) {
	const t = useTranslations("projects.atlas.legend");
	const tCat = useTranslations("projects.atlas.category");
	const listId = useId();

	// Start collapsed on small screens so the legend never crowds a phone-sized
	// canvas; expanded everywhere else.
	const [collapsed, setCollapsed] = useState(() => {
		if (typeof window === "undefined") {
			return false;
		}
		return window.matchMedia("(max-width: 640px)").matches;
	});

	// Distinct EFFECTIVE categories present on the current graph: known presets in
	// canonical order first, then any user-defined custom categories (alphabetical).
	// So a node the user re-categorised contributes its own row + colour here.
	const categories = useMemo<LegendEntry[]>(() => {
		const knownPresent = new Set<AtlasCategory>();
		const customValues = new Set<string>();
		for (const node of nodes) {
			const resolved = resolveNodeCategory(node);
			if (resolved.known) {
				knownPresent.add(resolved.known);
			} else {
				customValues.add(resolved.value);
			}
		}
		const entries: LegendEntry[] = [];
		for (const category of CATEGORY_ORDER) {
			if (knownPresent.has(category)) {
				entries.push({
					id: category,
					known: category,
					value: category,
					colorVar: categoryColorVar(category),
				});
			}
		}
		for (const value of [...customValues].sort((a, b) =>
			a.localeCompare(b),
		)) {
			entries.push({
				id: `custom:${value}`,
				known: null,
				value,
				colorVar: CUSTOM_CATEGORY_COLOR_VAR,
			});
		}
		return entries;
	}, [nodes]);

	// Nothing to describe (e.g. an empty graph) — render no control at all.
	if (categories.length === 0) {
		return null;
	}

	if (collapsed) {
		return (
			<Button
				type="button"
				variant="outline"
				size="icon-sm"
				aria-label={t("expand")}
				aria-expanded={false}
				aria-controls={listId}
				onClick={() => setCollapsed(false)}
				className="absolute left-3 top-3 z-10 bg-card/95"
			>
				<ListFilterIcon aria-hidden="true" className="size-4" />
			</Button>
		);
	}

	return (
		<div className="absolute left-3 top-3 z-10 max-w-[14rem] rounded-xl border border-border/70 bg-card/95 p-2.5 shadow-sm">
			<button
				type="button"
				aria-expanded={true}
				aria-controls={listId}
				aria-label={t("collapse")}
				onClick={() => setCollapsed(true)}
				className="flex w-full items-center justify-between gap-2 rounded-md text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				{t("title")}
				<ChevronDownIcon aria-hidden="true" className="size-3.5" />
			</button>
			<ul id={listId} className="mt-2 flex flex-col gap-1.5">
				{categories.map((entry) => {
					const swatchAndLabel = (
						<>
							<span
								aria-hidden="true"
								className="size-2.5 shrink-0 rounded-full"
								style={{ background: entry.colorVar }}
							/>
							<span
								className={cn(
									"truncate",
									!entry.known && "capitalize",
								)}
							>
								{entry.known ? tCat(entry.known) : entry.value}
							</span>
						</>
					);
					// Known presets carry a one-line meaning, surfaced on hover /
					// focus. Custom (user-defined) categories have no canonical
					// meaning, so they render as a plain row.
					if (!entry.known) {
						return (
							<li
								key={entry.id}
								className="flex items-center gap-2 text-[12px] text-foreground"
							>
								{swatchAndLabel}
							</li>
						);
					}
					return (
						<li key={entry.id}>
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										className="flex w-full cursor-help items-center gap-2 rounded text-left text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									>
										{swatchAndLabel}
									</button>
								</TooltipTrigger>
								<TooltipContent
									side="right"
									align="start"
									className="max-w-[15rem]"
								>
									{tCat(CATEGORY_DESC_KEY[entry.known])}
								</TooltipContent>
							</Tooltip>
						</li>
					);
				})}
			</ul>

			{/* Second section: the connection KINDS drawn on the canvas, keyed by
			    the same per-kind colour the edges use. A short line swatch (vs the
			    category dot) reads as "this is an edge colour". Only rendered when
			    the graph actually has connections. */}
			{connections.length > 0 && (
				<>
					<p className="mt-3 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
						{t("connectionsTitle")}
					</p>
					<ul className="mt-2 flex flex-col gap-1.5">
						{connections.map((conn) => (
							<li
								key={conn.kind}
								className="flex items-center gap-2 text-[12px] text-foreground"
							>
								<span
									aria-hidden="true"
									className="h-0 w-4 shrink-0 rounded-full border-t-2"
									style={{ borderColor: conn.colorVar }}
								/>
								<span className="truncate">{conn.label}</span>
							</li>
						))}
					</ul>
				</>
			)}
		</div>
	);
}
