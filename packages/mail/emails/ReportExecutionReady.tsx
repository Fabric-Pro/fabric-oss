import { Heading, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps, MailTranslator } from "../types";

export function ReportExecutionReady({
	instanceName,
	url,
	locale,
	translations,
}: { instanceName: string; url: string } & BaseMailProps) {
	const t = createTranslator({ locale, messages: translations });
	return (
		<Wrapper>
			<Heading
				as="h2"
				className="text-lg font-semibold text-foreground m-0 mb-3"
			>
				{t("mail.reportExecutionReady.headline")}
			</Heading>
			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.reportExecutionReady.body", { instanceName })}
			</Text>
			<PrimaryButton href={url}>
				{t("mail.reportExecutionReady.cta")}
			</PrimaryButton>
		</Wrapper>
	);
}

ReportExecutionReady.resolveSubject = (
	ctx: Record<string, unknown>,
	t: MailTranslator,
) =>
	t("mail.reportExecutionReady.subject", {
		instanceName: String(ctx.instanceName ?? ""),
	});

ReportExecutionReady.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	instanceName: "Q3 Board Report",
	url: "#",
};

export default ReportExecutionReady;
