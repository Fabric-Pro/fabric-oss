import { Heading, Link, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps } from "../types";

export function MagicLink({
	url,
	locale,
	translations,
}: {
	url: string;
} & BaseMailProps) {
	const t = createTranslator({
		locale,
		messages: translations,
	});

	return (
		<Wrapper>
			<Heading
				as="h2"
				className="text-lg font-semibold text-foreground m-0 mb-3"
			>
				{t("mail.magicLink.heading")}
			</Heading>

			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.magicLink.body")}
			</Text>

			<PrimaryButton href={url}>
				{t("mail.magicLink.login")}
			</PrimaryButton>

			<Text className="text-xs text-muted leading-relaxed mt-6">
				{t("mail.common.openLinkInBrowser")}
				<br />
				<Link href={url} className="text-primary break-all">
					{url}
				</Link>
			</Text>

			<Text className="text-xs text-muted leading-relaxed">
				{t("mail.magicLink.ignoreNotice")}
			</Text>
		</Wrapper>
	);
}

MagicLink.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	url: "#",
};

export default MagicLink;
