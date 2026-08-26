import { config } from "@repo/config";
import { DocsBody, DocsPage } from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { docsSource } from "../../../../docs-source";
import { MdxClient } from "./mdx-client";

export default async function DocumentationPage(props: {
	params: Promise<{ path?: string[]; locale: string }>;
}) {
	const params = await props.params;
	const section = params.path?.[0];
	setRequestLocale(params.locale);
	const page =
		docsSource.getPage(params.path, params.locale) ??
		docsSource.getPage(params.path, config.i18n.defaultLocale);
	const t = await getTranslations();

	if (!page) {
		notFound();
	}

	const isFallbackContent =
		params.locale !== config.i18n.defaultLocale &&
		(page.locale ?? config.i18n.defaultLocale) ===
			config.i18n.defaultLocale;

	return (
		<DocsPage
			toc={page.data.toc}
			full={page.data.full}
			// Per-section CSS hook on the docs <article> wrapper, consumed by
			// `globals.css` and asserted by `docs-integrations-footer-nav.spec.ts`.
			// fumadocs-ui 16.8+ has `DocsPageProps extends ComponentProps<'article'>`,
			// so article attributes spread directly here instead of nesting under an
			// `article` prop — which also drops the cast the object-literal form
			// needed to satisfy the data-* index signature.
			data-docs-section={section}
			breadcrumb={{
				enabled: true,
				includePage: true,
				includeSeparator: true,
			}}
			tableOfContent={{
				enabled: true,
			}}
		>
			<DocsBody>
				{isFallbackContent && (
					<div className="mb-4 rounded-lg border border-muted bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
						{t("documentation.fallbackNotice")}
					</div>
				)}
				<h1 className="text-foreground">{page.data.title}</h1>
				{page.data.description && (
					<p className="-mt-6 text-foreground/50 text-lg lg:text-xl">
						{page.data.description}
					</p>
				)}
				<div className="prose dark:prose-invert max-w-full prose-a:text-foreground prose-p:text-foreground/80">
					<MdxClient code={page.data.body} />
				</div>
			</DocsBody>
		</DocsPage>
	);
}

export async function generateStaticParams() {
	const locales = Object.keys(config.i18n.locales);
	const pages = docsSource.getPages();
	// Dedupe by path (getPages may return per-locale entries; we want unique slug paths)
	const uniquePaths = Array.from(
		new Map(pages.map((p) => [p.slugs.join("/"), p.slugs])).values(),
	);
	return uniquePaths.flatMap((slugs) =>
		locales.map((locale) => ({
			path: slugs,
			locale,
		})),
	);
}

export async function generateMetadata(props: {
	params: Promise<{ path?: string[]; locale: string }>;
}) {
	const t = await getTranslations();
	const params = await props.params;
	const page =
		docsSource.getPage(params.path, params.locale) ??
		docsSource.getPage(params.path, config.i18n.defaultLocale);

	if (!page) {
		notFound();
	}

	const ogTitle = encodeURIComponent(page.data.title);
	const ogDesc = encodeURIComponent(page.data.description ?? "");
	const ogUrl = `https://fabric.pro/api/og?title=${ogTitle}&description=${ogDesc}&label=Documentation`;

	return {
		title: `${page.data.title} | ${t("documentation.title")}`,
		description: page.data.description,
		openGraph: {
			title: `${page.data.title} | Fabric Docs`,
			description: page.data.description,
			images: [
				{
					url: ogUrl,
					width: 1200,
					height: 630,
					alt: page.data.title,
				},
			],
		},
		twitter: {
			card: "summary_large_image",
			title: `${page.data.title} | Fabric Docs`,
			description: page.data.description,
			images: [ogUrl],
		},
	};
}
