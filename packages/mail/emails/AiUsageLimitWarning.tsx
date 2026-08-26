import { Heading, Hr, Link, Section, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps, MailTranslator } from "../types";

/**
 * Email sent when an AI usage limit crosses 80% within its current window.
 * Calm/advisory tone per `fabric/standards/ai/ai-copy-tone.md` — no
 * "URGENT", no all-caps, treat it like a billing heads-up rather than a
 * fire alarm.
 */
export function AiUsageLimitWarning({
	limitName,
	dimension,
	window,
	used,
	max,
	manageLimitsUrl,
	locale,
	translations,
}: {
	limitName: string | null;
	dimension: "TOKENS" | "SPEND_USD";
	window: "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";
	used: string;
	max: string;
	/** Reserved so future template branches can vary copy by HARD vs SOFT — ignored today. */
	enforcement?: "HARD" | "SOFT";
	manageLimitsUrl: string;
} & BaseMailProps) {
	const t = createTranslator({
		locale,
		messages: translations,
	});

	const heading = limitName
		? t("mail.aiUsageLimitWarning.headingWithName", { limitName })
		: t("mail.aiUsageLimitWarning.heading");

	const usageLine = formatUsageLine(t, dimension, window, used, max);

	return (
		<Wrapper>
			<Heading
				as="h2"
				className="text-lg font-semibold text-foreground m-0 mb-3"
			>
				{heading}
			</Heading>

			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.aiUsageLimitWarning.body")}
			</Text>

			<Section className="my-6 rounded-md bg-surface py-4 px-6">
				<Text className="text-sm text-foreground leading-relaxed m-0">
					{usageLine}
				</Text>
			</Section>

			<PrimaryButton href={manageLimitsUrl}>
				{t("mail.aiUsageLimitWarning.manageButton")}
			</PrimaryButton>

			<Hr className="my-6 border-border" />

			<Text className="text-xs text-muted leading-relaxed m-0">
				{t("mail.aiUsageLimitWarning.footerNote")}
			</Text>

			<Text className="text-xs text-muted leading-relaxed mt-4">
				{t("mail.common.openLinkInBrowser")}
				<br />
				<Link href={manageLimitsUrl} className="text-primary break-all">
					{manageLimitsUrl}
				</Link>
			</Text>
		</Wrapper>
	);
}

/**
 * Render the "{used} / {max} used this {window}" line. Kept separate from
 * the JSX so the same shape can be reused by AiUsageLimitReached.
 */
function formatUsageLine(
	t: MailTranslator,
	dimension: "TOKENS" | "SPEND_USD",
	window: "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY",
	used: string,
	max: string,
): string {
	const windowLabel = t(
		`mail.aiUsageLimitWarning.window.${window.toLowerCase() as "hourly" | "daily" | "weekly" | "monthly"}`,
	);
	if (dimension === "SPEND_USD") {
		return t("mail.aiUsageLimitWarning.usageLineSpend", {
			used,
			max,
			window: windowLabel,
		});
	}
	return t("mail.aiUsageLimitWarning.usageLineTokens", {
		used,
		max,
		window: windowLabel,
	});
}

/**
 * Resolves the email subject based on whether the limit has a name. Used
 * by `getTemplate` (`packages/mail/src/util/templates.ts`) — see the
 * `resolveSubject` branch there. Two i18n keys back this:
 * `mail.aiUsageLimitWarning.subject` (no name) and
 * `mail.aiUsageLimitWarning.subjectWithName` (`"AI usage at 80% — {limitName}"`).
 */
AiUsageLimitWarning.resolveSubject = (
	ctx: Record<string, unknown>,
	t: MailTranslator,
) => {
	const limitName = ctx.limitName as string | null | undefined;
	if (limitName) {
		return t("mail.aiUsageLimitWarning.subjectWithName", { limitName });
	}
	return t("mail.aiUsageLimitWarning.subject");
};

AiUsageLimitWarning.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	limitName: "Production OpenAI cap",
	dimension: "SPEND_USD" as const,
	window: "MONTHLY" as const,
	used: "$42.18",
	max: "$50.00",
	enforcement: "HARD" as const,
	manageLimitsUrl: "https://fabric.pro/app/acme/settings/usage?limitId=lim_1",
};

export default AiUsageLimitWarning;
