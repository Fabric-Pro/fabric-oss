"use client";

import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import {
	DELIVERY_REPORT_STARTERS,
	getDeliveryReportStarter,
} from "../lib/delivery-report-starters";

/** A guided entry into the existing report builder, not another template catalog. */
export function DeliveryReportStarterPicker({
	reportBasePath,
}: {
	reportBasePath: string;
}) {
	const t = useTranslations("deliveryStarters");
	const id = useId();
	const [selected, setSelected] = useState<string>(
		DELIVERY_REPORT_STARTERS[0].id,
	);
	const starter =
		getDeliveryReportStarter(selected) ?? DELIVERY_REPORT_STARTERS[0];
	return (
		<section
			data-onboarding-target="delivery-report-starters"
			aria-labelledby={`${id}-title`}
			className="space-y-3 border-b pb-6 mb-6"
		>
			<div className="space-y-1">
				<h2 id={`${id}-title`} className="text-lg font-semibold">
					{t("title")}
				</h2>
				<p className="text-sm text-muted-foreground max-w-prose">
					{t("description")}
				</p>
			</div>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
				<div className="w-full space-y-1.5 sm:max-w-sm">
					<Label htmlFor={id}>{t("label")}</Label>
					<Select value={selected} onValueChange={setSelected}>
						<SelectTrigger id={id}>
							<SelectValue>
								{t(`names.${starter.id}`)}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{DELIVERY_REPORT_STARTERS.map((item) => (
								<SelectItem key={item.id} value={item.id}>
									{t(`names.${item.id}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<Button asChild>
					<Link href={`${reportBasePath}/new?starter=${starter.id}`}>
						{t("action")}
					</Link>
				</Button>
				<Button asChild variant="link">
					<Link href={reportBasePath}>{t("savedReports")}</Link>
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">{t("notice")}</p>
		</section>
	);
}
