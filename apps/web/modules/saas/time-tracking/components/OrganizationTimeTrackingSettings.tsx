"use client";

import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { useOrganizationTimeSettings } from "../hooks/use-time-settings";
import { organizationDefaultBillable } from "../lib/time-settings-model";
import { TimeSettingRow, TimeSettingsSection } from "./TimeSettingsSection";

const BILLABLE = "billable";
const NOT_BILLABLE = "not-billable";

/**
 * Organization settings → Time tracking: the entry rules every project starts
 * from. Saves on change. Read-only for members who cannot update the
 * organization, and every control waits for the first load.
 */
export function OrganizationTimeTrackingSettings({
	organizationId,
	canEdit,
}: {
	organizationId: string;
	canEdit: boolean;
}) {
	const t = useTranslations("timeTracking.settings");
	const id = useId();
	const { settings, isError, update } =
		useOrganizationTimeSettings(organizationId);
	const disabled = !canEdit || settings === undefined;

	if (isError) {
		return (
			<p className="text-muted-foreground text-sm">{t("loadFailed")}</p>
		);
	}

	return (
		<div className="max-w-3xl space-y-6">
			{canEdit ? null : (
				<p className="text-muted-foreground text-sm">{t("readOnly")}</p>
			)}
			<TimeSettingsSection
				headingId={`${id}-rules`}
				title={t("entryRules")}
				hintLabel={t("aboutEntryRulesTitle")}
				hint={t("aboutOrganizationEntryRules")}
			>
				<div className="rounded-lg border border-border bg-card">
					<TimeSettingRow
						labelId={`${id}-start-stop`}
						label={t("requireStartStop")}
					>
						<Switch
							aria-labelledby={`${id}-start-stop`}
							checked={settings?.timeRequireStartStop ?? false}
							disabled={disabled}
							onCheckedChange={(checked) =>
								update({ timeRequireStartStop: checked })
							}
						/>
					</TimeSettingRow>
					<TimeSettingRow
						labelId={`${id}-billable`}
						label={t("defaultBillable")}
					>
						<Select
							value={
								settings
									? organizationDefaultBillable(
											settings.timeDefaultBillable,
										)
										? BILLABLE
										: NOT_BILLABLE
									: undefined
							}
							disabled={disabled}
							onValueChange={(value) =>
								update({
									timeDefaultBillable: value === BILLABLE,
								})
							}
						>
							<SelectTrigger
								aria-labelledby={`${id}-billable`}
								className="w-60"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={BILLABLE}>
									{t("billable")}
								</SelectItem>
								<SelectItem value={NOT_BILLABLE}>
									{t("notBillable")}
								</SelectItem>
							</SelectContent>
						</Select>
					</TimeSettingRow>
				</div>
			</TimeSettingsSection>
		</div>
	);
}
