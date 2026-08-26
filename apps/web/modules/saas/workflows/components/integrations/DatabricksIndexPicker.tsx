"use client";

/**
 * Databricks Vector Search schema + index picker.
 *
 * Extracted from the agent-builder DataSourcesSheet so the project-level
 * knowledge binding (Project Settings > Knowledge) reuses the exact same
 * picker instead of rebuilding it. Selection shape matches the persisted
 * `allowedResources` payload: `{ schema, indexes }`.
 */

import { MAX_QUERY_INDEXES } from "@repo/integrations/databricks-vector-search/constants";
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { cn } from "@ui/lib";

type DatabricksSchemaGroup = {
	schema: string;
	indexes: Array<{ name: string; endpointName: string }>;
};

export type DatabricksIndexSelection = {
	schema: string;
	indexes: string[];
};

type Props = {
	schemas: DatabricksSchemaGroup[];
	selection: DatabricksIndexSelection | undefined;
	onSelectionChange: (next: DatabricksIndexSelection | undefined) => void;
	/**
	 * Trailing note shown when the index cap is reached — names the scope the
	 * cap applies to (e.g. "per agent" vs "per project").
	 */
	limitScopeLabel?: string;
	disabled?: boolean;
};

export function DatabricksIndexPicker({
	schemas,
	selection,
	onSelectionChange,
	limitScopeLabel = "per agent",
	disabled = false,
}: Props) {
	return (
		<div className="space-y-3">
			<div className="space-y-2">
				<Label>Unity Catalog schema</Label>
				<Select
					value={selection?.schema ?? ""}
					disabled={disabled}
					onValueChange={(value) =>
						onSelectionChange(
							value ? { schema: value, indexes: [] } : undefined,
						)
					}
				>
					<SelectTrigger>
						<SelectValue placeholder="Select a schema…" />
					</SelectTrigger>
					<SelectContent>
						{schemas.map((group) => (
							<SelectItem key={group.schema} value={group.schema}>
								{group.schema}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{selection?.schema && (
				<div className="space-y-2">
					<div className="flex items-center justify-between gap-2">
						<Label>Indexes</Label>
						<span
							className={cn(
								"text-xs",
								selection.indexes.length >= MAX_QUERY_INDEXES
									? "font-medium text-amber-600 dark:text-amber-400"
									: "text-muted-foreground",
							)}
						>
							{selection.indexes.length} of {MAX_QUERY_INDEXES}{" "}
							selected
							{selection.indexes.length >= MAX_QUERY_INDEXES &&
								" — maximum reached"}
						</span>
					</div>
					<div className="space-y-1.5">
						{schemas
							.find((g) => g.schema === selection.schema)
							?.indexes.map((index) => {
								const checked = selection.indexes.includes(
									index.name,
								);
								const atLimit =
									!checked &&
									selection.indexes.length >=
										MAX_QUERY_INDEXES;
								return (
									<div
										key={index.name}
										className="flex items-center gap-2 text-sm"
									>
										<Checkbox
											id={`databricks-index-${index.name}`}
											aria-label={index.name}
											checked={checked}
											disabled={disabled || atLimit}
											onCheckedChange={() => {
												if (atLimit || disabled) {
													return;
												}
												onSelectionChange({
													schema: selection.schema,
													indexes: checked
														? selection.indexes.filter(
																(n) =>
																	n !==
																	index.name,
															)
														: [
																...selection.indexes,
																index.name,
															],
												});
											}}
										/>
										<Label
											htmlFor={`databricks-index-${index.name}`}
											className={cn(
												"truncate font-normal",
												atLimit &&
													"text-muted-foreground",
											)}
										>
											{index.name}
										</Label>
									</div>
								);
							})}
					</div>
					{selection.indexes.length >= MAX_QUERY_INDEXES && (
						<p className="text-xs text-muted-foreground">
							The Databricks runtime only searches up to{" "}
							{MAX_QUERY_INDEXES} indexes {limitScopeLabel}.
							Deselect one to add another.
						</p>
					)}
				</div>
			)}
		</div>
	);
}
