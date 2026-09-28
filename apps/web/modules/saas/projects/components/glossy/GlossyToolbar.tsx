"use client";

import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { DownloadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";

export type GlossyBuildMode = "roll_the_dice" | "align_first";
export type GlossyLengthMode = "brief" | "standard";
export type GlossyDownloadFormat = "pdf" | "docx";

const MODES: readonly GlossyBuildMode[] = ["roll_the_dice", "align_first"];
const LENGTHS: readonly GlossyLengthMode[] = ["brief", "standard"];

export type GlossyPrimaryAction = {
	label: string;
	onClick: () => void;
	disabled: boolean;
	loading: boolean;
};

type GlossyToolbarProps = {
	canEdit: boolean;
	mode: GlossyBuildMode;
	onModeChange: (mode: GlossyBuildMode) => void;
	lengthMode: GlossyLengthMode;
	onLengthModeChange: (lengthMode: GlossyLengthMode) => void;
	/** The Align-first panel carries its own length field while it is open. */
	showLength: boolean;
	/** Mode and length are held still while a build runs or starts. */
	optionsDisabled: boolean;
	/** Build, Rebuild, Retry, or Align first; null hides it. */
	primary: GlossyPrimaryAction | null;
	/** There is a published edition to download. */
	canDownload: boolean;
	downloading: GlossyDownloadFormat | null;
	onDownload: (format: GlossyDownloadFormat) => void;
};

/**
 * The Glossy page's toolbar (Fizzy #2589, R23, R24, R36): the build mode, the
 * length, the build action, and the PDF and DOCX downloads. Editors get all
 * of it; everyone else gets the downloads only (R4, R5, AE7).
 */
export function GlossyToolbar({
	canEdit,
	mode,
	onModeChange,
	lengthMode,
	onLengthModeChange,
	showLength,
	optionsDisabled,
	primary,
	canDownload,
	downloading,
	onDownload,
}: GlossyToolbarProps) {
	const t = useTranslations("projects.glossy.toolbar");
	const idPrefix = useId();
	const modeLabelId = `${idPrefix}-mode`;
	const lengthLabelId = `${idPrefix}-length`;

	return (
		<Card className="flex flex-col gap-6 p-6 lg:flex-row lg:items-start lg:justify-between">
			{canEdit ? (
				<div className="flex flex-col gap-6 sm:flex-row sm:gap-10">
					<div className="space-y-3">
						<p id={modeLabelId} className="font-medium text-sm">
							{t("mode")}
						</p>
						<RadioGroup
							aria-labelledby={modeLabelId}
							value={mode}
							onValueChange={(value) =>
								onModeChange(value as GlossyBuildMode)
							}
							disabled={optionsDisabled}
							className="gap-3"
						>
							{MODES.map((value) => (
								<OptionItem
									key={value}
									id={`${idPrefix}-mode-${value}`}
									value={value}
									label={t(`modes.${value}`)}
									help={t(`modes.${value}Help`)}
								/>
							))}
						</RadioGroup>
					</div>
					{showLength && (
						<div className="space-y-3">
							<p
								id={lengthLabelId}
								className="font-medium text-sm"
							>
								{t("length")}
							</p>
							<RadioGroup
								aria-labelledby={lengthLabelId}
								value={lengthMode}
								onValueChange={(value) =>
									onLengthModeChange(
										value as GlossyLengthMode,
									)
								}
								disabled={optionsDisabled}
								className="gap-3"
							>
								{LENGTHS.map((value) => (
									<OptionItem
										key={value}
										id={`${idPrefix}-length-${value}`}
										value={value}
										label={t(`lengths.${value}`)}
										help={t(`lengths.${value}Help`)}
									/>
								))}
							</RadioGroup>
						</div>
					)}
				</div>
			) : (
				<p className="text-muted-foreground text-sm">
					{t("viewerNote")}
				</p>
			)}

			<div className="flex flex-wrap items-center gap-2 lg:justify-end">
				{canEdit && primary && (
					<Button
						type="button"
						loading={primary.loading}
						disabled={primary.disabled}
						onClick={primary.onClick}
					>
						{primary.label}
					</Button>
				)}
				<Button
					type="button"
					variant="outline"
					loading={downloading === "pdf"}
					disabled={!canDownload || downloading !== null}
					onClick={() => onDownload("pdf")}
				>
					<DownloadIcon className="size-4" aria-hidden="true" />
					{t("downloadPdf")}
				</Button>
				<Button
					type="button"
					variant="outline"
					loading={downloading === "docx"}
					disabled={!canDownload || downloading !== null}
					onClick={() => onDownload("docx")}
				>
					<DownloadIcon className="size-4" aria-hidden="true" />
					{t("downloadDocx")}
				</Button>
			</div>
		</Card>
	);
}

function OptionItem({
	id,
	value,
	label,
	help,
}: {
	id: string;
	value: string;
	label: string;
	help: string;
}) {
	return (
		<div className="flex items-start gap-2">
			<RadioGroupItem
				id={id}
				value={value}
				aria-describedby={`${id}-help`}
				className="mt-0.5"
			/>
			<div className="space-y-0.5">
				<Label htmlFor={id} className="font-normal">
					{label}
				</Label>
				<p id={`${id}-help`} className="text-muted-foreground text-xs">
					{help}
				</p>
			</div>
		</div>
	);
}
