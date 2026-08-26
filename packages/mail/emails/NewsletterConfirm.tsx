import { Button, Heading, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps } from "../types";

export function NewsletterConfirm({
	confirmUrl,
	locale,
	translations,
}: { confirmUrl: string } & BaseMailProps) {
	const t = createTranslator({ locale, messages: translations });

	return (
		<Wrapper>
			<Heading
				as="h2"
				className="text-lg font-semibold text-foreground m-0 mb-3"
			>
				{t("mail.newsletterConfirm.heading")}
			</Heading>
			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.newsletterConfirm.body")}
			</Text>
			<Button
				href={confirmUrl}
				className="bg-primary text-white rounded-md px-4 py-2 text-sm font-semibold"
			>
				{t("mail.newsletterConfirm.cta")}
			</Button>
			<Text className="text-xs text-muted leading-relaxed mt-6">
				{t("mail.newsletterConfirm.ignoreNotice")}
			</Text>
		</Wrapper>
	);
}

NewsletterConfirm.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	confirmUrl: "https://fabric.pro/newsletter/confirm/preview-token",
};

export default NewsletterConfirm;
