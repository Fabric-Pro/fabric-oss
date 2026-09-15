"use client";

import type { EngagementProfile } from "@repo/database/prisma/generated/enums";
import {
	ENGAGEMENT_PROFILE_VALUES,
	ENGAGEMENT_PROFILES,
} from "@repo/database/src/engagement-profiles";
import { cn } from "@ui/lib";
import { CheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { DELIVERY_TRACK_META } from "../../lib/stories/types";
import { InfoTip } from "../stories/InfoTip";

interface EngagementProfilePickerProps {
	value: EngagementProfile;
	onChange: (profile: EngagementProfile) => void;
	disabled?: boolean;
	/** Two-column grid (settings) instead of the wizard's four-up layout. */
	columns?: 2 | 4;
	/** Hide the section heading when the parent renders its own. */
	hideHeading?: boolean;
}

/**
 * Radio-style card picker for the four engagement profiles. Labels and
 * descriptions come from `ENGAGEMENT_PROFILES` (single source of truth);
 * only the surrounding copy is translated.
 */
export function EngagementProfilePicker({
	value,
	onChange,
	disabled = false,
	columns = 4,
	hideHeading = false,
}: EngagementProfilePickerProps) {
	const t = useTranslations("projects.engagement");
	const tTips = useTranslations("tooltips.projectSetup");
	const headingId = useId();
	const groupName = `${headingId}-profile`;

	return (
		<div className="space-y-4">
			{!hideHeading && (
				<div>
					<p
						id={headingId}
						className="text-base font-medium text-foreground"
					>
						{t("profileLabel")}
					</p>
					<p className="mt-1 text-sm text-muted-foreground">
						{t("profileHint")}
					</p>
				</div>
			)}
			<div
				role="radiogroup"
				aria-labelledby={hideHeading ? undefined : headingId}
				aria-label={hideHeading ? t("profileLabel") : undefined}
				className={cn(
					"grid grid-cols-1 gap-3",
					columns === 4
						? "md:grid-cols-2 xl:grid-cols-4"
						: "md:grid-cols-2",
				)}
			>
				{ENGAGEMENT_PROFILE_VALUES.map((profile) => {
					const config = ENGAGEMENT_PROFILES[profile];
					const selected = profile === value;
					return (
						// Native radio (visually hidden) inside the card label:
						// arrow-key navigation, form semantics and screen-reader
						// announcement come for free; the label carries the styling.
						<label
							key={profile}
							className={cn(
								"flex h-full flex-col gap-2 rounded-xl border p-4 text-left transition-colors",
								"has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background",
								selected
									? "border-primary bg-primary/5"
									: "border-border bg-card hover:border-foreground/20",
								disabled && "cursor-not-allowed opacity-60",
								!disabled && "cursor-pointer",
							)}
						>
							<input
								type="radio"
								name={groupName}
								value={profile}
								checked={selected}
								disabled={disabled}
								onChange={() => onChange(profile)}
								className="sr-only"
							/>
							<div className="flex items-start justify-between gap-2">
								<span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
									{profile.toLowerCase()}
									{/* What the profile changes, derived from its config so
									    the tooltip can never drift from the behaviour. */}
									<InfoTip
										label={tTips("profileHelp", {
											profile: config.label,
										})}
									>
										<p>
											{tTips(
												`profileIntake.${config.intakeMode}`,
											)}
										</p>
										<p>
											{config.defaultTrack ===
											"CLASSIFIER"
												? tTips(
														"profileDefaultTrackClassifier",
													)
												: tTips("profileDefaultTrack", {
														track: DELIVERY_TRACK_META[
															config.defaultTrack
														].label,
													})}
										</p>
										<p>
											{config.stageTransitionsRequireReview
												? tTips("profileReviewed")
												: tTips("profileImmediate")}
										</p>
										<p>
											{config.customerOutcomesSurface
												? tTips("profileOutcomes")
												: tTips("profileNoOutcomes")}
										</p>
									</InfoTip>
								</span>
								<span
									aria-hidden
									className={cn(
										"flex size-5 shrink-0 items-center justify-center rounded-full border",
										selected
											? "border-primary bg-primary text-primary-foreground"
											: "border-border text-transparent",
									)}
								>
									<CheckIcon className="size-3" />
								</span>
							</div>
							<span className="font-semibold text-foreground">
								{config.label}
							</span>
							<span className="text-sm leading-5 text-muted-foreground">
								{config.description}
							</span>
						</label>
					);
				})}
			</div>
		</div>
	);
}
