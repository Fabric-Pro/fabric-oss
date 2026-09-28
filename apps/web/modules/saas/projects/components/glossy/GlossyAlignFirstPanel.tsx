"use client";

import { resolveBrandColor } from "@repo/utils/brand-colors";
import {
	BrandColorListField,
	parseBrandColorList,
} from "@saas/shared/components/BrandColorListField";
import { orpcClient } from "@shared/lib/orpc-client";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { Textarea } from "@ui/components/textarea";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import type { GlossyEdition } from "../../hooks/use-glossy-edition";
import {
	type RecipientBrandDraft,
	RecipientBrandFields,
	type RecipientLogoErrorCode,
	recipientBrandDraftFrom,
} from "../RecipientBrandFields";
import { glossyKindKey } from "./glossy-copy";
import type { GlossyLengthMode } from "./GlossyToolbar";

/** The server's bound on style direction (`GLOSSY_STYLE_DIRECTION_MAX_CHARS`). */
const STYLE_DIRECTION_MAX_CHARS = 500;
/** The server's bound on per-edition accent overrides. */
const MAX_ACCENTS = 3;

type DetectResult = Awaited<
	ReturnType<typeof orpcClient.projects.glossy.detect>
>;
export type GlossyDetection = Extract<DetectResult, { outcome: "detected" }>;
type Opportunity = GlossyDetection["opportunities"][number];

/** Align first's detection, as the page holds it. */
export type GlossyDetectionState =
	| { status: "detecting" }
	| { status: "failed" }
	| { status: "detected"; result: GlossyDetection };

/** What Align first sends to `projects.glossy.build` (R24). */
export type GlossyAlignFirstOptions = {
	mode: "align_first";
	lengthMode: GlossyLengthMode;
	styleDirection: string | null;
	preparerOverrides: { primary: string | null; accents: string[] } | null;
	detection: {
		contentHash: string;
		opportunities: Array<{ sectionKey: string; kind: Opportunity["kind"] }>;
	};
};

type GlossyAlignFirstPanelProps = {
	projectId: string;
	detection: GlossyDetectionState;
	onDetectAgain: () => void;
	lengthMode: GlossyLengthMode;
	onLengthModeChange: (lengthMode: GlossyLengthMode) => void;
	brand: GlossyEdition["brand"];
	lastOptions: NonNullable<GlossyEdition["edition"]>["lastOptions"] | null;
	/** An edition is published: the action reads Rebuild. */
	hasContent: boolean;
	/** A build runs or is starting. */
	buildBusy: boolean;
	/** The build answered `draftStale`: detection must run again. */
	draftStale: boolean;
	/** Start the build; the page handles every outcome. */
	onBuild: (options: GlossyAlignFirstOptions) => Promise<void>;
	/** The recipient brand was saved or changed underneath: reload it. */
	onRecipientChanged: () => Promise<unknown>;
	onCancel: () => void;
};

function opportunityId(opportunity: {
	sectionKey: string;
	kind: string;
}): string {
	return `${opportunity.sectionKey}\u0000${opportunity.kind}`;
}

function sameColors(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((color, i) => color === b[i]);
}

/**
 * Align first (Fizzy #2589, R24, R25, R33, R34; F2; AE9): one form, prefilled
 * by AI detection and the saved brands, that the editor confirms before
 * anything is generated.
 *
 * - The detected opportunities, each with its one-line reason, all selected;
 *   the reason is model output and renders as plain text (KTD13).
 * - Style direction, prefilled from the Brand kit guidance.
 * - The length, Brief by default.
 * - This edition's preparer colors, prefilled from the Brand kit; left as
 *   they are, nothing is recorded, so a later Brand kit change still applies.
 * - The recipient brand through `RecipientBrandFields`, remounted per saved
 *   version. A website fetch that fails leaves manual entry in place and
 *   never blocks the build (R34, AE9). A changed recipient brand is saved to
 *   the project before the build starts (F2), against the version it was
 *   read at.
 */
