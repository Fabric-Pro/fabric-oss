"use client";

import {
	PROJECT_BILLING_MODEL_LABELS,
	PROJECT_BILLING_MODEL_VALUES,
} from "@repo/utils/time-tracking";
import { Button } from "@ui/components/button";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import { Switch } from "@ui/components/switch";
import { cn } from "@ui/lib";
import { BarChart3Icon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId } from "react";
import {
	useCanViewProjectTimeReport,
	useProjectTimeSettings,
} from "../hooks/use-time-settings";
import {
	BILLABLE_DEFAULT_CHOICES,
	type BillableDefaultChoice,
	billableDefaultChoice,
	billableDefaultFromChoice,
	isBillableDefaultChoice,
	isProjectBillingModel,
	organizationDefaultBillable,
	startStopSwitch,
} from "../lib/time-settings-model";
import { InfoHint } from "./InfoHint";
import { TimeSettingRow, TimeSettingsSection } from "./TimeSettingsSection";

/**
 * Project settings → Time tracking: the project's type and the rules a new
 * entry on it starts from. Saves on change. Read-only for members who cannot
 * edit the project's settings, and every control waits for the first load.
 */
export function ProjectTimeTrackingSettings({
	projectId,
	canEdit,
	reportHref,
}: {
	projectId: string;
	canEdit: boolean;
	/** The project's time report, linked only for those who may read it. */
	reportHref: string;
}) {
	const t = useTranslations("timeTracking.settings");
	const id = useId();
	const { settings, isPending, isError, update } =
		useProjectTimeSettings(projectId);
	const canViewReport = useCanViewProjectTimeReport(projectId);

	const disabled = !canEdit || settings === undefined;
	const startStop = settings ? startStopSwitch(settings) : null;
	const organizationBillable = settings
		? organizationDefaultBillable(settings.organization.timeDefaultBillable)
		: true;
	const choiceLabel = (choice: BillableDefaultChoice) => {
		switch (choice) {
			case "inherit":
				return t("billableInherit", {
					value: organizationBillable
						? t("billable")
						: t("notBillable"),
				});
			case "billable":
				return t("billable");
			case "not-billable":
				return t("notBillable");
			default: {
				const unhandled: never = choice;
				throw new Error(
					`Unhandled billable default: ${String(unhandled)}`,
				);
			}
		}
	};

	return (
		<div className="max-w-3xl space-y-6">
			<div className="space-y-1 border-border border-b pb-4">
				<div className="flex items-center gap-1">
					<h2 className="font-semibold text-xl">{t("title")}</h2>
					<InfoHint label={t("aboutTitle")}>{t("about")}</InfoHint>
				</div>
				{canEdit ? null : (
					<p className="text-muted-foreground text-sm">
						{t("readOnly")}
					</p>
				)}
			</div>

			{isError ? (
				<p className="text-muted-foreground text-sm">
					{t("loadFailed")}
				</p>
			) : (
				<>
					<TimeSettingsSection
						headingId={`${id}-type`}
						title={t("projectType")}
						hintLabel={t("aboutProjectTypeTitle")}
						hint={t("aboutProjectType")}
					>
						{isPending ? (
							<Skeleton className="h-[106px] w-full rounded-lg" />
						) : (
							<RadioGroup
								aria-labelledby={`${id}-type`}
								value={settings?.billingModel}
								disabled={disabled}
								onValueChange={(value) => {
									if (isProjectBillingModel(value)) {
										update({ billingModel: value });
									}
								}}
								className="gap-0 overflow-hidden rounded-lg border border-border bg-card"
							>
								{PROJECT_BILLING_MODEL_VALUES.map((model) => (
									<label
										key={model}
										htmlFor={`${id}-${model}`}
										className={cn(
											"flex items-center gap-3 border-border border-t px-4 py-3.5 first:border-t-0",
											"motion-safe:transition-colors motion-safe:duration-150",
											disabled
												? "cursor-not-allowed"
												: "cursor-pointer hover:bg-muted/50",
											settings?.billingModel === model &&
												"bg-primary/[0.06]",
										)}
									>
										<RadioGroupItem
											id={`${id}-${model}`}
											value={model}
										/>
										<span className="font-medium text-sm">
											{
												PROJECT_BILLING_MODEL_LABELS[
													model
												]
											}
										</span>
									</label>
								))}
							</RadioGroup>
						)}
					</TimeSettingsSection>

					<TimeSettingsSection
						headingId={`${id}-rules`}
						title={t("entryRules")}
						hintLabel={t("aboutEntryRulesTitle")}
						hint={t("aboutEntryRules")}
					>
						<div className="rounded-lg border border-border bg-card">
							<TimeSettingRow
								labelId={`${id}-start-stop`}
								label={t("requireStartStop")}
							>
								{startStop?.locked ? (
									<span
										id={`${id}-start-stop-locked`}
										className="text-muted-foreground text-xs"
									>
										{t("setByOrganization")}
									</span>
								) : null}
								<Switch
									aria-labelledby={`${id}-start-stop`}
									aria-describedby={
										startStop?.locked
											? `${id}-start-stop-locked`
											: undefined
									}
									checked={startStop?.checked ?? false}
									disabled={disabled || startStop?.locked}
									onCheckedChange={(checked) =>
										update({
											timeRequireStartStop: checked,
										})
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
											? billableDefaultChoice(
													settings.timeDefaultBillable,
												)
											: undefined
									}
									disabled={disabled}
									onValueChange={(value) => {
										if (isBillableDefaultChoice(value)) {
											update({
												timeDefaultBillable:
													billableDefaultFromChoice(
														value,
													),
											});
										}
									}}
								>
									<SelectTrigger
										aria-labelledby={`${id}-billable`}
										className="w-60"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{BILLABLE_DEFAULT_CHOICES.map(
											(choice) => (
												<SelectItem
													key={choice}
													value={choice}
												>
													{choiceLabel(choice)}
												</SelectItem>
											),
										)}
									</SelectContent>
								</Select>
							</TimeSettingRow>
						</div>
					</TimeSettingsSection>

					{canViewReport ? (
						<Button variant="outline" asChild>
							<Link href={reportHref}>
								<BarChart3Icon aria-hidden="true" />
								{t("viewReport")}
							</Link>
						</Button>
					) : null}
				</>
			)}
		</div>
	);
}
