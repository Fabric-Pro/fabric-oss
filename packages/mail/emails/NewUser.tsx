import { Heading, Link, Section, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps } from "../types";

export function NewUser({
	url,
	name,
	otp,
	locale,
	translations,
}: {
	url: string;
	name: string;
	otp: string;
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
				{t("mail.newUser.heading")}
			</Heading>

			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.newUser.body", { name })}
			</Text>

			<Section className="my-6 rounded-md bg-surface py-4 px-6 text-center">
				<Text className="text-xs text-muted m-0 mb-1">
					{t("mail.newUser.otpLabel")}
				</Text>
				<Text className="text-2xl font-bold text-foreground tracking-widest m-0">
					{otp}
				</Text>
				<Text className="text-xs text-muted m-0 mt-1">
					{t("mail.newUser.otpExpiry")}
				</Text>
			</Section>

			<Text className="text-xs text-muted leading-relaxed mb-4">
				{t("mail.newUser.orUseLink")}
			</Text>

			<PrimaryButton href={url}>
				{t("mail.newUser.confirmEmail")}
			</PrimaryButton>

			<Text className="text-xs text-muted leading-relaxed mt-6">
				{t("mail.common.openLinkInBrowser")}
				<br />
				<Link href={url} className="text-primary break-all">
					{url}
				</Link>
			</Text>

			<Text className="text-xs text-muted leading-relaxed">
				{t("mail.newUser.ignoreNotice")}
			</Text>
		</Wrapper>
	);
}

NewUser.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	url: "#",
	name: "John Doe",
	otp: "123456",
};

export default NewUser;
