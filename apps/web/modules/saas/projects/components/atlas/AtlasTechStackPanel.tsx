"use client";

/**
 * Tech stack panel (AC#8 — Technical view + Overview dashboard).
 *
 * Renders the `status.techStack` entries as scannable, grouped sections —
 * Frameworks · Runtime & Language · AI SDKs · Data & Infra · Libraries. Each
 * row is an editorial "name · · · · version  [tag]" line with a dotted leader,
 * a monospace version, and a small uppercase tag chip whose colour maps to a
 * design-system token (no hardcoded hex — all colours resolve to CSS variables
 * via `color-mix`).
 *
 * Grouping is heuristic-by-name (the `TechStackEntry` shape has no group field):
 * well-known frameworks / runtimes / AI SDKs / data libraries are bucketed by
 * name, with the entry's `kind` as a fallback, and everything else lands in a
 * trailing "Libraries" group.
 *
 * Embedded mode (the Overview card) renders just the grouped list. Standalone
 * mode keeps the collapsible card chrome (title + explainer tooltip).
 */
import type { TechStackEntry } from "@repo/atlas/types";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@ui/components/accordion";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { ChevronDownIcon, ChevronRightIcon, InfoIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { ScrollFade } from "./ScrollFade";

interface AtlasTechStackPanelProps {
	techStack: TechStackEntry[];
	/**
	 * When true, render only the grouped list — no card chrome, header, or
	 * collapsible — for embedding inside another panel (the Overview dashboard).
	 */
	embedded?: boolean;
}

// ── Grouping ────────────────────────────────────────────────────────────────

type TechGroupId = "frameworks" | "runtime" | "ai" | "data" | "libraries";
type TechTag = "framework" | "runtime" | "language" | "ai" | "data" | "library";

/** Display order — value-bearing groups first, the catch-all last. */
const GROUP_ORDER: TechGroupId[] = [
	"frameworks",
	"runtime",
	"ai",
	"data",
	"libraries",
];

const GROUP_LABEL_KEY: Record<TechGroupId, string> = {
	frameworks: "groupFrameworks",
	runtime: "groupRuntime",
	ai: "groupAi",
	data: "groupData",
	libraries: "groupLibraries",
};

/**
 * Tag → design-token colour. Reuses the Atlas category palette + semantic
 * tokens so the chips theme correctly in light AND dark (no hardcoded hex):
 * framework→blue, runtime→emerald, language→purple, ai→teal, data→pink,
 * library→neutral.
 */
const TAG_COLOR_VAR: Record<TechTag, string> = {
	framework: "var(--atlas-cat-integration)",
	runtime: "var(--secondary)",
	language: "var(--atlas-cat-infra)",
	ai: "var(--atlas-cat-ai)",
	data: "var(--atlas-cat-data)",
	library: "var(--muted-foreground)",
};

const FRAMEWORK_NAMES = new Set([
	"next",
	"react",
	"react-dom",
	"hono",
	"tailwindcss",
	"vue",
	"svelte",
	"@angular/core",
	"solid-js",
	"preact",
	"express",
	"fastify",
	"koa",
	"@nestjs/core",
	"remix",
	"@remix-run/react",
	"nuxt",
	"astro",
	"gatsby",
	"vite",
	"qwik",
]);
const RUNTIME_NAMES = new Set(["node", "nodejs", "bun", "deno"]);
const LANGUAGE_NAMES = new Set(["typescript", "javascript"]);
const DATA_NAMES = new Set([
	"prisma",
	"zod",
	"drizzle-orm",
	"kysely",
	"pg",
	"postgres",
	"mongoose",
	"mongodb",
	"redis",
	"ioredis",
	"mysql2",
	"knex",
	"sequelize",
	"typeorm",
]);

/** Bucket a dependency into a display group + tag, heuristically by name. */
function classifyTech(entry: TechStackEntry): {
	group: TechGroupId;
	tag: TechTag;
} {
	const name = entry.name.toLowerCase();
	// AI SDKs first so `@ai-sdk/*` beats any generic framework match.
	if (
		name.startsWith("@ai-sdk/") ||
		name.startsWith("@ag-ui/") ||
		name.startsWith("@langchain/") ||
		name.startsWith("langchain") ||
		name.startsWith("@anthropic-ai/") ||
		name.startsWith("@google/genai") ||
		name.startsWith("@google/generative") ||
		name === "ai" ||
		name === "openai"
	) {
		return { group: "ai", tag: "ai" };
	}
	if (FRAMEWORK_NAMES.has(name)) {
		return { group: "frameworks", tag: "framework" };
	}
	if (LANGUAGE_NAMES.has(name)) {
		return { group: "runtime", tag: "language" };
	}
	if (RUNTIME_NAMES.has(name)) {
		return { group: "runtime", tag: "runtime" };
	}
	if (
		DATA_NAMES.has(name) ||
		name.startsWith("@tanstack/") ||
		name.startsWith("@prisma/")
	) {
		return { group: "data", tag: "data" };
	}
	// Fall back to the entry's declared kind before the catch-all.
	if (entry.kind === "framework") {
		return { group: "frameworks", tag: "framework" };
	}
	if (entry.kind === "runtime") {
		return { group: "runtime", tag: "runtime" };
	}
	return { group: "libraries", tag: "library" };
}

