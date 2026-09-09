"use client";

import { getAvatarInitials } from "@shared/lib/avatar-initials";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { UserIcon } from "lucide-react";
import { useTranslations } from "next-intl";

type Props = {
	/** Display name — when present the avatar shows tokenized initials. */
	name?: string | null;
	/**
	 * Whether an owner is assigned when the name is unknown (the list payload
	 * carries only `ownerId`). `true` → a neutral filled avatar; `false`/omitted
	 * with no name → the dashed "unassigned" placeholder.
	 */
	assigned?: boolean;
	/** Accessible label / tooltip title; falls back to the name or a generic. */
	label?: string;
	className?: string;
};

/**
 * A small owner avatar rendered from tokenized initials (no image) with three
 * states: named (initials), assigned-but-unnamed (neutral user glyph), and
 * unassigned (dashed placeholder). Shared primitive — the cases list passes
 * `assigned` off `ownerId`; the editor drawer and plans can pass
 * a resolved `name`. Colours are all design-system tokens.
 */
export function OwnerAvatar({ name, assigned, label, className }: Props) {
	const t = useTranslations("tooltips.testCases");
	const trimmed = name?.trim();
	const initials = getAvatarInitials(name);
	const accessibleLabel = label ?? trimmed ?? undefined;

	const base =
		"inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium select-none";

	// Every branch already carries `role="img"` + `aria-label`, which wins over
	// any child content — so no `sr-only` echo anywhere here, it would never be
	// read. The tooltip only rehomes the pointer affordance the `title` had.
	if (initials) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<span
						className={cn(
							base,
							"border border-primary/20 bg-primary/10 text-primary",
							className,
						)}
						role="img"
						aria-label={accessibleLabel}
					>
						{initials}
					</span>
				</TooltipTrigger>
				<TooltipContent>
					{t("ownerAssigned", { owner: accessibleLabel ?? "" })}
				</TooltipContent>
			</Tooltip>
		);
	}

	// Assigned but no resolvable name → neutral filled avatar. With no name to
	// show there is nothing worth saying, so no tooltip renders in that case.
	if (assigned) {
		const avatar = (
			<span
				className={cn(
					base,
					"border border-border/70 bg-muted text-muted-foreground",
					className,
				)}
				role="img"
				aria-label={accessibleLabel}
			>
				<UserIcon aria-hidden="true" className="size-3" />
			</span>
		);
		if (!accessibleLabel) {
			return avatar;
		}
		return (
			<Tooltip>
				<TooltipTrigger asChild>{avatar}</TooltipTrigger>
				<TooltipContent>
					{t("ownerAssigned", { owner: accessibleLabel })}
				</TooltipContent>
			</Tooltip>
		);
	}

	// Unassigned placeholder.
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className={cn(
						base,
						"border border-border/70 border-dashed text-muted-foreground/70",
						className,
					)}
					role="img"
					aria-label={accessibleLabel}
				>
					<UserIcon aria-hidden="true" className="size-3" />
				</span>
			</TooltipTrigger>
			<TooltipContent>{t("ownerUnassigned")}</TooltipContent>
		</Tooltip>
	);
}