export function GlossyAlignFirstPanel({
	projectId,
	detection,
	onDetectAgain,
	lengthMode,
	onLengthModeChange,
	brand,
	lastOptions,
	hasContent,
	buildBusy,
	draftStale,
	onBuild,
	onRecipientChanged,
	onCancel,
}: GlossyAlignFirstPanelProps) {
	const t = useTranslations("projects.glossy.alignFirst");
	const tGlossy = useTranslations("projects.glossy");
	const idPrefix = useId();
	const headingRef = useRef<HTMLHeadingElement>(null);

	// Focus moves into the panel when it opens, so keyboard and screen-reader
	// users land on the form they asked for.
	useEffect(() => {
		headingRef.current?.focus();
	}, []);

	const defaultPrimary = resolveBrandColor(brand.preparer.brandColorName).hex;
	const defaultAccents = brand.preparer.accentColors;
	const overrides = lastOptions?.preparerOverrides ?? null;

	const [deselected, setDeselected] = useState<Set<string>>(new Set());
	// An Align-first build always records its style direction, a cleared one
	// as null; only without one does the Brand kit guidance prefill. Treating
	// that null as unset would bring the guidance back, and a build with it
	// would miss every cached extraction, since style direction is in the key.
	const [styleDirection, setStyleDirection] = useState(() =>
		(lastOptions?.mode === "align_first"
			? (lastOptions.styleDirection ?? "")
			: (brand.preparer.guidance ?? "")
		).slice(0, STYLE_DIRECTION_MAX_CHARS),
	);
	const [primaryColors, setPrimaryColors] = useState<string[]>(() => [
		overrides?.primary ?? defaultPrimary,
	]);
	const [accentColors, setAccentColors] = useState<string[]>(() => [
		...(overrides?.accents ?? defaultAccents),
	]);

	const recipientVersion = brand.recipientVersion;
	const [recipientDraft, setRecipientDraft] = useState<RecipientBrandDraft>(
		() => recipientBrandDraftFrom(brand.recipient),
	);
	const [recipientInitial, setRecipientInitial] =
		useState<RecipientBrandDraft>(recipientDraft);
	const [fieldsPending, setFieldsPending] = useState(false);
	const [logoError, setLogoError] = useState<RecipientLogoErrorCode | null>(
		null,
	);
	const [recipientConflict, setRecipientConflict] = useState(false);
	const [colorsInvalid, setColorsInvalid] = useState(false);
	const [submitting, setSubmitting] = useState(false);

	// A newer saved recipient brand replaces the draft (and remounts the
	// fields below): after this editor's own save, or after a conflict.
	useEffect(() => {
		const next = recipientBrandDraftFrom(brand.recipient);
		setRecipientDraft(next);
		setRecipientInitial(next);
		setLogoError(null);
	}, [recipientVersion]);

	const result = detection.status === "detected" ? detection.result : null;
	const suggestions =
		brand.recipient === null
			? (result?.recipientWebsiteSuggestions ?? [])
			: [];

	const busy = submitting || buildBusy;
	const selected =
		result?.opportunities.filter(
			(opportunity) => !deselected.has(opportunityId(opportunity)),
		) ?? [];

	const submit = async () => {
		if (!result) {
			return;
		}
		const primary = parseBrandColorList(primaryColors);
		const accents = parseBrandColorList(accentColors);
		const recipientColors = parseBrandColorList(recipientDraft.colors);
		if (!primary || !accents || !recipientColors) {
			setColorsInvalid(true);
			return;
		}
		setColorsInvalid(false);
		setRecipientConflict(false);
		setSubmitting(true);
		try {
			const recipientChanged =
				JSON.stringify(recipientDraft) !==
				JSON.stringify(recipientInitial);
			if (recipientChanged) {
				setLogoError(null);
				let saved: Awaited<
					ReturnType<typeof orpcClient.projects.recipientBrand.update>
				>;
				try {
					saved = await orpcClient.projects.recipientBrand.update({
						projectId,
						expectedVersion: recipientVersion,
						name: recipientDraft.name.trim() || null,
						website: recipientDraft.website.trim() || null,
						colors: recipientColors,
						logo:
							recipientDraft.logo.action === "replace"
								? {
										action: "replace",
										token: recipientDraft.logo.token,
									}
								: { action: recipientDraft.logo.action },
					});
				} catch (error) {
					toast.error(
						error instanceof Error && error.message
							? error.message
							: t("recipientSaveFailed"),
					);
					return;
				}
				if (saved.outcome === "conflict") {
					// Someone confirmed since this form was read: show theirs
					// rather than build over a change this editor never saw.
					setRecipientConflict(true);
					await onRecipientChanged();
					return;
				}
				if (saved.outcome === "logoRejected") {
					// The server discarded the refused upload; the token is spent.
					setLogoError(saved.code);
					setRecipientDraft((prev) => ({
						...prev,
						logo: { action: "keep" },
					}));
					return;
				}
				await onRecipientChanged();
			}

			const primaryColor = primary[0] ?? null;
			const unchanged =
				primaryColor === defaultPrimary &&
				sameColors(accents, defaultAccents);
			await onBuild({
				mode: "align_first",
				lengthMode,
				styleDirection: styleDirection.trim() || null,
				preparerOverrides: unchanged
					? null
					: { primary: primaryColor, accents },
				detection: {
					contentHash: result.contentHash,
					opportunities: selected.map((opportunity) => ({
						sectionKey: opportunity.sectionKey,
						kind: opportunity.kind,
					})),
				},
			});
		} finally {
			setSubmitting(false);
		}
	};

	const ids = {
		heading: `${idPrefix}-heading`,
		style: `${idPrefix}-style`,
		styleHelp: `${idPrefix}-style-help`,
		length: `${idPrefix}-length`,
	};

	return (
		<Card
			className="space-y-6 p-6"
			role="region"
			aria-labelledby={ids.heading}
		>
			<div className="space-y-1">
				<h2
					ref={headingRef}
					id={ids.heading}
					tabIndex={-1}
					className="font-semibold text-lg tracking-tight outline-none"
				>
					{t("title")}
				</h2>
				<p className="text-muted-foreground text-sm">
					{t("description")}
				</p>
			</div>

			{detection.status === "detecting" && (
				<output className="flex items-center gap-2 text-muted-foreground text-sm">
					<Loader2Icon
						className="size-4 animate-spin"
						aria-hidden="true"
					/>
					{t("detecting")}
				</output>
			)}

			{detection.status === "failed" && (
				<Alert variant="error" role="status">
					<AlertDescription className="mt-0 flex flex-wrap items-center gap-3">
						<span className="flex-1">{t("detectFailed")}</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={onDetectAgain}
						>
							{t("detectAgain")}
						</Button>
					</AlertDescription>
				</Alert>
			)}

			{draftStale && (
				<Alert variant="warning" role="status">
					<AlertDescription className="mt-0 flex flex-wrap items-center gap-3">
						<span className="flex-1">{t("draftStale")}</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={detection.status === "detecting"}
							onClick={onDetectAgain}
						>
							{t("detectAgain")}
						</Button>
					</AlertDescription>
				</Alert>
			)}

			{result && (
				<>
					<fieldset className="space-y-3">
						<legend className="font-medium text-sm">
							{t("opportunities")}
						</legend>
						{result.degraded ? (
							<p className="text-muted-foreground text-sm">
								{t("degraded")}
							</p>
						) : result.opportunities.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								{t("noOpportunities")}
							</p>
						) : (
							<>
								<p className="text-muted-foreground text-xs">
									{t("opportunitiesHelp")}
								</p>
								<ul className="space-y-3">
									{result.opportunities.map(
										(opportunity, index) => {
											const id =
												opportunityId(opportunity);
											const checkboxId = `${idPrefix}-opportunity-${index}`;
											return (
												<li
													key={id}
													className="flex items-start gap-3"
												>
													<Checkbox
														id={checkboxId}
														checked={
															!deselected.has(id)
														}
														disabled={busy}
														aria-describedby={`${checkboxId}-reason`}
														onCheckedChange={(
															checked,
														) =>
															setDeselected(
																(prev) => {
																	const next =
																		new Set(
																			prev,
																		);
																	if (
																		checked ===
																		true
																	) {
																		next.delete(
																			id,
																		);
																	} else {
																		next.add(
																			id,
																		);
																	}
																	return next;
																},
															)
														}
														className="mt-0.5"
													/>
													<div className="space-y-0.5">
														<Label
															htmlFor={checkboxId}
														>
															{t(
																"opportunityLabel",
																{
																	kind: tGlossy(
																		`visual.kinds.${glossyKindKey(opportunity.kind)}`,
																	),
																	section:
																		opportunity.heading ??
																		tGlossy(
																			"report.untitledSection",
																		),
																},
															)}
														</Label>
														{/* Model output: plain text, never markup (KTD13). */}
														<p
															id={`${checkboxId}-reason`}
															className="text-muted-foreground text-sm"
														>
															{opportunity.reason}
														</p>
													</div>
												</li>
											);
										},
									)}
								</ul>
							</>
						)}
					</fieldset>

					<div className="space-y-2">
						<Label htmlFor={ids.style}>{t("styleDirection")}</Label>
						<Textarea
							id={ids.style}
							value={styleDirection}
							maxLength={STYLE_DIRECTION_MAX_CHARS}
							placeholder={t("styleDirectionPlaceholder")}
							aria-describedby={ids.styleHelp}
							disabled={busy}
							onChange={(e) => setStyleDirection(e.target.value)}
						/>
						<p
							id={ids.styleHelp}
							className="text-muted-foreground text-xs"
						>
							{t("styleDirectionHelp")}
						</p>
					</div>

					<div className="space-y-3">
						<p id={ids.length} className="font-medium text-sm">
							{tGlossy("toolbar.length")}
						</p>
						<RadioGroup
							aria-labelledby={ids.length}
							value={lengthMode}
							onValueChange={(value) =>
								onLengthModeChange(value as GlossyLengthMode)
							}
							disabled={busy}
							className="gap-3"
						>
							{(["brief", "standard"] as const).map((value) => {
								const itemId = `${idPrefix}-length-${value}`;
								return (
									<div
										key={value}
										className="flex items-start gap-2"
									>
										<RadioGroupItem
											id={itemId}
											value={value}
											aria-describedby={`${itemId}-help`}
											className="mt-0.5"
										/>
										<div className="space-y-0.5">
											<Label
												htmlFor={itemId}
												className="font-normal"
											>
												{tGlossy(
													`toolbar.lengths.${value}`,
												)}
											</Label>
											<p
												id={`${itemId}-help`}
												className="text-muted-foreground text-xs"
											>
												{tGlossy(
													`toolbar.lengths.${value}Help`,
												)}
											</p>
										</div>
									</div>
								);
							})}
						</RadioGroup>
					</div>

					<div className="space-y-4">
						<div className="space-y-1">
							<h3 className="font-medium text-base">
								{t("preparer")}
							</h3>
							<p className="text-muted-foreground text-xs">
								{t("preparerHelp")}
							</p>
						</div>
						<BrandColorListField
							id={`${idPrefix}-primary`}
							legend={t("primaryColor")}
							colors={primaryColors}
							max={1}
							disabled={busy}
							labels={{
								hex: () => t("primaryHex"),
								picker: () => t("primaryPicker"),
								remove: () => t("primaryRemove"),
								add: t("addColor"),
								invalid: t("invalidColor"),
								empty: t("noColors"),
							}}
							onChange={setPrimaryColors}
						/>
						<BrandColorListField
							id={`${idPrefix}-accents`}
							legend={t("accentColors")}
							colors={accentColors}
							max={MAX_ACCENTS}
							disabled={busy}
							labels={{
								hex: (position) => t("accentHex", { position }),
								picker: (position) =>
									t("accentPicker", { position }),
								remove: (position) =>
									t("accentRemove", { position }),
								add: t("addColor"),
								invalid: t("invalidColor"),
								empty: t("noColors"),
							}}
							onChange={setAccentColors}
						/>
					</div>

					<div className="space-y-4">
						<div className="space-y-1">
							<h3 className="font-medium text-base">
								{t("recipient")}
							</h3>
							<p className="text-muted-foreground text-xs">
								{t("recipientHelp")}
							</p>
						</div>
						{recipientConflict && (
							<Alert variant="warning" role="status">
								<AlertDescription className="mt-0">
									{t("recipientConflict")}
								</AlertDescription>
							</Alert>
						)}
						{suggestions.length > 0 && (
							<div className="flex flex-wrap items-center gap-2 text-sm">
								<span className="text-muted-foreground">
									{t("suggestedWebsites")}
								</span>
								{suggestions.map((website) => (
									<Button
										key={website}
										type="button"
										variant="outline"
										size="sm"
										disabled={busy || fieldsPending}
										onClick={() =>
											setRecipientDraft((prev) => ({
												...prev,
												website,
											}))
										}
									>
										{t("useWebsite", { website })}
									</Button>
								))}
							</div>
						)}
						<RecipientBrandFields
							key={recipientVersion}
							projectId={projectId}
							value={recipientDraft}
							onChange={setRecipientDraft}
							currentLogoUrl={brand.recipient?.logoUrl ?? null}
							busy={busy}
							logoError={logoError}
							idPrefix={`${idPrefix}-recipient`}
							onPendingChange={setFieldsPending}
						/>
					</div>
				</>
			)}

			<div className="flex flex-wrap items-center gap-3">
				{result && (
					<Button
						type="button"
						loading={busy}
						disabled={fieldsPending || draftStale}
						onClick={submit}
					>
						{hasContent ? t("rebuild") : t("build")}
					</Button>
				)}
				<Button
					type="button"
					variant="outline"
					disabled={submitting}
					onClick={onCancel}
				>
					{t("cancel")}
				</Button>
				{colorsInvalid && (
					<p role="alert" className="text-destructive text-sm">
						{t("fixColors")}
					</p>
				)}
			</div>
		</Card>
	);
}
