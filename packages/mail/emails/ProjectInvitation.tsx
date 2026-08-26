import { Heading, Link, Section, Text } from "@react-email/components";
import React from "react";
import { createTranslator } from "use-intl/core";
import PrimaryButton from "../src/components/PrimaryButton";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps } from "../types";

export function ProjectInvitation({
	url,
	projectName,
	inviterName,
	role,
	message,
	locale,
	translations,
}: {
	url: string;
	projectName: string;
	inviterName: string;
	role: string;
	message?: string;
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
				{t("mail.projectInvitation.headline", { projectName })}
			</Heading>

			<Text className="text-sm text-foreground leading-relaxed">
				{t("mail.projectInvitation.body", {
					inviterName,
					projectName,
					role,
				})}
			</Text>

			{message && (
				<Section className="my-4 rounded-md bg-surface py-3 px-4 border-l-2 border-primary">
					<Text className="text-sm text-foreground italic m-0">
						"{message}"
					</Text>
				</Section>
			)}

			<PrimaryButton href={url}>
				{t("mail.projectInvitation.accept")}
			</PrimaryButton>

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

ProjectInvitation.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	url: "#",
	projectName: "My Awesome Project",
	inviterName: "John Doe",
	role: "Editor",
	message: "Looking forward to collaborating with you on this.",
};

export default ProjectInvitation;
