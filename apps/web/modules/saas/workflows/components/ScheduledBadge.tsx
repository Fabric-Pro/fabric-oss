"use client";

import { Badge } from "@ui/components/badge";
import { ClockIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/** Marks a workflow that runs on a schedule rather than when someone starts it. */
export function ScheduledBadge() {
	const t = useTranslations("workflows.list");

	return (
		<Badge variant="info" title={t("scheduledTitle")}>
			<ClockIcon aria-hidden="true" />
			{t("scheduled")}
		</Badge>
	);
}
