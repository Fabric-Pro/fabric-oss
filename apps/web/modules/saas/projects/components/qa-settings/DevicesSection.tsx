"use client";

import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";
import {
	BROWSER_LABEL,
	BROWSERS,
	type Browser,
	RESOLUTION_PATTERN,
	SUGGESTED_RESOLUTIONS,
} from "./qa-settings-constants";

function Chip({
	label,
	selected,
	disabled,
	onClick,
}: {
	label: string;
	selected: boolean;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			aria-pressed={selected}
			onClick={onClick}
			className={cn(
				"rounded-full border px-3 py-1 text-xs motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				selected
					? "border-primary bg-primary/10 text-foreground"
					: "text-muted-foreground hover:bg-accent/50",
				disabled && "cursor-not-allowed opacity-70",
			)}
		>
			{label}
		</button>
	);
}

/**
 * Devices & browsers — the ONE combination a run uses, so both chip rows are
 * single-select: the runner reads only the FIRST entry of each stored list,
 * and multi-select chips used to ship defaults that contradicted that.
 */
export function DevicesSectionBody({
	resolution,
	browser,
	customResolution,
	canEdit,
	onSelectResolution,
	onSelectBrowser,
	onCustomResolution,
}: {
	resolution: string | undefined;
	browser: Browser | undefined;
	/** Text buffer for the custom field — kept outside the draft so half-typed values don't churn unsaved state. */
	customResolution: string;
	canEdit: boolean;
	onSelectResolution: (resolution: string) => void;
	onSelectBrowser: (browser: Browser) => void;
	onCustomResolution: (value: string) => void;
}) {
	return (
		<>
			<Label>Default resolution</Label>
			<div className="mt-1.5 flex flex-wrap gap-2">
				{[...new Set([...SUGGESTED_RESOLUTIONS, resolution])]
					.filter((res): res is string => Boolean(res))
					.map((res) => (
						<Chip
							key={res}
							label={res}
							selected={resolution === res}
							disabled={!canEdit}
							onClick={() => onSelectResolution(res)}
						/>
					))}
			</div>
			<div className="mt-2 flex items-center gap-2">
				<Input
					type="text"
					placeholder="Custom WxH, e.g. 2560x1440"
					aria-label="Custom resolution"
					className="w-56"
					value={customResolution}
					disabled={!canEdit}
					onChange={(e) => {
						const next = e.target.value.trim();
						onCustomResolution(next);
					}}
				/>
				{customResolution.length > 0 &&
					!RESOLUTION_PATTERN.test(customResolution) && (
						<span className="text-destructive text-xs">
							Use WIDTHxHEIGHT
						</span>
					)}
			</div>

			<Label className="mt-4 block">Default browser</Label>
			<div className="mt-1.5 flex flex-wrap gap-2">
				{BROWSERS.map((browser_) => (
					<Chip
						key={browser_}
						label={BROWSER_LABEL[browser_]}
						selected={browser === browser_}
						disabled={!canEdit}
						onClick={() => onSelectBrowser(browser_)}
					/>
				))}
			</div>
		</>
	);
}
