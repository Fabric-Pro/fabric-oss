import { Heading, Link, Section, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps } from "../types";

export function Welcome({
	name,
	docsUrl,
	locale,
	translations,
}: {
	name: string;
	docsUrl: string;
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
				{t("mail.welcome.heading", { name })}
			</Heading>

			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.welcome.body")}
			</Text>

			<Section className="my-6 rounded-md bg-surface py-4 px-6">
				<Text className="text-sm font-semibold text-foreground m-0 mb-2">
					{t("mail.welcome.nextStepsHeading")}
				</Text>
				<Text className="text-sm text-foreground leading-relaxed m-0">
					{t("mail.welcome.step1")}
				</Text>
				<Text className="text-sm text-foreground leading-relaxed m-0">
					{t("mail.welcome.step2")}
				</Text>
				<Text className="text-sm text-foreground leading-relaxed m-0">
					{t("mail.welcome.step3")}
				</Text>
			</Section>

			<PrimaryButton href={docsUrl}>
				{t("mail.welcome.cta")}
			</PrimaryButton>

			<Text className="text-xs text-muted leading-relaxed mt-6">
				{t("mail.welcome.docsLinkFallback")}
				<br />
				<Link href={docsUrl} className="text-primary break-all">
					{docsUrl}
				</Link>
			</Text>
		</Wrapper>
	);
}

Welcome.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	name: "John Doe",
	docsUrl: "https://fabric.pro/docs/getting-started/overview",
};

export default Welcome;
