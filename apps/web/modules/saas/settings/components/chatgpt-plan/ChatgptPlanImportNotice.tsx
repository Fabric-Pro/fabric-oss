"use client";

import { Alert, AlertDescription } from "@ui/components/alert";
import { useTranslations } from "next-intl";
import { useChatgptPlanStatus } from "./chatgpt-plan-status";

/**
 * A heads-up in the dialogs that link a channel or a meeting series, shown
 * while the organization's shared ChatGPT plan accounts run its background
 * jobs (Fizzy #2770 F3): the first history import is not throttled, so it can
 * take a large share of a shared plan's five-hour window.
 */
export function ChatgptPlanImportNotice() {
	const t = useTranslations("settings.chatgptPlanPool");
	const { query } = useChatgptPlanStatus();
	if (query.data?.sharedPlansServeBackground !== true) {
		return null;
	}
	return (
		<Alert data-testid="chatgpt-plan-import-notice" variant="warning">
			<AlertDescription>{t("importHeadsUp")}</AlertDescription>
		</Alert>
	);
}
