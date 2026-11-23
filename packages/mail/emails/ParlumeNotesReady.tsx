import { Heading, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps, MailTranslator } from "../types";

/**
 * Tells a member invited to a meeting that Parlume's notes for it are ready,
 * with a link to the project's Parlume page. Only the meeting's internal
 * invitees who may read its transcript get it; guests get nothing. The mail
 * carries no meeting content: the notes are behind the link and its sign-in.
 *
 * `url` arrives absolute and tenant-complete; the activity builds it.
 */
export function ParlumeNotesReady({
	projectName,
	meetingName,
	url,
	locale,
	translations,
}: { projectName: string; meetingName: string; url: string } & BaseMailProps) {
	const t = createTranslator({ locale, messages: translations });
	return (
		<Wrapper>
			<Heading
				as="h2"
				className="text-lg font-semibold text-foreground m-0 mb-3"
			>
				{t("mail.parlumeNotesReady.headline")}
			</Heading>
			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.parlumeNotesReady.body", { meetingName, projectName })}
			</Text>
			<PrimaryButton href={url}>
				{t("mail.parlumeNotesReady.cta")}
			</PrimaryButton>
		</Wrapper>
	);
}

ParlumeNotesReady.resolveSubject = (
	ctx: Record<string, unknown>,
	t: MailTranslator,
) =>
	t("mail.parlumeNotesReady.subject", {
		meetingName: String(ctx.meetingName ?? ""),
	});

ParlumeNotesReady.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	projectName: "Example Project",
	meetingName: "Weekly planning",
	url: "#",
};

export default ParlumeNotesReady;
