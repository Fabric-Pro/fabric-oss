"use client";

import { cn } from "@ui/lib";
import type { ComponentType, CSSProperties } from "react";

type Props = {
	icon: ComponentType<{ className?: string }>;
	label: string;
	color?: string;
	brandColor?: string;
	size?: number;
	className?: string;
	iconClassName?: string;
};

function hexToRgba(hex: string, alpha: number) {
	const normalized = hex.replace("#", "");
	if (normalized.length !== 6) {
		return undefined;
	}

	const value = Number.parseInt(normalized, 16);
	if (Number.isNaN(value)) {
		return undefined;
	}

	const r = (value >> 16) & 255;
	const g = (value >> 8) & 255;
	const b = value & 255;

	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function IntegrationBrandIcon({
	icon: Icon,
	label,
	color,
	brandColor,
	size = 40,
	className,
	iconClassName,
}: Props) {
	const brandedStyle: CSSProperties | undefined = brandColor
		? {
				background: `linear-gradient(145deg, ${hexToRgba(brandColor, 0.22)}, ${hexToRgba(brandColor, 0.1)})`,
				borderColor: hexToRgba(brandColor, 0.28),
			}
		: undefined;

	return (
		<div
			className={cn(
				"flex shrink-0 items-center justify-center rounded-xl border border-border/60 bg-card/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
				className,
			)}
			style={{
				width: size,
				height: size,
				...brandedStyle,
			}}
			aria-hidden="true"
			title={label}
		>
			<Icon
				className={cn(
					"h-[52%] w-[52%]",
					color ?? "text-foreground",
					iconClassName,
				)}
			/>
		</div>
	);
}