export function AtlasTechStackPanel({
	techStack,
	embedded = false,
}: AtlasTechStackPanelProps) {
	const t = useTranslations("projects.atlas.techStack");
	const [open, setOpen] = useState(true);

	const grouped = useMemo(() => {
		const map = new Map<
			TechGroupId,
			{ entry: TechStackEntry; tag: TechTag }[]
		>();
		for (const entry of techStack) {
			const { group, tag } = classifyTech(entry);
			const list = map.get(group) ?? [];
			list.push({ entry, tag });
			map.set(group, list);
		}
		// Alpha-sort within each group for stable, scannable ordering.
		for (const [group, rows] of map) {
			map.set(
				group,
				rows.sort((a, b) => a.entry.name.localeCompare(b.entry.name)),
			);
		}
		return GROUP_ORDER.filter((group) => map.has(group)).map((group) => ({
			group,
			rows: map.get(group) ?? [],
		}));
	}, [techStack]);

	if (techStack.length === 0) {
		return null;
	}

	// One dependency row — an editorial "name · · · · version  [tag]" line.
	// Shared by the standalone grouped list and the embedded accordion.
	const renderRow = ({
		entry,
		tag,
	}: {
		entry: TechStackEntry;
		tag: TechTag;
	}) => {
		const color = TAG_COLOR_VAR[tag];
		return (
			<li
				key={`${entry.ecosystem}-${entry.name}`}
				className="flex items-center gap-2.5 py-1"
			>
				<span
					// Native tooltip surfaces the full name when a long scoped
					// package is truncated. `min-w-0` lets the name shrink/
					// ellipsize so the version + tag always stay visible.
					title={entry.name}
					className="min-w-0 truncate text-[13px] font-medium text-foreground/90"
				>
					{entry.name}
				</span>
				<span
					aria-hidden="true"
					className="h-px min-w-[1.25rem] flex-1 border-b border-dotted border-border"
				/>
				{entry.version && (
					<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
						{entry.version}
					</span>
				)}
				<span
					className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]"
					style={{
						color,
						backgroundColor: `color-mix(in srgb, ${color} 13%, transparent)`,
						border: `1px solid color-mix(in srgb, ${color} 24%, transparent)`,
					}}
				>
					{t(`tags.${tag}`)}
				</span>
			</li>
		);
	};

	const groupBlocks = (
		<div className="space-y-5">
			{grouped.map(({ group, rows }) => (
				<div key={group}>
					<p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
						{t(GROUP_LABEL_KEY[group])}
					</p>
					<ul className="space-y-0.5">{rows.map(renderRow)}</ul>
				</div>
			))}
		</div>
	);

	// Embedded (Overview card): a fixed-height, internally-scrolling stack of
	// collapsible group sections, so the card aligns with the Business
	// capabilities card beside it and never grows the page. The first group is
	// expanded by default; the rest start collapsed. `ScrollFade` makes the
	// scrollability obvious — a visible thin scrollbar plus a soft bottom fade
	// while there's more below (it re-measures when a group expands).
	if (embedded) {
		return (
			<ScrollFade
				wrapperClassName="flex min-h-0 flex-1 flex-col max-h-[28rem]"
				className="min-h-0 flex-1 pr-1"
				fadeClassName="h-8"
			>
				<Accordion
					type="multiple"
					defaultValue={grouped.length > 0 ? [grouped[0].group] : []}
					className="w-full"
				>
					{grouped.map(({ group, rows }) => (
						<AccordionItem
							key={group}
							value={group}
							className="border-border/50 last:border-b-0"
						>
							<AccordionTrigger className="py-2.5 hover:no-underline">
								<span className="flex items-center gap-2">
									<span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
										{t(GROUP_LABEL_KEY[group])}
									</span>
									<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground/70">
										{rows.length}
									</span>
								</span>
							</AccordionTrigger>
							<AccordionContent>
								<ul className="space-y-0.5">
									{rows.map(renderRow)}
								</ul>
							</AccordionContent>
						</AccordionItem>
					))}
				</Accordion>
			</ScrollFade>
		);
	}

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<div className="rounded-xl border border-border/60 bg-card/95 shadow-sm">
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<div className="flex items-center gap-2">
							<span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
								{t("title")}
							</span>
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="rounded text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
										<InfoIcon
											aria-hidden="true"
											className="size-3"
										/>
									</span>
								</TooltipTrigger>
								<TooltipContent className="max-w-xs">
									{t("titleTooltip")}
								</TooltipContent>
							</Tooltip>
						</div>
						{open ? (
							<ChevronDownIcon
								aria-hidden="true"
								className="size-3.5 text-muted-foreground"
							/>
						) : (
							<ChevronRightIcon
								aria-hidden="true"
								className="size-3.5 text-muted-foreground"
							/>
						)}
					</button>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="border-t border-border/50 px-3 py-3">
						{groupBlocks}
					</div>
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
}
