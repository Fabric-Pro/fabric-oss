"use client";

import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { ExternalLinkIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { isLinkableAutomationUrl } from "./automation-link";

/**
 * The automation link: the identifier the team links by (`ref`), the spec file
 * that holds it, and a CI/report deep link. Presentational — the parent owns the
 * form state and the rule that a first ref marks the case AUTOMATED (see
 * `statusAfterRefEdit`), so what the reader sees in the status select is what
 * gets saved.
 *
 * Rendered only for a case that claims some automation intent; a NOT_AUTOMATED
 * case has nothing to link, so the parent keeps the whole block out of the form.
 */
export function AutomationLinkFields({
	automationRef,
	automationFilePath,
	automationExternalUrl,
	onRefChange,
	onFilePathChange,
	onExternalUrlChange,
	disabled,
}: {
	automationRef: string;
	automationFilePath: string;
	automationExternalUrl: string;
	onRefChange: (value: string) => void;
	onFilePathChange: (value: string) => void;
	onExternalUrlChange: (value: string) => void;
	disabled?: boolean;
}) {
	const t = useTranslations("projects.testCases");

	const urlLinkable = isLinkableAutomationUrl(automationExternalUrl);
	// Only a non-empty, non-http(s) value is an error — blank is how the link is
	// cleared, which the write path accepts.
	const urlInvalid = automationExternalUrl.trim().length > 0 && !urlLinkable;

	return (
		<div className="space-y-4 rounded-lg border bg-muted/30 p-4">
			<div className="space-y-1.5">
				<Label htmlFor="tc-automation-ref">
					{t("fields.automationRef")}
				</Label>
				<Input
					id="tc-automation-ref"
					value={automationRef}
					onChange={(e) => onRefChange(e.target.value)}
					disabled={disabled}
					placeholder={t("fields.automationRefPlaceholder")}
					className="font-mono text-xs"
					aria-describedby="tc-automation-ref-hint"
				/>
				<p
					id="tc-automation-ref-hint"
					className="text-muted-foreground text-xs"
				>
					{t("fields.automationRefHint")}
				</p>
			</div>

			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="tc-automation-path">
						{t("fields.automationFilePath")}
					</Label>
					<Input
						id="tc-automation-path"
						value={automationFilePath}
						onChange={(e) => onFilePathChange(e.target.value)}
						disabled={disabled}
						placeholder={t("fields.automationFilePathPlaceholder")}
						className="font-mono text-xs"
					/>
				</div>

				<div className="space-y-1.5">
					<div className="flex items-center justify-between gap-2">
						<Label htmlFor="tc-automation-url">
							{t("fields.automationUrl")}
						</Label>
						{urlLinkable && (
							<a
								href={automationExternalUrl.trim()}
								target="_blank"
								rel="noreferrer"
								aria-label={t("fields.automationUrlOpenAria")}
								className="inline-flex items-center gap-1 rounded text-primary text-xs transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<ExternalLinkIcon
									aria-hidden="true"
									className="size-3.5"
								/>
								{t("fields.automationUrlOpen")}
							</a>
						)}
					</div>
					<Input
						id="tc-automation-url"
						type="url"
						inputMode="url"
						value={automationExternalUrl}
						onChange={(e) => onExternalUrlChange(e.target.value)}
						disabled={disabled}
						placeholder={t("fields.automationUrlPlaceholder")}
						aria-invalid={urlInvalid}
						aria-describedby={
							urlInvalid ? "tc-automation-url-error" : undefined
						}
					/>
					{urlInvalid && (
						<p
							id="tc-automation-url-error"
							role="alert"
							className="text-destructive text-xs"
						>
							{t("fields.automationUrlInvalid")}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
