import { Heading, Link, Section, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps } from "../types";

/**
 * Step one of deleting an organization: the single-use confirmation link
 * (Fizzy #2462).
 *
 * This mail is the ONLY thing standing between "someone pressed the button" and
 * a tenant going dark, so it has two jobs and they pull in opposite directions.
 * It has to be unmistakably actionable for the owner who meant it, and
 * unmistakably alarming for the one who did not — which is why the consequences
 * are spelled out above the button rather than below it, and why the recovery
 * window is stated as a number of days rather than "for a while".
 *
 * Copy resolves through `createTranslator` like every other template here, from
 * `mail.organizationDeletionConfirm.*`. There is deliberately no
 * `resolveSubject`: `getTemplate` prefers that property over the bundle's own
 * `subject` key, so exporting one would make the subject the only untranslatable
 * line in the message.
 */
export function OrganizationDeletionConfirm({
	organizationName,
	url,
	retentionDays,
	locale,
	translations,
}: {
	organizationName: string;
	/** The single-use confirmation link. Absolute — built at the call site. */
	url: string;
	/** How long the organization stays restorable AFTER this link is opened. */
	retentionDays: number;
} & BaseMailProps) {
	const t = createTranslator({ locale, messages: translations });

	return (
		<Wrapper>
			<Heading
				as="h2"
				className="text-lg font-semibold text-foreground m-0 mb-3"
			>
				{t("mail.organizationDeletionConfirm.headline", {
					organizationName,
				})}
			</Heading>

			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.organizationDeletionConfirm.body", {
					organizationName,
				})}
			</Text>

			<Section className="rounded-md border border-border bg-surface px-4 py-3 my-4">
				<Text className="text-sm text-foreground leading-relaxed m-0">
					{t("mail.organizationDeletionConfirm.whatIsRemoved")}
				</Text>
			</Section>

			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.organizationDeletionConfirm.recoveryWindow", {
					retentionDays,
				})}
			</Text>

			<PrimaryButton href={url}>
				{t("mail.organizationDeletionConfirm.confirm", {
					organizationName,
				})}
			</PrimaryButton>

			<Text className="text-xs text-muted leading-relaxed mt-6">
				{t("mail.organizationDeletionConfirm.linkExpiry")}
			</Text>

			<Text className="text-xs text-muted leading-relaxed">
				{t("mail.organizationDeletionConfirm.notYou")}
			</Text>

			<Text className="text-xs text-muted leading-relaxed mt-6">
				{t("mail.common.openLinkInBrowser")}
				<br />
				<Link href={url} className="text-primary break-all">
					{url}
				</Link>
			</Text>
		</Wrapper>
	);
}

OrganizationDeletionConfirm.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	organizationName: "Example Org",
	url: "https://example.com/organizations/confirm-deletion?token=example-token",
	retentionDays: 7,
};

export default OrganizationDeletionConfirm;
