import { Button, Heading, Hr, Section, Text } from "@react-email/components";
import {
	groupHighlightsByRelease,
	type ReleaseHighlight,
} from "@repo/utils/group-highlights";
import React from "react";
import { createTranslator } from "use-intl/core";
import Wrapper from "../src/components/Wrapper";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import type { BaseMailProps, MailTranslator } from "../types";

export type ReleaseNotesHighlight = ReleaseHighlight;

export function ReleaseNotesNewsletter({
	projectName,
	headline,
	intro,
	highlights,
	unsubscribeUrl,
	appUrl,
	locale,
	translations,
}: {
	projectName: string;
	headline: string;
	intro: string;
	highlights: ReleaseNotesHighlight[];
	unsubscribeUrl: string;
	appUrl?: string;
} & BaseMailProps) {
	const t = createTranslator({ locale, messages: translations });
	// Strip trailing slash(es): getBaseUrl() returns the env value verbatim, which
	// may end in "/", and would otherwise yield a double-slash legal URL.
	const legalBase = appUrl?.replace(/\/+$/, "");
	const groups = groupHighlightsByRelease(highlights);
	const multiRepo =
		new Set(groups.map((g) => g.repoFullName).filter(Boolean)).size > 1;

	return (
		<Wrapper>
			{/* Editorial eyebrow with red bar */}
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
						{t("mail.releaseNotesNewsletter.eyebrow", {
							projectName,
						})}
					</td>
				</tr>
			</table>

			<Heading
				as="h1"
				className="m-0 mb-3 font-serif text-2xl font-normal text-foreground"
			>
				{headline}
			</Heading>
			<Text className="text-sm text-foreground leading-relaxed">
				{intro}
			</Text>

			{groups.map((group, gi) => (
				<Section
					key={`${gi}-${group.repoFullName}-${group.tag}`}
					className="mt-5"
				>
					{group.tag && (
						<table
							cellPadding={0}
							cellSpacing={0}
							role="presentation"
							className="mb-3 w-full"
						>
							<tr>
								<td
									style={{
										width: "1%",
										whiteSpace: "nowrap",
									}}
								>
									<span className="rounded-full bg-chip px-2 py-1 text-xs font-semibold text-chip-foreground">
										{group.tag}
									</span>
									{multiRepo && group.repoFullName && (
										<span className="pl-2 text-xs text-muted">
											{group.repoFullName
												.split("/")
												.pop()}
										</span>
									)}
								</td>
								<td className="pl-3">
									<Hr className="border-border m-0" />
								</td>
							</tr>
						</table>
					)}
					{group.items.map((h, ii) => (
						<Section key={`${ii}-${h.title}`} className="mb-3">
							<Text className="m-0 text-sm font-semibold text-foreground">
								{h.title}
							</Text>
							<Text className="m-0 mt-1 text-sm text-foreground leading-relaxed">
								{h.description}
							</Text>
						</Section>
					))}
				</Section>
			))}

			{appUrl && (
				<Section className="mt-6">
					<Button
						href={appUrl}
						className="rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground"
					>
						{t("mail.releaseNotesNewsletter.openCta")}
					</Button>
				</Section>
			)}

			<Hr className="my-6 border-border" />
			<Text className="text-xs text-muted leading-relaxed m-0">
				{t("mail.releaseNotesNewsletter.unsubscribeNotice", {
					projectName,
				})}{" "}
				<a href={unsubscribeUrl} className="text-primary underline">
					{t("mail.releaseNotesNewsletter.unsubscribeCta")}
				</a>
			</Text>
			{legalBase && (
				<Text className="text-xs text-muted leading-relaxed m-0 mt-2">
					<a
						href={`${legalBase}/${locale}/legal/privacy-policy`}
						className="text-muted underline"
					>
						{t("mail.releaseNotesNewsletter.privacyCta")}
					</a>
					{" · "}
					<a
						href={`${legalBase}/${locale}/legal/terms`}
						className="text-muted underline"
					>
						{t("mail.releaseNotesNewsletter.termsCta")}
					</a>
				</Text>
			)}
		</Wrapper>
	);
}

ReleaseNotesNewsletter.resolveSubject = (
	ctx: Record<string, unknown>,
	t: MailTranslator,
) =>
	t("mail.releaseNotesNewsletter.subject", {
		projectName: (ctx.projectName as string) ?? "",
	});

ReleaseNotesNewsletter.PreviewProps = {
	locale: defaultLocale,
	translations: defaultTranslations,
	projectName: "Acme",
	headline: "June product update",
	intro: "A few meaningful improvements shipped this month.",
	appUrl: "https://app.fabric.pro",
	highlights: [
		{
			title: "Redesigned dashboard",
			description: "A cleaner home with faster navigation.",
			releaseTag: "v1.3.7",
			repoFullName: "acme/web",
			prUrl: "https://github.com/acme/web/releases/tag/v1.3.7",
		},
		{
			title: "Bulk export",
			description: "Export everything in one click.",
			releaseTag: "v1.3.5",
			repoFullName: "acme/web",
			prUrl: "https://github.com/acme/web/releases/tag/v1.3.5",
		},
		{
			title: "Faster search",
			description: "Search is now instant.",
			releaseTag: "v1.3.5",
			repoFullName: "acme/web",
			prUrl: "https://github.com/acme/web/releases/tag/v1.3.5",
		},
	],
	unsubscribeUrl: "#",
};

export default ReleaseNotesNewsletter;
