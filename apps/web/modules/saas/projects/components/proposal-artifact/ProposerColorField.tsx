"use client";

import type { ThemeTokenSource } from "@repo/utils/proposal-artifact/theme-tokens";
import { BrandColorListField } from "@saas/shared/components/BrandColorListField";
import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";
import { BrandSourceChip, proposerSourceLabel } from "./BrandSourceChip";
import {
	hasEntries,
	PROPOSAL_STYLE_MAX_ACCENTS,
	type ProposerColorKind,
	type ProposerSources,
	proposerColorSources,
} from "./proposal-style-model";

/**
 * One proposer colour field of the Style tab, the primary or the accents:
 * the document's own entries, then where the value comes from once the
 * sources have loaded. Without them the field stays editable, without the
 * source line.
 */
export function ProposerColorField({
	kind,
	id,
	entries,
	proposer,
	disabled,
	onChange,
}: {
	kind: ProposerColorKind;
	id: string;
	entries: string[];
	/** Null while the sources load, or after they fail. */
	proposer: ProposerSources | null;
	disabled: boolean;
	onChange: (entries: string[]) => void;
}) {
	const t = useTranslations("projects.proposalArtifact.style");
	const sources = proposer
		? proposerColorSources(kind, entries, proposer)
		: null;
	const field =
		kind === "primary"
			? {
					legend: t("primaryColor"),
					description: undefined,
					max: 1,
					labels: {
						hex: () => t("primaryHex"),
						picker: () => t("primaryPicker"),
						remove: () => t("primaryRemove"),
					},
				}
			: {
					legend: t("accentColors"),
					description: t("accentColorsHelp", {
						max: PROPOSAL_STYLE_MAX_ACCENTS,
					}),
					max: PROPOSAL_STYLE_MAX_ACCENTS,
					labels: {
						hex: (position: number) => t("accentHex", { position }),
						picker: (position: number) =>
							t("accentPicker", { position }),
						remove: (position: number) =>
							t("accentRemove", { position }),
					},
				};

	return (
		<div className="space-y-2">
			<BrandColorListField
				id={id}
				legend={field.legend}
				description={field.description}
				colors={entries}
				max={field.max}
				disabled={disabled}
				labels={{
					...field.labels,
					add: t("addColor"),
					invalid: t("invalidColor"),
					empty: t("noColors"),
				}}
				onChange={onChange}
			/>
			{sources && (
				<ColorSource
					kind={kind}
					overridden={hasEntries(entries)}
					inherited={{
						source: sources.inherited.source,
						text: sources.inherited.value.join(", "),
					}}
					alternatives={sources.alternatives.map((alternative) => ({
						source: alternative.source,
						text: alternative.value.join(", "),
						use: () => onChange([...alternative.value]),
					}))}
					disabled={disabled}
					onUseInherited={() => onChange([])}
				/>
			)}
		</div>
	);
}

/**
 * Where a proposer colour comes from, under its field: "Set for this
 * document" with a way back to the inherited value, or the inherited value
 * with its source. Then each other value a source holds, to copy into the
 * draft. Every action names its field and value, since the primary and the
 * accents each offer the same ones.
 */
function ColorSource({
	kind,
	overridden,
	inherited,
	alternatives,
	disabled,
	onUseInherited,
}: {
	kind: ProposerColorKind;
	overridden: boolean;
	inherited: { source: ThemeTokenSource; text: string };
	alternatives: Array<{
		source: ThemeTokenSource;
		text: string;
		use: () => void;
	}>;
	disabled: boolean;
	onUseInherited: () => void;
}) {
	const t = useTranslations("projects.proposalArtifact.style");
	const fieldName = t(`fields.${kind}`);
	const sourceName = (source: ThemeTokenSource) =>
		t(`sources.${proposerSourceLabel(source)}`);

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				{overridden ? (
					<>
						<BrandSourceChip label="document" />
						{!disabled && (
							<Button
								type="button"
								variant="link"
								size="sm"
								className="h-auto px-0"
								aria-label={t("useInheritedLabel", {
									field: fieldName,
									value: inherited.text,
									source: sourceName(inherited.source),
								})}
								onClick={onUseInherited}
							>
								{t("useInherited")}
							</Button>
						)}
					</>
				) : (
					<>
						<BrandSourceChip
							label={proposerSourceLabel(inherited.source)}
						/>
						<span className="text-muted-foreground">
							{t("inherited", { value: inherited.text })}
						</span>
					</>
				)}
			</div>
			{alternatives.length > 0 && (
				<ul className="space-y-1">
					{alternatives.map((alternative) => (
						<li
							key={alternative.source}
							className="flex flex-wrap items-center gap-2 text-sm"
						>
							<span className="text-muted-foreground">
								{t("alternative", {
									source: sourceName(alternative.source),
									value: alternative.text,
								})}
							</span>
							{!disabled && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									aria-label={t("useAlternativeLabel", {
										field: fieldName,
										value: alternative.text,
										source: sourceName(alternative.source),
									})}
									onClick={alternative.use}
								>
									{t("useAlternative")}
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
