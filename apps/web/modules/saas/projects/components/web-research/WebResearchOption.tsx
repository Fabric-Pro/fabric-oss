"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useId } from "react";
import type {
	WebResearchAvailability,
	WebResearchMissing,
} from "./use-web-research-availability";

interface WebResearchOptionProps {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	/** From `useWebResearchAvailability`. */
	availability: WebResearchAvailability;
	/**
	 * An already-translated reason that blocks the option whatever the
	 * providers say, e.g. a source that cannot be researched.
	 */
	blockedReason?: string;
	/** `compact` swaps the hint for a shorter one, for tight rows. */
	variant?: "default" | "compact";
	/** Runs before following the settings link, e.g. to close a dialog. */
	onNavigate?: () => void;
	className?: string;
}

const MISSING_KEY = {
	search: "missingSearch",
	read: "missingRead",
	both: "missingBoth",
} as const;

function missingKey(missing: readonly WebResearchMissing[]) {
	const search = missing.includes("search");
	const read = missing.includes("read");
	if (search && !read) {
		return MISSING_KEY.search;
	}
	if (read && !search) {
		return MISSING_KEY.read;
	}
	return MISSING_KEY.both;
}

/**
 * The "Allow web research" checkbox shared by every create and regenerate
 * surface. The surface owns `checked` and resets it each time it opens, so a
 * tick never carries over from an earlier action.
 *
 * When research cannot run (still checking, check failed, providers missing,
 * or `blockedReason`), the checkbox is `aria-disabled`, never `disabled`:
 * Radix makes a disabled checkbox inert to the keyboard, and then nobody could
 * reach the reason it is described by. It reads unchecked and ignores clicks.
 */
export function WebResearchOption({
	checked,
	onCheckedChange,
	availability,
	blockedReason,
	variant = "default",
	onNavigate,
	className,
}: WebResearchOptionProps) {
	const t = useTranslations("projects.documents.webResearch");
	const { organizationSlug } = useOrganizationContext();
	const checkboxId = `${useId()}web-research`;
	const hintId = `${checkboxId}-hint`;
	const reasonId = `${checkboxId}-reason`;

	const blocked =
		blockedReason !== undefined || availability.status !== "available";
	const compact = variant === "compact";

	let reason: ReactNode = null;
	if (blockedReason !== undefined) {
		reason = blockedReason;
	} else if (availability.status === "loading") {
		reason = t("checking");
	} else if (availability.status === "error") {
		reason = t("checkFailed");
	} else if (availability.status === "unavailable") {
		reason = (
			<>
				{t(missingKey(availability.missing))}
				{/* Organization settings only: with no organization there is
				    no settings page this option could point to. */}
				{organizationSlug && (
					<>
						{" "}
						<Link
							href={`/app/${organizationSlug}/settings/search-providers`}
							onClick={onNavigate}
							className="underline underline-offset-2 hover:text-foreground"
						>
							{t("settingsLink")}
						</Link>
					</>
				)}
			</>
		);
	}

	return (
		<div className={cn("flex items-start gap-2", className)}>
			<Checkbox
				id={checkboxId}
				className={cn(
					"mt-0.5",
					blocked && "cursor-not-allowed opacity-60",
				)}
				checked={blocked ? false : checked}
				aria-disabled={blocked || undefined}
				aria-describedby={blocked ? `${hintId} ${reasonId}` : hintId}
				// Radix routes both click and Space through this handler, so
				// leaving it out is what keeps a blocked checkbox unticked.
				onCheckedChange={
					blocked
						? undefined
						: (next) => onCheckedChange(next === true)
				}
			/>
			<div className="min-w-0 flex-1">
				<Label
					htmlFor={checkboxId}
					className={cn(
						blocked ? "cursor-not-allowed" : "cursor-pointer",
					)}
				>
					{t("label")}
				</Label>
				<p
					id={hintId}
					className={cn(
						"text-muted-foreground",
						compact ? "text-xs" : "text-sm",
					)}
				>
					{compact ? t("compactHint") : t("hint")}
				</p>
				{reason !== null && (
					<p
						id={reasonId}
						data-testid="web-research-reason"
						className="mt-1 text-muted-foreground text-xs"
					>
						{reason}
					</p>
				)}
			</div>
		</div>
	);
}
