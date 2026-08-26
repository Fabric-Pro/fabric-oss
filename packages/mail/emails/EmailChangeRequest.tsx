import { Heading, Hr, Link, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps } from "../types";

export function EmailChangeRequest({
	name,
	oldEmail,
	newEmail,
	approveUrl,
	revokeUrl,
	timestamp,
	locale,
	translations,
}: {
	name: string;
	oldEmail: string;
	newEmail: string;
	approveUrl: string;
	revokeUrl: string;
	timestamp: string;
} & BaseMailProps) {
	const t = createTranslator({
		locale,
		messages: translations,
	});

	const formattedTimestamp = (() => {
		try {
			return new Date(timestamp).toLocaleString(locale);
		} catch {
			return timestamp;
		}
	})();

	return (
		<Wrapper>
			<Heading
				as="h2"
				className="text-lg font-semibold text-foreground m-0 mb-3"
			>
				{t("mail.emailChangeRequest.heading")}
			</Heading>

			<Text className="text-sm text-muted leading-relaxed">
				{t("mail.emailChangeRequest.greeting", { email: oldEmail })}
			</Text>

			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.emailChangeRequest.body", {
					name,
					newEmail,
					timestamp: formattedTimestamp,
				})}
			</Text>

			<PrimaryButton href={approveUrl}>
				{t("mail.emailChangeRequest.approveButton")}
			</PrimaryButton>

			<Text className="text-xs text-muted leading-relaxed mt-2">
				{t("mail.emailChangeRequest.expiryNotice")}
			</Text>

			<Hr className="border-t border-muted my-6" />

			<Text className="text-sm font-semibold text-foreground m-0 mb-2">
				{t("mail.emailChangeRequest.revokeHeading")}
			</Text>

			<Text className="text-sm text-foreground leading-relaxed m-0 mb-3">
				{t("mail.emailChangeRequest.revokeBody")}
			</Text>

			<Link
				href={revokeUrl}
				className="text-sm text-destructive font-medium underline"
			>
				{t("mail.emailChangeRequest.revokeButton")}
			</Link>

			<Text className="text-xs text-muted leading-relaxed mt-6">
				{t("mail.common.openLinkInBrowser")}
				<br />
				<Link href={approveUrl} className="text-primary break-all">
					{approveUrl}
				</Link>
			</Text>

			<Text className="text-xs text-muted leading-relaxed">
				{t("mail.emailChangeRequest.ignoreNotice")}
			</Text>
		</Wrapper>
	);
}

EmailChangeRequest.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	name: "John Doe",
	oldEmail: "j***@example.com",
	newEmail: "newaddress@example.com",
	approveUrl: "#",
	revokeUrl: "#",
	timestamp: new Date().toISOString(),
};

export default EmailChangeRequest;
