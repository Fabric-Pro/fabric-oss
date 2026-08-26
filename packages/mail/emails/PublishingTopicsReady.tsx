import { Button, Heading, Section, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps, MailTranslator } from "../types";

export function PublishingTopicsReady({
	projectName,
	topicCount,
	url,
	locale,
	translations,
}: {
	projectName: string;
	topicCount: number;
	url: string;
} & BaseMailProps) {
	const t = createTranslator({ locale, messages: translations });

	return (
		<Wrapper>
			{/* Editorial eyebrow with the red bar, matching ReleaseNotesNewsletter. */}
			<table
				cellPadding={0}
				cellSpacing={0}
				role="presentation"
				className="mb-3"
			>
				<tr>
					<td
						className="bg-accent"
						style={{ width: "3px", height: "13px" }}
					/>
					<td className="pl-2 text-xs uppercase tracking-[0.2em] text-muted">
						{t("mail.publishingTopicsReady.eyebrow", {
							projectName,
						})}
					</td>
				</tr>
			</table>

			<Heading
				as="h1"
				className="m-0 mb-3 font-serif text-2xl font-normal text-foreground"
			>
				{t("mail.publishingTopicsReady.headline", { topicCount })}
			</Heading>
			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.publishingTopicsReady.intro", {
					projectName,
					topicCount,
				})}
			</Text>

			<Section className="mt-6">
				<Button
					href={url}
					className="rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground"
				>
					{t("mail.publishingTopicsReady.openCta")}
				</Button>
			</Section>
		</Wrapper>
	);
}

PublishingTopicsReady.resolveSubject = (
	ctx: Record<string, unknown>,
	t: MailTranslator,
) =>
	t("mail.publishingTopicsReady.subject", {
		projectName: (ctx.projectName as string) ?? "",
		topicCount: (ctx.topicCount as number) ?? 0,
	});

// Every key and every ICU branch the component and resolveSubject reach must be exercised here,
// or template-i18n-coverage.test.ts renders a path it never checks. topicCount is 3 so the plural
// `other` branch is the one rendered; the count-1 case is covered by the test added in Step 4.
PublishingTopicsReady.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	projectName: "Example project",
	topicCount: 3,
	url: "https://example.com/app/projects/example-project-id/publishing",
};

export default PublishingTopicsReady;
