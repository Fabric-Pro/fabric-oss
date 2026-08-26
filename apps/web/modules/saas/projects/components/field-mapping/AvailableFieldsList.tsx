"use client";

import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { SearchInput } from "@ui/components/search-input";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { formatDistanceToNow } from "date-fns";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
	deriveAvailableFields,
	type PmFieldCatalogEntry,
	resolveManualField,
	type SelectedField,
} from "./field-mapping-helpers";

type Props = {
	catalog: PmFieldCatalogEntry[];
	selected: SelectedField[];
	onAdd: (field: SelectedField) => void;
	onRefresh: () => void;
	isRefreshing: boolean;
	lastRefreshedAt: number | null;
	disabled?: boolean;
};

/**
 * The "available fields" column: a searchable catalog of fields not yet selected,
 * with plumbing hidden by default, an optional content-first sort, a manual
 * identifier escape hatch, and a "Refresh fields" control.
 */
export function AvailableFieldsList({
	catalog,
	selected,
	onAdd,
	onRefresh,
	isRefreshing,
	lastRefreshedAt,
	disabled,
}: Props) {
	const [query, setQuery] = useState("");
	const [showAll, setShowAll] = useState(false);
	const [contentFirst, setContentFirst] = useState(true);
	const [manualId, setManualId] = useState("");

	const available = useMemo(
		() =>
			deriveAvailableFields({
				catalog,
				selected,
				query,
				showAll,
				keywordSort: contentFirst,
			}),
		[catalog, selected, query, showAll, contentFirst],
	);

	const plumbingHiddenCount = useMemo(
		() =>
			showAll
				? 0
				: catalog.filter(
						(f) =>
							f.isPlumbing &&
							!selected.some((s) => s.id === f.referenceName),
					).length,
		[catalog, selected, showAll],
	);

	const handleManualAdd = () => {
		const field = resolveManualField(catalog, manualId);
		if (!field) {
			return;
		}
		if (selected.some((s) => s.id === field.id)) {
			setManualId("");
			return;
		}
		onAdd(field);
		setManualId("");
	};

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-2">
				<Label
					htmlFor="field-mapping-search"
					className="text-muted-foreground text-xs uppercase tracking-wider"
				>
					Available fields
				</Label>
				<div className="flex items-center gap-2">
					{lastRefreshedAt && (
						<span className="text-muted-foreground text-xs">
							Updated{" "}
							{formatDistanceToNow(lastRefreshedAt, {
								addSuffix: true,
							})}
						</span>
					)}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								onClick={onRefresh}
								disabled={disabled || isRefreshing}
								aria-label="Refresh fields"
							>
								<RefreshCwIcon
									className={
										isRefreshing
											? "size-4 motion-safe:animate-spin"
											: "size-4"
									}
									aria-hidden="true"
								/>
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							Re-enumerate this project's PM fields to pick up
							custom fields added in the PM tool since you last
							loaded them.
						</TooltipContent>
					</Tooltip>
				</div>
			</div>

			<SearchInput
				id="field-mapping-search"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder="Search by name or identifier..."
				disabled={disabled}
			/>

			<div className="flex items-center justify-between gap-4">
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<Switch
						id="field-mapping-show-all"
						checked={showAll}
						onCheckedChange={setShowAll}
						disabled={disabled}
					/>
					<Label
						htmlFor="field-mapping-show-all"
						className="text-muted-foreground text-sm"
					>
						Show all fields
					</Label>
					{plumbingHiddenCount > 0 && (
						<span className="text-muted-foreground/70 text-xs">
							({plumbingHiddenCount} hidden)
						</span>
					)}
				</div>
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<Switch
						id="field-mapping-content-first"
						checked={contentFirst}
						onCheckedChange={setContentFirst}
						disabled={disabled}
					/>
					<Label
						htmlFor="field-mapping-content-first"
						className="text-muted-foreground text-sm"
					>
						Content first
					</Label>
				</div>
			</div>

			<div className="max-h-80 overflow-y-auto rounded-lg border">
				{available.length === 0 ? (
					<p className="px-3 py-6 text-center text-muted-foreground text-sm">
						{query
							? "No fields match your search."
							: "All catalog fields are selected."}
					</p>
				) : (
					<ul className="divide-y">
						{available.map((field) => (
							<li key={field.referenceName}>
								<button
									type="button"
									disabled={disabled}
									onClick={() =>
										onAdd({
											id: field.referenceName,
											displayName: field.name,
										})
									}
									className="flex w-full items-center gap-2 px-3 py-2 text-left motion-safe:transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-hidden disabled:opacity-50"
									aria-label={`Add ${field.name}`}
								>
									<div className="min-w-0 flex-1">
										<p className="truncate font-medium text-foreground text-sm">
											{field.name}
										</p>
										<p className="truncate font-mono text-muted-foreground text-xs">
											{field.referenceName}
										</p>
									</div>
									<PlusIcon
										className="size-4 shrink-0 text-muted-foreground"
										aria-hidden="true"
									/>
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			<div className="space-y-1.5 border-t pt-3">
				<Label
					htmlFor="field-mapping-manual"
					className="text-muted-foreground text-xs"
				>
					Add field by identifier
				</Label>
				<div className="flex items-center gap-2">
					<Input
						id="field-mapping-manual"
						value={manualId}
						onChange={(e) => setManualId(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								handleManualAdd();
							}
						}}
						placeholder="e.g. Custom.BusinessRules"
						disabled={disabled}
						className="font-mono text-sm"
					/>
					<Button
						type="button"
						variant="outline"
						onClick={handleManualAdd}
						disabled={disabled || !manualId.trim()}
					>
						Add
					</Button>
				</div>
				<p className="text-muted-foreground text-xs">
					For a field hidden by the filter or not attached to any work
					item type. If it's in the catalog we'll use its friendly
					name; otherwise you can rename it after adding.
				</p>
			</div>
		</div>
	);
}
