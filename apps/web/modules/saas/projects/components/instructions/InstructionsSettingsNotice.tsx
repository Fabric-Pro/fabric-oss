"use client";

import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { AlertTriangleIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * The project's settings could not be read. Which source the instructions
 * come from, and so whether Upload is offered at all, is read from them, so
 * the actions are held back until they load. They used to vanish with no
 * explanation, which looks like missing permission rather than a failed read.
 */
export function InstructionsSettingsNotice({
	retrying,
	onRetry,
}: {
	retrying: boolean;
	onRetry: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.loadState");
	return (
		<Alert variant="warning" data-testid="instructions-settings-notice">
			<AlertTriangleIcon aria-hidden="true" />
			<AlertTitle>{t("settingsErrorTitle")}</AlertTitle>
			<AlertDescription className="flex flex-col items-start gap-2">
				<p>{t("settingsErrorBody")}</p>
				<Button
					size="sm"
					variant="outline"
					disabled={retrying}
					onClick={onRetry}
				>
					{t("retry")}
				</Button>
			</AlertDescription>
		</Alert>
	);
}
