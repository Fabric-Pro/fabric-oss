"use client";

import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Slider } from "@ui/components/slider";

/**
 * A 0–100 slider with its live value — used by every percentage setting in
 * Settings ▸ Testing.
 */
export function PercentField({
	id,
	label,
	hint,
	value,
	disabled,
	min = 0,
	onChange,
}: {
	id: string;
	label: string;
	hint: string;
	value: number;
	disabled: boolean;
	/** Floor for THIS control. Below it, off is the switch's job — see the gate field. */
	min?: number;
	onChange: (value: number) => void;
}) {
	return (
		<div>
			<div className="flex items-baseline justify-between gap-3">
				<Label htmlFor={id}>{label}</Label>
				<span className="font-semibold text-sm tabular-nums">
					{value}%
				</span>
			</div>
			<p className="text-muted-foreground text-xs">{hint}</p>
			<div className="mt-2 flex items-center gap-3">
				{/*
				 * The slider steps by 5 while the number input stays free-entry —
				 * deliberate, not a drift between two controls. Dragging offers
				 * the coarse scale; typing allows any whole percent.
				 */}
				<Slider
					id={id}
					aria-label={label}
					min={min}
					max={100}
					step={5}
					disabled={disabled}
					value={[value]}
					onValueChange={([next]) => onChange(next ?? value)}
					className="flex-1"
				/>
				<Input
					type="number"
					min={min}
					max={100}
					disabled={disabled}
					value={value}
					aria-label={`${label} value`}
					onChange={(e) => {
						const next = Number.parseInt(e.target.value, 10);
						if (Number.isFinite(next)) {
							onChange(Math.max(min, Math.min(100, next)));
						}
					}}
					className="w-20"
				/>
			</div>
		</div>
	);
}
