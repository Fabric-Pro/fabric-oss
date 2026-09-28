"use client";

import { normalizeHexColor } from "@repo/utils/brand-colors";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { PlusIcon, XIcon } from "lucide-react";

/**
 * Parse the entries of a `BrandColorListField` into what the brand procedures
 * accept: lowercase `#rrggbb`, blanks dropped. `#rgb` is widened. Returns
 * null when any non-blank entry is not a hex color, so the caller refuses the
 * save instead of silently dropping what the editor typed.
 */
export function parseBrandColorList(entries: string[]): string[] | null {
	const colors: string[] = [];
	for (const entry of entries) {
		if (!entry.trim()) {
			continue;
		}
		const color = normalizeHexColor(entry);
		if (!color) {
			return null;
		}
		colors.push(color);
	}
	return colors;
}

function isInvalidEntry(entry: string): boolean {
	return entry.trim() !== "" && normalizeHexColor(entry) === null;
}

type BrandColorListFieldLabels = {
	/** Accessible name of the hex input at a 1-based position. */
	hex: (position: number) => string;
	/** Accessible name of the color picker at a 1-based position. */
	picker: (position: number) => string;
	remove: (position: number) => string;
	add: string;
	invalid: string;
	/** Shown read-only when there are no colors. */
	empty: string;
};

type BrandColorListFieldProps = {
	/** Prefix for element ids; unique on the page. */
	id: string;
	legend: string;
	description?: string;
	/** The entries as typed; `parseBrandColorList` turns them into colors. */
	colors: string[];
	max: number;
	disabled?: boolean;
	labels: BrandColorListFieldLabels;
	onChange: (colors: string[]) => void;
};

/**
 * An ordered list of up to `max` brand colors, each a native picker beside a
 * hex text field (the pattern the newsletter embed's accent uses). Shared by
 * the organization Brand kit and the project recipient brand (Fizzy #2589).
 *
 * A malformed entry is flagged inline as it is typed; the owning form refuses
 * to save while one remains. The swatch is the picker itself — the only place
 * a user-chosen color is painted, so no inline style is needed.
 */
export function BrandColorListField({
	id,
	legend,
	description,
	colors,
	max,
	disabled = false,
	labels,
	onChange,
}: BrandColorListFieldProps) {
	const descriptionId = description ? `${id}-description` : undefined;

	const update = (index: number, value: string) =>
		onChange(colors.map((entry, i) => (i === index ? value : entry)));

	return (
		<fieldset className="space-y-2" aria-describedby={descriptionId}>
			<legend className="font-medium text-sm leading-none">
				{legend}
			</legend>
			{description && (
				<p id={descriptionId} className="text-muted-foreground text-xs">
					{description}
				</p>
			)}
			{colors.length === 0 && disabled && (
				<p className="text-muted-foreground text-sm">{labels.empty}</p>
			)}
			<ul className="space-y-2">
				{colors.map((entry, index) => {
					const position = index + 1;
					const invalid = isInvalidEntry(entry);
					const errorId = `${id}-${index}-error`;
					return (
						// Entries have no identity beyond their position, and
						// removing one re-labels the rest anyway.
						<li key={index} className="space-y-1">
							<div className="flex items-center gap-2">
								<Input
									type="color"
									className="h-9 w-14 shrink-0 cursor-pointer p-1"
									aria-label={labels.picker(position)}
									value={
										normalizeHexColor(entry) ?? "#000000"
									}
									disabled={disabled}
									onChange={(e) =>
										update(index, e.target.value)
									}
								/>
								<Input
									id={`${id}-${index}`}
									type="text"
									className="w-36 font-mono"
									aria-label={labels.hex(position)}
									aria-invalid={invalid}
									aria-describedby={
										invalid ? errorId : undefined
									}
									placeholder="#rrggbb"
									maxLength={7}
									spellCheck={false}
									autoComplete="off"
									value={entry}
									disabled={disabled}
									onChange={(e) =>
										update(index, e.target.value)
									}
								/>
								{!disabled && (
									<Button
										type="button"
										variant="ghost"
										size="icon"
										aria-label={labels.remove(position)}
										onClick={() =>
											onChange(
												colors.filter(
													(_, i) => i !== index,
												),
											)
										}
									>
										<XIcon
											className="size-4"
											aria-hidden="true"
										/>
									</Button>
								)}
							</div>
							{invalid && (
								<p
									id={errorId}
									className="text-destructive text-xs"
								>
									{labels.invalid}
								</p>
							)}
						</li>
					);
				})}
			</ul>
			{!disabled && colors.length < max && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => onChange([...colors, ""])}
				>
					<PlusIcon className="size-4" aria-hidden="true" />
					{labels.add}
				</Button>
			)}
		</fieldset>
	);
}
