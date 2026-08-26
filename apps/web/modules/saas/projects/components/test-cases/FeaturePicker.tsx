"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui/components/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { cn } from "@ui/lib";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { useDebounceValue } from "usehooks-ts";
import type { FeatureOption } from "./feature-options";

/**
 * How many options the list asks the server for. The type-ahead is the real
 * navigation — this cap only stops a several-hundred-feature project from
 * rendering (and asking the reader to scroll) the entire backlog.
 */
const MAX_OPTIONS = 50;

/** Long enough that a typed word is one query, not one per keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

/** The coverage-row slice this picker reads (extra API fields are ignored). */
type CoverageRow = {
	storyId: string;
	identifier: string;
	title: string;
	kind: "FEATURE" | "BUG";
	closed: boolean;
	caseCount: number;
};

function toOption(row: CoverageRow): FeatureOption {
	return {
		id: row.storyId,
		identifier: row.identifier,
		title: row.title,
		kind: row.kind,
	};
}

type Props = {
	projectId: string;
	organizationId: string | null;
	/** Selected story ids — drives the check marks and the default trigger label. */
	value: readonly string[];
	/** The full next selection. Single-select always hands back exactly one option. */
	onChange: (selected: FeatureOption[]) => void;
	/** Keep the popover open and toggle ids instead of replacing the selection. */
	multiple?: boolean;
	/** Ids dropped from the list entirely (e.g. already linked to this case). */
	excludeIds?: ReadonlySet<string>;
	disabled?: boolean;
	/** Replaces the default combobox button. Rendered via `asChild`. */
	trigger?: ReactNode;
	/** Default-trigger only — a custom `trigger` labels and identifies itself. */
	triggerId?: string;
	triggerClassName?: string;
	ariaLabel?: string;
	placeholder?: string;
};

/**
 * Searchable work-item picker shared by the AI-draft dialog, the cases filter
 * toolbar and the case editor's link control.
 *
 * Searching, filtering and ranking all happen in the coverage query: it returns
 * one already-ranked page — untested work first, then most recently updated —
 * with each option's coverage count, so the reader is offered the gaps first and
 * can see what is already tested before picking. Ranking a fetched page here
 * instead would only reorder whichever rows happened to arrive.
 *
 * Defaults to features: bugs and closed items are behind a toggle, because
 * picking something to test is nearly always picking an open feature. The
 * identifier is a plain decimal shared across kinds, so it never says what it
 * points at on its own — the title and the kind chip do that work.
 */
