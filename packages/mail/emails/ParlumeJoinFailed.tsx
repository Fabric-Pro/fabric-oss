import { Heading, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps } from "../types";

/**
 * Parlume's bot did not get into the meeting: the start failed or nobody
 * admitted it. `reason` is the plain reason the session recorded; the
 * meeting's calendar subject, when the meeting is a linked series, is shown
 * on its own line and never in the subject, which is fixed text.
 */
export function ParlumeJoinFailed({
	meetingName,
	reason,
	url,
	locale,
	translations,
}: {
	meetingName: string | null;
	reason: string;
	url: string;
} & BaseMailProps) {
	const t = createTranslator({ locale, messages: translations });
	return (
		<Wrapper>
			<Heading
				as="h2"
				className="text-lg font-semibold text-foreground m-0 mb-3"
			>
				{t("mail.parlumeJoinFailed.headline")}
			</Heading>
			{meetingName && (
				<Text className="text-sm font-semibold text-foreground">
					{meetingName}
				</Text>
			)}
			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.parlumeJoinFailed.body")}
			</Text>
			<Text className="text-sm text-foreground leading-relaxed">
				{reason}
			</Text>
			<PrimaryButton href={url}>
				{t("mail.parlumeJoinFailed.cta")}
			</PrimaryButton>
		</Wrapper>
	);
}

ParlumeJoinFailed.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	meetingName: "Weekly planning",
	reason: "Nobody admitted Parlume from the lobby within 10 minutes.",
	url: "https://example.com/app/example-org/projects/example-project-id/parlume",
};

export default ParlumeJoinFailed;
