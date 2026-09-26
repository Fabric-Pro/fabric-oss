"use client";

import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Checkbox } from "@ui/components/checkbox";
import { AlertTriangleIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * The "publish now and scan afterwards" choice (Fizzy #2737), shared by the
 * upload dialog and the add-file dialog so both state the risk in the same
 * words and gate on the same acknowledgement.
 *
 * Publishing before the scan is a way of publishing, so the option is only
 * live while the dialog's own "publish as soon as it passes checks" box is
 * ticked; the caller combines the two (`publishOnReady && checked`) into what
 * it sends, and the server refuses the flag without `publishOnReady` anyway.
 * Once ticked, the warning and its acknowledgement appear, and the caller
 * keeps its submit button disabled until `acknowledged`.
 *
 * Rendered only for a member who may publish (INSTRUCTION_UPDATE): the server
 * re-checks that permission at begin/derive and again, for the member who
 * acknowledged, immediately before the version is published.
 */
export function PublishBeforeScanOption({
	idPrefix,
	publishOnReady,
	checked,
	onCheckedChange,
	acknowledged,
	onAcknowledgedChange,
	disabled = false,
}: {
	/** Distinguishes the two dialogs' checkbox ids. */
	idPrefix: string;
	/** The dialog's "publish as soon as it passes checks" choice. */
	publishOnReady: boolean;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	acknowledged: boolean;
	onAcknowledgedChange: (acknowledged: boolean) => void;
	disabled?: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.publishBeforeScan");
	const active = publishOnReady && checked;
	const optionId = `${idPrefix}-publish-before-scan`;
	const acknowledgeId = `${idPrefix}-publish-before-scan-acknowledge`;
	return (
		<div className="flex flex-col gap-2">
			<label
				htmlFor={optionId}
				className="flex items-center gap-2 text-muted-foreground text-sm"
			>
				<Checkbox
					id={optionId}
					checked={active}
					disabled={disabled || !publishOnReady}
					onCheckedChange={(v) => onCheckedChange(v === true)}
				/>
				{t("label")}
			</label>
			{publishOnReady ? null : (
				<p className="text-muted-foreground text-xs">
					{t("requiresPublishOnReady")}
				</p>
			)}
			{active ? (
				<Alert variant="error">
					<AlertTriangleIcon aria-hidden="true" />
					<AlertTitle>{t("warningTitle")}</AlertTitle>
					<AlertDescription>
						<p>{t("warningBody")}</p>
						<label
							htmlFor={acknowledgeId}
							className="mt-2 flex items-center gap-2 text-foreground"
						>
							<Checkbox
								id={acknowledgeId}
								checked={acknowledged}
								disabled={disabled}
								onCheckedChange={(v) =>
									onAcknowledgedChange(v === true)
								}
							/>
							{t("acknowledge")}
						</label>
					</AlertDescription>
				</Alert>
			) : null}
		</div>
	);
}
