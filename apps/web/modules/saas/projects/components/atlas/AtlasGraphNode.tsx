"use client";

import type { GraphNodeMetrics, AtlasNodeKind } from "@repo/atlas/types";
import { cn } from "@ui/lib";
/**
 * Custom React Flow node for the Atlas graph. A compact card: a colour-chip
 * (the category glyph, tinted by the node's category accent) sits left of the
 * label + a single short metrics line (`language · N files · M links`).
 *
 * Colour now carries CATEGORY, not kind/language — every node resolves through
 * `categorizeNode` → `categoryColorVar`, an `--atlas-cat-*` design token, so the
 * card themes correctly in light and dark and never hardcodes a hex value. The
 * accent is also exposed as the `--node-accent` custom property so the resting /
 * hover border can pick it up.
 *
 * Selected nodes gain an accent ring + soft glow, matched (search) nodes an
 * accent ring, and dimmed nodes (search non-match, or outside the hovered/
 * selected neighbourhood) fade back — mirroring the states the canvas drives.
 */
import { Handle, Position } from "@xyflow/react";
import { type CSSProperties, memo } from "react";
import { resolveNodeCategory } from "./atlas-categories";

export interface AtlasNodeData {
	label: string;
	kind: AtlasNodeKind;
	language: string | null;
	filePath: string | null;
	description: string | null;
	/**
	 * Effective persisted category (user override or AI value), or null to fall
	 * back to keyword categorisation. Drives the colour-chip across the graph.
	 */
	category: string | null;
	metrics: GraphNodeMetrics | null;
	/** Total incident edges (in + out) — shown as "M links". */
	connectionCount: number;
	selected: boolean;
	dimmed: boolean;
	matched: boolean;
	[key: string]: unknown;
}

function AtlasGraphNodeImpl({ data }: { data: AtlasNodeData }) {
	// Colour + glyph carry the node's EFFECTIVE category (a user override wins;
	// otherwise the AI value, then keyword fallback). A custom category reads with
	// a neutral token + tag glyph.
	const { colorVar: accent, Icon } = resolveNodeCategory(data);

	const fileCount = data.metrics?.fileCount;

	// Selected / matched paint the border with the accent (selected also gets a
	// soft glow ring). The resting + hover border live in classes so a hover can
	// win over the resting colour; the accent is exposed via `--node-accent`.
	const accentBorder = data.selected || data.matched;

	return (
		<div
			className={cn(
				"group relative flex items-start gap-2.5 rounded-xl border bg-card px-2.5 py-2 text-left shadow-sm motion-safe:transition-[border-color,box-shadow,opacity]",
				data.dimmed ? "opacity-35" : "opacity-100",
				accentBorder
					? "border-[color:var(--node-accent)]"
					: "border-border hover:border-[color:var(--node-accent)] hover:shadow-md",
			)}
			style={
				{
					width: 196,
					"--node-accent": accent,
					boxShadow: data.selected
						? `0 0 0 1.5px ${accent}, 0 10px 30px color-mix(in srgb, ${accent} 26%, transparent)`
						: data.matched
							? `0 0 0 2px ${accent}`
							: undefined,
				} as CSSProperties
			}
		>
			<Handle
				type="target"
				position={Position.Top}
				className="!size-1.5 !border-0"
				style={{ background: "var(--muted-foreground)" }}
			/>
			{/* Category colour chip — the only place colour carries meaning. */}
			<span
				aria-hidden="true"
				className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg border"
				style={{
					color: accent,
					background: `color-mix(in srgb, ${accent} 16%, transparent)`,
					borderColor: `color-mix(in srgb, ${accent} 28%, transparent)`,
				}}
			>
				<Icon aria-hidden="true" className="size-3.5" />
			</span>
			<div className="min-w-0 flex-1">
				<p className="line-clamp-2 font-medium text-foreground text-[13px] leading-snug">
					{data.label}
				</p>
				<div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground tabular-nums">
					{data.language && (
						<span className="uppercase tracking-[0.08em]">
							{data.language}
						</span>
					)}
					{typeof fileCount === "number" && fileCount > 0 && (
						<>
							{data.language && <span aria-hidden="true">·</span>}
							<span>{fileCount} files</span>
						</>
					)}
					{data.connectionCount > 0 && (
						<>
							{(data.language ||
								(typeof fileCount === "number" &&
									fileCount > 0)) && (
								<span aria-hidden="true">·</span>
							)}
							<span>{data.connectionCount} links</span>
						</>
					)}
				</div>
			</div>
			<Handle
				type="source"
				position={Position.Bottom}
				className="!size-1.5 !border-0"
				style={{ background: "var(--muted-foreground)" }}
			/>
		</div>
	);
}

export const AtlasGraphNode = memo(AtlasGraphNodeImpl);
