import { DocsManualHeader } from "@marketing/shared/components/DocsManualHeader";
import { config } from "@repo/config";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { getTranslations } from "next-intl/server";
import type { CSSProperties, PropsWithChildren } from "react";
import { docsSource } from "../../../../docs-source";

const docsLayoutStyle = {
	"--fd-docs-row-1": "3.5rem",
} as CSSProperties;

export default async function DocumentationLayout({
	children,
	params,
}: PropsWithChildren<{
	params: Promise<{ locale: string }>;
}>) {
	const t = await getTranslations();
	const { locale } = await params;

	return (
		<DocsLayout
			tree={
				docsSource.pageTree[locale] ??
				docsSource.pageTree[config.i18n.defaultLocale]
			}
			themeSwitch={{
				enabled: false,
			}}
			i18n
			nav={{
				title: <strong>{t("documentation.title")}</strong>,
				url: "/docs",
			}}
			sidebar={{
				defaultOpenLevel: 0,
			}}
			containerProps={{
				className: "pt-14",
				style: docsLayoutStyle,
			}}
			slots={{
				header: DocsManualHeader,
			}}
		>
			{children}
		</DocsLayout>
	);
}
