import { Heading, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps, MailTranslator } from "../types";

/**
 * Tells a reviewer that a release-notes draft is parked for approval
 * (Fizzy #2172). In-app notification alone is easy to miss, and a missed
 * review window ends with the draft reclaimed as EXPIRED.
 *
 * `url` arrives absolute and tenant-complete — the activity builds it, because
 * the in-app link is context-relative and prepending a base URL to it would
 * drop the `/app/{organizationSlug}` prefix an organization reviewer needs.
 * The template passes it through untouched.
 */
export function NewsletterApprovalPending({
	projectName,
	url,
	locale,
	translations,
}: { projectName: string; url: string } & BaseMailProps) {
	const t = createTranslator({ locale, messages: translations });
	return (
		<Wrapper>
			<Heading
				as="h2"
				className="text-lg font-semibold text-foreground m-0 mb-3"
			>
				{t("mail.newsletterApprovalPending.headline")}
			</Heading>
			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.newsletterApprovalPending.body", { projectName })}
			</Text>
			<PrimaryButton href={url}>
				{t("mail.newsletterApprovalPending.cta")}
			</PrimaryButton>
		</Wrapper>
	);
}

NewsletterApprovalPending.resolveSubject = (
	ctx: Record<string, unknown>,
	t: MailTranslator,
) =>
	t("mail.newsletterApprovalPending.subject", {
		projectName: String(ctx.projectName ?? ""),
	});

NewsletterApprovalPending.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	projectName: "Example Project",
	url: "#",
};

export default NewsletterApprovalPending;
