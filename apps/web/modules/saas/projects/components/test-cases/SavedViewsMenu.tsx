"use client";

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { BookmarkIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
	SAVED_VIEW_NAME_MAX,
	type SavedViewsControls,
} from "./use-saved-views";

/**
 * Saved views: a named filter/sort/page combination, recalled in one click.
 *
 * The thing being saved is exactly the query string the address bar already
 * holds, so a saved view and a pasted link are interchangeable — there is no
 * second concept of "a view" to keep in step with the URL.
 */
export function SavedViewsMenu({
	controls,
	currentSearch,
	hasActiveFilters,
	onApply,
	className,
}: {
	controls: SavedViewsControls;
	/** `window.location.search` for the current view. */
	currentSearch: string;
	/** Nothing narrowed means there is nothing worth saving. */
	hasActiveFilters: boolean;
	onApply: (query: string) => void;
	className?: string;
}) {
	const t = useTranslations("projects.testCases.savedViews");
	const [naming, setNaming] = useState(false);
	const [name, setName] = useState("");
	const active = controls.matching(currentSearch);

	const commit = () => {
		controls.save(name, currentSearch);
		setName("");
		setNaming(false);
	};

	return (
		<DropdownMenu
			onOpenChange={(open) => {
				if (!open) {
					setNaming(false);
					setName("");
				}
			}}
		>
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className={className}
						>
							<BookmarkIcon
								aria-hidden="true"
								className="mr-2 size-3.5 text-primary"
							/>
							{active ? active.name : t("trigger")}
							<ChevronDownIcon
								aria-hidden="true"
								className="ml-1.5 size-3.5 opacity-60"
							/>
						</Button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs">
					{t("hint")}
				</TooltipContent>
			</Tooltip>

			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuLabel>{t("label")}</DropdownMenuLabel>

				{controls.views.length === 0 && !naming && (
					<p className="px-2 py-1.5 text-muted-foreground text-xs leading-relaxed">
						{t("empty")}
					</p>
				)}

				{controls.views.map((view) => (
					<DropdownMenuItem
						key={view.id}
						className="group justify-between gap-2"
						onSelect={() => onApply(view.query)}
					>
						<span className="min-w-0 truncate">{view.name}</span>
						<button
							type="button"
							aria-label={t("removeAria", { name: view.name })}
							className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
							onClick={(e) => {
								// The row applies the view; the X must not.
								e.stopPropagation();
								e.preventDefault();
								controls.remove(view.id);
							}}
						>
							<XIcon aria-hidden="true" className="size-3.5" />
						</button>
					</DropdownMenuItem>
				))}

				<DropdownMenuSeparator />

				{naming ? (
					// Kept inside the menu rather than opening a dialog: naming a
					// view is a two-second act and a modal for it is heavier than
					// the thing it captures.
					<div className="p-1.5">
						<Input
							autoFocus
							value={name}
							maxLength={SAVED_VIEW_NAME_MAX}
							placeholder={t("namePlaceholder")}
							aria-label={t("nameAria")}
							className="h-8"
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => {
								e.stopPropagation();
								if (e.key === "Enter") {
									commit();
								}
								if (e.key === "Escape") {
									setNaming(false);
								}
							}}
						/>
						<div className="mt-1.5 flex justify-end gap-1.5">
							<Button
								type="button"
								size="sm"
								variant="ghost"
								className="h-7"
								onClick={() => setNaming(false)}
							>
								{t("cancel")}
							</Button>
							<Button
								type="button"
								size="sm"
								className="h-7"
								disabled={!name.trim()}
								onClick={commit}
							>
								{t("save")}
							</Button>
						</div>
					</div>
				) : (
					<DropdownMenuItem
						disabled={!hasActiveFilters || controls.atLimit}
						onSelect={(e) => {
							e.preventDefault();
							setNaming(true);
						}}
					>
						{controls.atLimit
							? t("atLimit")
							: hasActiveFilters
								? t("saveCurrent")
								: t("nothingToSave")}
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
