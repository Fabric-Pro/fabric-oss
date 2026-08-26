import { Heading, Hr, Link, Section, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps, MailTranslator } from "../types";

/**
 * Email sent when an AI usage limit reaches 100% of its cap within the
 * current window. For HARD limits the body includes a line stating that
 * AI requests are blocked until the next window or until the cap is
 * raised; for SOFT limits the body explains that calls continue and this
 * is informational only. Calm/advisory tone per
 * `fabric/standards/ai/ai-copy-tone.md` — treat as a billing alert, not
 * a fire alarm.
 */
export function AiUsageLimitReached({
	limitName,
	dimension,
	window,
	used,
	max,
	enforcement = "HARD",
	manageLimitsUrl,
	locale,
	translations,
}: {
	limitName: string | null;
	dimension: "TOKENS" | "SPEND_USD";
	window: "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";
	used: string;
	max: string;
	enforcement?: "HARD" | "SOFT";
	manageLimitsUrl: string;
} & BaseMailProps) {
	const t = createTranslator({
		locale,
		messages: translations,
	});

	const heading = limitName
		? t("mail.aiUsageLimitReached.headingWithName", { limitName })
		: t("mail.aiUsageLimitReached.heading");

	const usageLine = formatUsageLine(t, dimension, window, used, max);

	const enforcementNote =
		enforcement === "HARD"
			? t("mail.aiUsageLimitReached.bodyHard")
			: t("mail.aiUsageLimitReached.bodySoft");

	return (
		<Wrapper>
			<Heading
				as="h2"
				className="text-lg font-semibold text-foreground m-0 mb-3"
			>
				{heading}
			</Heading>

			<Text className="text-sm text-foreground leading-relaxed">
				{enforcementNote}
			</Text>

			<Section className="my-6 rounded-md bg-surface py-4 px-6">
				<Text className="text-sm text-foreground leading-relaxed m-0">
					{usageLine}
				</Text>
			</Section>

			<PrimaryButton href={manageLimitsUrl}>
				{t("mail.aiUsageLimitReached.manageButton")}
			</PrimaryButton>

			<Hr className="my-6 border-border" />

			<Text className="text-xs text-muted leading-relaxed m-0">
				{t("mail.aiUsageLimitReached.footerNote")}
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

function formatUsageLine(
	t: MailTranslator,
	dimension: "TOKENS" | "SPEND_USD",
	window: "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY",
	used: string,
	max: string,
): string {
	const windowLabel = t(
		`mail.aiUsageLimitReached.window.${window.toLowerCase() as "hourly" | "daily" | "weekly" | "monthly"}`,
	);
	if (dimension === "SPEND_USD") {
		return t("mail.aiUsageLimitReached.usageLineSpend", {
			used,
			max,
			window: windowLabel,
		});
	}
	return t("mail.aiUsageLimitReached.usageLineTokens", {
		used,
		max,
		window: windowLabel,
	});
}

/**
 * Resolves the email subject based on whether the limit has a name. See
 * the matching helper in `AiUsageLimitWarning.tsx` for the contract.
 */
AiUsageLimitReached.resolveSubject = (
	ctx: Record<string, unknown>,
	t: MailTranslator,
) => {
	const limitName = ctx.limitName as string | null | undefined;
	if (limitName) {
		return t("mail.aiUsageLimitReached.subjectWithName", { limitName });
	}
	return t("mail.aiUsageLimitReached.subject");
};

AiUsageLimitReached.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	limitName: "Production OpenAI cap",
	dimension: "SPEND_USD" as const,
	window: "MONTHLY" as const,
	used: "$50.00",
	max: "$50.00",
	enforcement: "HARD" as const,
	manageLimitsUrl: "https://fabric.pro/app/acme/settings/usage?limitId=lim_1",
};

export default AiUsageLimitReached;
