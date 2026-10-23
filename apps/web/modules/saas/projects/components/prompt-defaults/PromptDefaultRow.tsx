"use client";

import { Button } from "@ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { cn } from "@ui/lib";
import { ArrowUpRightIcon, ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { PromptTierBadge } from "./PromptTierBadge";
import type {
	CatalogBinding,
	PromptDefaultRowModel,
	PromptRef,
} from "./prompt-default-model";

/** Where a prompt's own page lives. */
const promptHref = (basePath: string, promptId: string) =>
	`${basePath}/prompts/${promptId}`;

/** The catalog, focused on one action. */
const catalogActionHref = (basePath: string, actionId: string) =>
	`${basePath}/prompts/catalog?action=${encodeURIComponent(actionId)}`;

export type PromptDefaultRowActions = {
	basePath: string;
	canEdit: boolean;
	busy: boolean;
	onSet: (row: PromptDefaultRowModel, binding: CatalogBinding) => void;
	onClear: (row: PromptDefaultRowModel) => void;
};

/** A prompt's name as a link to that prompt, or the built-in text. */
function PromptName({
	prompt,
	basePath,
	className,
}: {
	prompt: PromptRef | null;
	basePath: string;
	className?: string;
}) {
	if (!prompt) {
		return (
			<span
				className={cn(
					"truncate text-muted-foreground italic",
					className,
				)}
			>
				Built-in text
			</span>
		);
	}
	return (
		<Link
			href={promptHref(basePath, prompt.id)}
			title={prompt.name}
			className={cn(
				"truncate text-foreground/85 underline-offset-2 hover:text-foreground hover:underline focus-visible:underline",
				className,
			)}
		>
			{prompt.name}
		</Link>
	);
}

function ClearButton({
	row,
	busy,
	onClear,
}: Pick<PromptDefaultRowActions, "busy" | "onClear"> & {
	row: PromptDefaultRowModel;
}) {
	return (
		<Button
			variant="outline"
			size="sm"
			className="h-7 px-2.5"
			disabled={busy}
			aria-label={`Clear the project override for ${row.action.label}`}
			onClick={() => onClear(row)}
		>
			Clear
		</Button>
	);
}

function PromptPicker({
	row,
	basePath,
	busy,
	onSet,
}: Pick<PromptDefaultRowActions, "basePath" | "busy" | "onSet"> & {
	row: PromptDefaultRowModel;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					className="h-7 gap-1 pr-2 pl-2.5"
					disabled={busy}
					aria-label={`Change the prompt this project uses for ${row.action.label}`}
				>
					Change
					<ChevronDownIcon
						aria-hidden="true"
						className="size-3.5 text-muted-foreground"
					/>
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="w-[340px] max-w-[calc(100vw-2rem)] p-1"
			>
				<div className="-mx-1 mb-1 border-b px-3 py-2">
					<span className="block text-[11px] text-muted-foreground">
						Runs now
					</span>
					<PromptName
						prompt={row.runsNow}
						basePath={basePath}
						className="block text-[13px]"
					/>
				</div>
				<p className="px-2 pt-1 pb-1.5 font-medium text-[11px] text-muted-foreground tracking-[0.04em]">
					Use for this project
				</p>
				<ul>
					{row.candidates.map((candidate) => (
						<li key={candidate.promptVersionId}>
							<button
								type="button"
								onClick={() => {
									setOpen(false);
									onSet(row, candidate);
								}}
								className="flex w-full items-center gap-2.5 rounded-md p-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[13px]">
										{candidate.promptName}
									</span>
									{candidate.isEffective && (
										<span className="block text-[11px] text-muted-foreground">
											Runs now
										</span>
									)}
								</span>
								<PromptTierBadge tier={candidate.scope} />
							</button>
						</li>
					))}
				</ul>
				<div className="-mx-1 my-1 h-px bg-border" />
				<Link
					href={catalogActionHref(basePath, row.action.id)}
					className="flex items-center gap-1.5 rounded-md p-2 text-muted-foreground text-xs hover:text-foreground"
				>
					Edit or create prompts in the Prompt Library
					<ArrowUpRightIcon aria-hidden="true" className="size-3" />
				</Link>
			</PopoverContent>
		</Popover>
	);
}

/** The control at the end of a row: Clear, Change, or why there is neither. */
function RowControl({
	row,
	canEdit,
	basePath,
	busy,
	onSet,
	onClear,
}: PromptDefaultRowActions & { row: PromptDefaultRowModel }) {
	if (!canEdit) {
		return null;
	}
	if (row.own) {
		return <ClearButton row={row} busy={busy} onClear={onClear} />;
	}
	if (row.candidates.length > 0) {
		return (
			<PromptPicker
				row={row}
				basePath={basePath}
				busy={busy}
				onSet={onSet}
			/>
		);
	}
	return (
		<span className="whitespace-nowrap text-muted-foreground/80 text-xs">
			No alternatives
		</span>
	);
}

/**
 * One action. At phone width it stacks — name, prompt, then the badge and the
 * control on one line; from `sm` it is a four-column grid.
 */
export function PromptDefaultRow({
	row,
	title,
	subtitle,
	note,
	...actions
}: PromptDefaultRowActions & {
	row: PromptDefaultRowModel;
	title: string;
	subtitle: string | null;
	note?: ReactNode;
}) {
	return (
		<li className="grid grid-cols-1 gap-1.5 rounded-lg px-3 py-2 transition-colors hover:bg-muted/50 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_6.5rem_6.5rem] sm:items-center sm:gap-3">
			<div className="min-w-0">
				<p className="truncate font-medium text-sm">{title}</p>
				{subtitle && (
					<p className="truncate text-muted-foreground text-xs">
						{subtitle}
					</p>
				)}
				{note && (
					<p className="text-muted-foreground text-xs">{note}</p>
				)}
			</div>
			<div className="flex min-w-0 flex-col text-[13px]">
				<PromptName prompt={row.prompt} basePath={actions.basePath} />
				{row.shadowed && (
					<span className="truncate text-muted-foreground text-xs">
						Your personal default runs instead
					</span>
				)}
			</div>
			<div className="flex items-center justify-between gap-2 sm:contents">
				<PromptTierBadge
					tier={row.tier}
					className="sm:justify-self-start"
				/>
				<div className="flex items-center sm:justify-self-end">
					<RowControl row={row} {...actions} />
				</div>
			</div>
		</li>
	);
}
