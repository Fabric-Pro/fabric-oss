import { Heading, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps, MailTranslator } from "../types";

/**
 * Parlume's bot is not in the meeting yet, most likely held in its lobby,
 * and leaves at `admitBy`, a time of
 * day already written in the recipient's time zone, unless someone admits
 * it. The meeting's calendar subject, when there is one, is shown on its own
 * line and never in the subject.
 */
export function ParlumeWaitingInLobby({
	meetingName,
	admitBy,
	url,
	locale,
	translations,
}: {
	meetingName: string | null;
	admitBy: string;
	url: string;
} & BaseMailProps) {
	const t = createTranslator({ locale, messages: translations });
	return (
		<Wrapper>
			<Heading
				as="h2"
				className="text-lg font-semibold text-foreground m-0 mb-3"
			>
				{t("mail.parlumeWaitingInLobby.headline")}
			</Heading>
			{meetingName && (
				<Text className="text-sm font-semibold text-foreground">
					{meetingName}
				</Text>
			)}
			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.parlumeWaitingInLobby.body", { admitBy })}
			</Text>
			<PrimaryButton href={url}>
				{t("mail.parlumeWaitingInLobby.cta")}
			</PrimaryButton>
		</Wrapper>
	);
}

ParlumeWaitingInLobby.resolveSubject = (
	ctx: Record<string, unknown>,
	t: MailTranslator,
) =>
	t("mail.parlumeWaitingInLobby.subject", {
		admitBy: String(ctx.admitBy ?? ""),
	});

ParlumeWaitingInLobby.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	meetingName: "Weekly planning",
	admitBy: "14:10 UTC",
	url: "https://example.com/app/example-org/projects/example-project-id/parlume",
};

export default ParlumeWaitingInLobby;