export function FeaturePicker({
	projectId,
	organizationId,
	value,
	onChange,
	multiple = false,
	excludeIds,
	disabled,
	trigger,
	triggerId,
	triggerClassName,
	ariaLabel,
	placeholder,
}: Props) {
	const t = useTranslations("projects.testCases.featurePicker");
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [includeBugsAndClosed, setIncludeBugsAndClosed] = useState(false);
	const [debouncedQuery] = useDebounceValue(query, SEARCH_DEBOUNCE_MS);

	// Every option the reader has picked, remembered across searches. The list
	// only ever holds one page, so an item chosen under an earlier query is not
	// in `data` any more — rebuilding the selection from the page in hand would
	// silently drop it. A ref suffices: it is only ever written in `pick`, which
	// re-renders through `onChange` anyway.
	const picked = useRef(new Map<string, FeatureOption>());

	const { data, isLoading } = useQuery({
		...orpc.projects.testCases.featureCoverage.queryOptions({
			input: {
				projectId,
				organizationId,
				search: debouncedQuery.trim() || undefined,
				kind: includeBugsAndClosed ? undefined : "FEATURE",
				excludeClosed: !includeBugsAndClosed,
				order: "UNCOVERED_FIRST",
				limit: MAX_OPTIONS,
			},
		}),
		// Nothing needs the options until the reader opens the list: the trigger
		// labels itself from what was picked, not from a fetch.
		enabled: open,
		staleTime: 60_000,
	});

	const rows = useMemo(
		() =>
			(data?.items ?? []).filter((row) => !excludeIds?.has(row.storyId)),
		[data?.items, excludeIds],
	);

	const selectedIds = useMemo(() => new Set(value), [value]);

	const pick = (row: CoverageRow) => {
		const option = toOption(row);
		picked.current.set(option.id, option);
		if (!multiple) {
			onChange([option]);
			setQuery("");
			setOpen(false);
			return;
		}
		const current = value
			.map((id) => picked.current.get(id))
			.filter((o): o is FeatureOption => o !== undefined);
		onChange(
			selectedIds.has(option.id)
				? current.filter((o) => o.id !== option.id)
				: [...current, option],
		);
	};

	const selected = value
		.map((id) => picked.current.get(id))
		.filter((o): o is FeatureOption => o !== undefined);
	// Keyed off `value`, not `selected`: an id this picker never handed out has
	// no label to show, but it is still selected — saying so beats rendering the
	// placeholder as if nothing were.
	const defaultLabel =
		value.length === 0
			? (placeholder ?? "")
			: value.length === 1 && selected.length === 1
				? `${selected[0].identifier} · ${selected[0].title}`
				: t("selectedCount", { count: value.length });

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild disabled={disabled}>
				{trigger ?? (
					<Button
						type="button"
						id={triggerId}
						variant="outline"
						role="combobox"
						aria-expanded={open}
						aria-label={ariaLabel}
						className={cn(
							"w-full justify-between font-normal",
							value.length === 0 && "text-muted-foreground",
							triggerClassName,
						)}
					>
						<span className="min-w-0 truncate">{defaultLabel}</span>
						<ChevronsUpDownIcon
							aria-hidden="true"
							className="ml-2 size-4 shrink-0 opacity-50"
						/>
					</Button>
				)}
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 p-0">
				{/* Matching and ranking are the server's, so cmdk's own filter
				    must stay out of the way. */}
				<Command shouldFilter={false}>
					<CommandInput
						value={query}
						onValueChange={setQuery}
						placeholder={t("searchPlaceholder")}
					/>
					<CommandList>
						{isLoading ? (
							<div className="py-6 text-center text-muted-foreground text-sm">
								{t("loading")}
							</div>
						) : (
							<>
								<CommandEmpty>{t("noMatches")}</CommandEmpty>
								<CommandGroup>
									{rows.map((row) => (
										<CommandItem
											key={row.storyId}
											value={row.storyId}
											onSelect={() => pick(row)}
										>
											<CheckIcon
												aria-hidden="true"
												className={cn(
													"mr-1 size-4 shrink-0",
													selectedIds.has(row.storyId)
														? "opacity-100"
														: "opacity-0",
												)}
											/>
											<span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
												{row.identifier}
											</span>
											<span className="min-w-0 flex-1 truncate">
												{row.title}
											</span>
											{/* Only the non-default kinds earn a chip —
											    a "Feature" chip on every row is noise. */}
											{row.kind === "BUG" && (
												<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
													{t("bug")}
												</span>
											)}
											{row.closed && (
												<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
													{t("closed")}
												</span>
											)}
											<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
												{t("coverageCount", {
													count: row.caseCount,
												})}
											</span>
										</CommandItem>
									))}
								</CommandGroup>
							</>
						)}
					</CommandList>
					<div className="border-t p-1">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							aria-pressed={includeBugsAndClosed}
							onClick={() =>
								setIncludeBugsAndClosed((prev) => !prev)
							}
							className="w-full justify-start font-normal text-muted-foreground text-xs"
						>
							<CheckIcon
								aria-hidden="true"
								className={cn(
									"mr-2 size-3.5",
									includeBugsAndClosed
										? "opacity-100"
										: "opacity-0",
								)}
							/>
							{t("includeBugsAndClosed")}
						</Button>
					</div>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
