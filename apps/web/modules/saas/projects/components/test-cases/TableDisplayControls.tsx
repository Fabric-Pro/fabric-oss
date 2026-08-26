"use client";

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Rows3Icon, Settings2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type TableDisplayControls as Controls,
	DENSITIES,
	type Density,
	HIDEABLE_COLUMNS,
	type HideableColumn,
} from "./use-table-display";

/**
 * Row density and column visibility, as two small menus at the end of the
 * toolbar.
 *
 * Both are per-person preferences held in `localStorage`, not in the URL — see
 * the note in `use-table-display.ts`. Neither changes which rows match, so
 * neither belongs in a shared link.
 */
export function TableDisplayControls({
	controls,
	className,
}: {
	controls: Controls;
	className?: string;
}) {
	const t = useTranslations("projects.testCases.display");
	const hiddenCount = controls.hidden.length;

	return (
		<div className={className}>
			<DropdownMenu>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button
								type="button"
								variant="outline"
								size="icon-sm"
								className="size-9"
								aria-label={t("densityAria")}
							>
								<Rows3Icon
									aria-hidden="true"
									className="size-4"
								/>
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs">
						{t("densityHint")}
					</TooltipContent>
				</Tooltip>
				<DropdownMenuContent align="end">
					<DropdownMenuLabel>{t("density")}</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={controls.density}
						onValueChange={(v) => controls.setDensity(v as Density)}
					>
						{DENSITIES.map((d) => (
							<DropdownMenuRadioItem key={d} value={d}>
								{t(`densities.${d}`)}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>

			<DropdownMenu>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button
								type="button"
								variant="outline"
								size="icon-sm"
								className="relative size-9"
								aria-label={t("columnsAria")}
							>
								<Settings2Icon
									aria-hidden="true"
									className="size-4"
								/>
								{hiddenCount > 0 && (
									// A hidden column is easy to forget and looks
									// exactly like a column that never existed.
									<span
										aria-hidden="true"
										className="-top-1 -right-1 absolute inline-flex size-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground tabular-nums"
									>
										{hiddenCount}
									</span>
								)}
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs">
						{hiddenCount > 0
							? t("columnsHintHidden", { count: hiddenCount })
							: t("columnsHint")}
					</TooltipContent>
				</Tooltip>
				<DropdownMenuContent align="end" className="w-52">
					<DropdownMenuLabel>{t("columns")}</DropdownMenuLabel>
					{HIDEABLE_COLUMNS.map((c) => (
						<DropdownMenuCheckboxItem
							key={c}
							checked={!controls.isHidden(c)}
							// Radix closes the menu on select by default, which
							// makes turning three columns off three round trips.
							onSelect={(e) => e.preventDefault()}
							onCheckedChange={() =>
								controls.toggleColumn(c as HideableColumn)
							}
						>
							{t(`columnNames.${c}`)}
						</DropdownMenuCheckboxItem>
					))}
					{hiddenCount > 0 && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={controls.resetColumns}>
								{t("showAllColumns")}
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
