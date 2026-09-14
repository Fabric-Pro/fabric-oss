import { Heading, Link, Section, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps, MailTranslator } from "../types";

/**
 * The last warning before an organization is destroyed (Fizzy #2462).
 *
 * Sent 24-48 hours before the purge, once, by the daily cleanup sweep. It is the
 * only message in the flow a person receives without having just asked for
 * something, which decides its shape: the restore button is the primary action,
 * and the purge date is stated as an exact local date and time rather than "in
 * two days" — someone reading this on a phone at the wrong end of a weekend
 * needs to know whether they have to act tonight.
 *
 * WHY THE DATE ARRIVES PRE-FORMATTED. `purgeDate` is a string the sending
 * activity has already localised, not a `Date`. Temporal's data converter is
 * JSON, so a `Date` in an activity's input arrives as an ISO string wearing a
 * `Date` type — calling `toLocaleString` on it silently returns the raw ISO text
 * instead of throwing. Formatting before the value crosses that boundary keeps
 * the type honest and the output readable.
 *
 * Copy resolves through `createTranslator`, from
 * `mail.organizationDeletionReminder.*` — the subject included, via
 * `resolveSubject` below. The subject is the load-bearing part of a reminder,
 * since it carries the deadline into the inbox list, and it interpolates BOTH
 * the name and the date. `getTemplate` reads a bundle `subject` as a raw
 * string, so without a resolver both placeholders ship literally and the
 * deadline never reaches the inbox list at all.
 */
export function OrganizationDeletionReminder({
	organizationName,
	restoreUrl,
	purgeDate,
	retentionDays,
	locale,
	translations,
}: {
	organizationName: string;
	/** Where the recipient can bring the organization back. Absolute. */
	restoreUrl: string;
	/** Already localised at the call site — see the note above. */
	purgeDate: string;
	/** The length of the window that is about to close. */
	retentionDays: number;
} & BaseMailProps) {
	const t = createTranslator({ locale, messages: translations });

	return (
		<Wrapper>
			<Heading
				as="h2"
				className="text-lg font-semibold text-foreground m-0 mb-3"
			>
				{t("mail.organizationDeletionReminder.headline", {
					organizationName,
				})}
			</Heading>

			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.organizationDeletionReminder.body", {
					organizationName,
				})}
			</Text>

			<Section className="rounded-md border border-border bg-surface px-4 py-3 my-4">
				<Text className="text-sm font-semibold text-foreground m-0">
					{t("mail.organizationDeletionReminder.purgeDate", {
						purgeDate,
					})}
				</Text>
			</Section>

			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.organizationDeletionReminder.irreversible")}
			</Text>

			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.organizationDeletionReminder.retentionNote")}
			</Text>

			<PrimaryButton href={restoreUrl}>
				{t("mail.organizationDeletionReminder.restore", {
					organizationName,
				})}
			</PrimaryButton>

			<Text className="text-xs text-muted leading-relaxed mt-6">
				{t("mail.organizationDeletionReminder.noActionNeeded", {
					retentionDays,
				})}
			</Text>

			<Text className="text-xs text-muted leading-relaxed mt-6">
				{t("mail.common.openLinkInBrowser")}
				<br />
				<Link href={restoreUrl} className="text-primary break-all">
					{restoreUrl}
				</Link>
			</Text>
		</Wrapper>
	);
}

/**
 * `purgeDate` is passed straight through, already localised by the sending
 * activity — see the note above. Formatting it here would re-introduce exactly
 * the boundary that note exists to keep honest.
 */
OrganizationDeletionReminder.resolveSubject = (
	ctx: Record<string, unknown>,
	t: MailTranslator,
) =>
	t("mail.organizationDeletionReminder.subject", {
		organizationName: (ctx.organizationName as string) ?? "",
		purgeDate: (ctx.purgeDate as string) ?? "",
	});

OrganizationDeletionReminder.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	organizationName: "Example Org",
	restoreUrl: "https://example.com/new-organization",
	purgeDate: "Friday, March 14, 2098 at 12:00 AM UTC",
	retentionDays: 30,
};

export default OrganizationDeletionReminder;
