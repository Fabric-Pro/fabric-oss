import { Heading, Link, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps } from "../types";

export function SignupAttemptNotice({
	name,
	loginUrl,
	resetUrl,
	locale,
	translations,
}: {
	name?: string;
	loginUrl: string;
	resetUrl: string;
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
				{t("mail.signupAttemptNotice.heading")}
			</Heading>

			<Text className="text-sm text-foreground leading-relaxed">
				{name
					? t("mail.signupAttemptNotice.bodyWithName", { name })
					: t("mail.signupAttemptNotice.body")}
			</Text>

			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.signupAttemptNotice.instruction")}
			</Text>

			<PrimaryButton href={loginUrl}>
				{t("mail.signupAttemptNotice.signIn")}
			</PrimaryButton>

			<Text className="text-xs text-muted leading-relaxed mt-6">
				{t("mail.common.openLinkInBrowser")}
				<br />
				<Link href={loginUrl} className="text-primary break-all">
					{loginUrl}
				</Link>
			</Text>

			<Text className="text-xs text-muted leading-relaxed mt-4">
				{t("mail.signupAttemptNotice.forgotPasswordPrefix")}{" "}
				<Link href={resetUrl} className="text-primary break-all">
					{t("mail.signupAttemptNotice.resetPassword")}
				</Link>
				{"."}
			</Text>

			<Text className="text-xs text-muted leading-relaxed">
				{t("mail.signupAttemptNotice.ignoreNotice")}
			</Text>
		</Wrapper>
	);
}

SignupAttemptNotice.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	loginUrl: "#",
	resetUrl: "#",
	name: "John Doe",
};

export default SignupAttemptNotice;
