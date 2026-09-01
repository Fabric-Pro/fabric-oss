import { Button, Heading, Section, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps, MailTranslator } from "../types";

/**
 * Someone asked for help with a readiness checklist item (Fizzy #2165, FR22).
 *
 * Addressed to a support inbox rather than to a project member, so it carries
 * the requester rather than greeting them: whoever picks this up needs to know
 * which project, which item, and who to answer.
 */
export function ReadinessHelpRequested({
	projectName,
	itemName,
	requesterName,
	requesterEmail,
	url,
	locale,
	translations,
}: {
	projectName: string;
	itemName: string;
	requesterName: string;
	requesterEmail: string;
	url: string;
} & BaseMailProps) {
	const t = createTranslator({ locale, messages: translations });

	return (
		<Wrapper>
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
						{t("mail.readinessHelpRequested.eyebrow", {
							projectName,
						})}
					</td>
				</tr>
			</table>

			<Heading
				as="h1"
				className="m-0 mb-3 font-serif text-2xl font-normal text-foreground"
			>
				{t("mail.readinessHelpRequested.headline", { itemName })}
			</Heading>

			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.readinessHelpRequested.intro", {
					requesterName,
					projectName,
				})}
			</Text>

			{/* The requester's address is body copy rather than a Reply-To
			    header because the templated send path does not carry headers.
			    Putting it where the reader looks is the reliable half anyway. */}
			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.readinessHelpRequested.replyTo", { requesterEmail })}
			</Text>

			<Section className="mt-6">
				<Button
					href={url}
					className="rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground"
				>
					{t("mail.readinessHelpRequested.openCta")}
				</Button>
			</Section>
		</Wrapper>
	);
}

ReadinessHelpRequested.resolveSubject = (
	ctx: Record<string, unknown>,
	t: MailTranslator,
) =>
	t("mail.readinessHelpRequested.subject", {
		itemName: (ctx.itemName as string) ?? "",
		projectName: (ctx.projectName as string) ?? "",
	});

// Every key the component and resolveSubject reach is exercised here, or
// template-i18n-coverage.test.ts renders a path it never checks.
ReadinessHelpRequested.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	projectName: "Example project",
	itemName: "Repository connected",
	requesterName: "Alex Doe",
	requesterEmail: "alex@example.com",
	url: "https://example.com/app/example-org/projects/example-project-id",
};

export default ReadinessHelpRequested;
