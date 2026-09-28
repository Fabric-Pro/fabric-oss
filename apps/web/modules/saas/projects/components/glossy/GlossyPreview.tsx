"use client";

import { splitMarkdownBlocks } from "@repo/utils/glossy/cleanup";
import type {
	EditionAnchor,
	EditionContent,
} from "@repo/utils/glossy/edition-content";
import { useFormatter, useTranslations } from "next-intl";
import { Fragment, type ReactNode } from "react";
import ReactMarkdown, {
	type Components,
	defaultUrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import { orderGlossyAnchors } from "../../lib/glossy/glossy-document-render";

/** The only inline images section text may show: raster `data:` URIs (KTD16). */
const RASTER_DATA_URL = /^data:image\/(?:png|jpe?g|gif);base64,/i;

/** Diagram source never appears in an edition (R13). */
const DIAGRAM_LANGUAGE =
	/(?:^|\s)language-(?:mermaid|plantuml|puml|dot|graphviz|d2)(?:\s|$)/i;

type HeadingTag = "h3" | "h4" | "h5" | "h6";

function headingTag(level: number): HeadingTag {
	return `h${Math.min(Math.max(level, 3), 6)}` as HeadingTag;
}

type GlossyPreviewProps = {
	content: EditionContent;
	preparer: { name: string; logoUrl: string | null };
	/** The recipient as the cover names it (R35): the saved brand, else the source's client field. */
	recipient: { name: string | null; logoUrl: string | null };
	/** Server-signed reads of the document's own uploads, by S3 key (KTD16). */
	imageUrls: Readonly<Record<string, string>>;
	/** The card for one visual anchor, review controls included for editors. */
	renderVisual: (visualKey: string) => ReactNode;
};

/**
 * The Glossy edition as it will download (Fizzy #2589, R26, R35, R36, R43):
 * the cover with both parties, the sections in order with each visual beside
 * the text it illustrates, and the appendix last, ending with the provenance
 * line.
 *
 * Section text is rendered without raw HTML or remote images (KTD16): HTML
 * is skipped, links read as their text, diagram source is dropped, and the
 * only images are inline `data:` URIs, rendered visuals, the two signed
 * logos, and the document's own uploads through the server-signed URLs.
 * Brand colors reach the page through the rasterized visuals; the preview
 * itself is styled with the app's tokens.
 */
export function GlossyPreview({
	content,
	preparer,
	recipient,
	imageUrls,
	renderVisual,
}: GlossyPreviewProps) {
	const t = useTranslations("projects.glossy.preview");
	const format = useFormatter();

	// Rendered heading levels start at h3 (the page has h1, the edition title
	// is h2) and never skip a level going down, whatever the source used.
	const headedLevels = content.sections
		.filter((section) => section.heading)
		.map((section) => section.level);
	const topLevel = headedLevels.length > 0 ? Math.min(...headedLevels) : 1;
	let previous = 2;
	const sectionLevels = content.sections.map((section) => {
		if (!section.heading) {
			return previous;
		}
		const level = Math.min(3 + section.level - topLevel, previous + 1, 6);
		previous = Math.max(level, 3);
		return previous;
	});

	const renderAnchor = (anchor: EditionAnchor): ReactNode => {
		if (anchor.ref.type === "visual") {
			return renderVisual(anchor.ref.visualKey);
		}
		const url = Object.hasOwn(imageUrls, anchor.ref.s3Key)
			? imageUrls[anchor.ref.s3Key]
			: undefined;
		// An image the server did not sign is left out, as the download does.
		if (!url) {
			return null;
		}
		return (
			<figure className="my-6">
				{/* biome-ignore lint/performance/noImgElement: a short-lived signed read of the document's own upload, which next/image cannot optimize */}
				<img
					src={url}
					alt={t("documentImage")}
					className="mx-auto h-auto max-w-full"
				/>
			</figure>
		);
	};

	const { appendix, provenance } = content;
	const listSections = [
		{
			id: "sources",
			title: t("sources"),
			items: appendix.sources.map((source) =>
				source.id ? `${source.id}: ${source.text}` : source.text,
			),
		},
		{
			id: "details",
			title: t("details"),
			items: appendix.details.map((detail) =>
				detail.label
					? `${detail.label}: ${detail.value}`
					: detail.value,
			),
		},
		{
			id: "placeholders",
			title: t("placeholders"),
			items: appendix.placeholders.map((placeholder) =>
				placeholder.heading
					? `${placeholder.heading}: ${placeholder.text}`
					: placeholder.text,
			),
		},
		{
			id: "assumptions",
			title: t("assumptions"),
			items: appendix.assumptions.map(
				(assumption) => `${assumption.text} (${assumption.qualifier})`,
			),
		},
	].filter((section) => section.items.length > 0);

	const builtAt = new Date(provenance.builtAt);

	return (
		<article
			aria-labelledby="glossy-edition-title"
			className="mx-auto w-full max-w-4xl space-y-8 rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm md:p-10"
		>
			<header className="space-y-6 border-border border-b pb-8">
				<h2
					id="glossy-edition-title"
					className="font-semibold text-2xl tracking-tight"
				>
					{content.title}
				</h2>
				<dl className="grid gap-6 sm:grid-cols-2">
					<CoverParty
						label={t("preparedBy")}
						name={preparer.name || null}
						logoUrl={preparer.logoUrl}
						logoAlt={t("logoOf", { name: preparer.name })}
					/>
					{(recipient.name || recipient.logoUrl) && (
						<CoverParty
							label={t("preparedFor")}
							name={recipient.name}
							logoUrl={recipient.logoUrl}
							logoAlt={
								recipient.name
									? t("logoOf", { name: recipient.name })
									: t("recipientLogo")
							}
						/>
					)}
				</dl>
			</header>

			{content.sections.map((section, index) => {
				const level = sectionLevels[index];
				const Heading = headingTag(level);
				return (
					<section key={section.sectionKey} className="space-y-3">
						{section.heading && (
							<Heading className="font-semibold text-lg tracking-tight">
								{section.heading}
							</Heading>
						)}
						<AnchoredMarkdown
							markdown={section.markdown}
							anchors={section.anchors}
							headingLevel={level + 1}
							renderAnchor={renderAnchor}
						/>
					</section>
				);
			})}

			<section
				aria-labelledby="glossy-appendix-title"
				className="space-y-4 border-border border-t pt-8"
			>
				<h3
					id="glossy-appendix-title"
					className="font-semibold text-lg tracking-tight"
				>
					{t("appendix")}
				</h3>
				{listSections.map((section) => (
					<div key={section.id} className="space-y-2">
						<h4 className="font-medium text-base">
							{section.title}
						</h4>
						<ul className="list-disc space-y-1 pl-5 text-sm">
							{section.items.map((item, index) => (
								// Entries have no identity beyond their position.
								<li key={index}>
									<InlineMarkdown text={item} />
								</li>
							))}
						</ul>
					</div>
				))}
				{appendix.additionalMaterial.length > 0 && (
					<div className="space-y-3">
						<h4 className="font-medium text-base">
							{t("additionalMaterial")}
						</h4>
						{appendix.additionalMaterial.map((section, index) => (
							// The source's own appendix sections have no key.
							<div key={index} className="space-y-2">
								{section.heading && (
									<h5 className="font-medium text-sm">
										{section.heading}
									</h5>
								)}
								<AnchoredMarkdown
									markdown={section.markdown}
									anchors={section.anchors}
									headingLevel={6}
									renderAnchor={renderAnchor}
								/>
							</div>
						))}
					</div>
				)}
				<p className="text-muted-foreground text-sm">
					{t("provenance", {
						title: provenance.sourceTitle,
						version: provenance.sourceVersion,
						date: Number.isNaN(builtAt.getTime())
							? provenance.builtAt
							: format.dateTime(builtAt, { dateStyle: "medium" }),
					})}
				</p>
			</section>
		</article>
	);
}

function CoverParty({
	label,
	name,
	logoUrl,
	logoAlt,
}: {
	label: string;
	name: string | null;
	logoUrl: string | null;
	logoAlt: string;
}) {
	return (
		<div className="space-y-2">
			<dt className="text-muted-foreground text-sm">{label}</dt>
			<dd className="flex items-center gap-3">
				{logoUrl && (
					// biome-ignore lint/performance/noImgElement: a short-lived signed read of the brand logo, which next/image cannot optimize
					<img
						src={logoUrl}
						alt={logoAlt}
						className="h-10 w-auto max-w-40 object-contain"
					/>
				)}
				{name && <span className="font-medium">{name}</span>}
			</dd>
		</div>
	);
}

/**
 * Section text with its anchors placed where `blockIndex` puts them: before
 * block `blockIndex`, or after the last block when fewer remain — the rule
 * the download follows. Consecutive text blocks render together, so a list
 * or a table split by an anchor-free blank line stays one element.
 */
function AnchoredMarkdown({
	markdown,
	anchors,
	headingLevel,
	renderAnchor,
}: {
	markdown: string;
	anchors: readonly EditionAnchor[];
	headingLevel: number;
	renderAnchor: (anchor: EditionAnchor) => ReactNode;
}) {
	const blocks = splitMarkdownBlocks(markdown);
	const ordered = orderGlossyAnchors(anchors);

	const parts: Array<
		| { type: "text"; text: string }
		| { type: "anchor"; anchor: EditionAnchor }
	> = [];
	let text: string[] = [];
	const flush = () => {
		if (text.length > 0) {
			parts.push({ type: "text", text: text.join("\n\n") });
			text = [];
		}
	};
	let next = 0;
	for (let block = 0; block <= blocks.length; block++) {
		while (
			next < ordered.length &&
			Math.min(ordered[next].anchor.blockIndex, blocks.length) === block
		) {
			flush();
			parts.push({ type: "anchor", anchor: ordered[next].anchor });
			next++;
		}
		if (block < blocks.length) {
			text.push(blocks[block]);
		}
	}
	flush();

	return (
		<>
			{parts.map((part, index) =>
				part.type === "text" ? (
					// Parts have no identity beyond their position in the section.
					<SafeMarkdown
						key={index}
						markdown={part.text}
						headingLevel={headingLevel}
					/>
				) : (
					<Fragment key={index}>{renderAnchor(part.anchor)}</Fragment>
				),
			)}
		</>
	);
}

/** Keep only raster `data:` sources; everything else goes through the default guard. */
function urlTransform(url: string, key: string): string {
	if (key === "src" && RASTER_DATA_URL.test(url)) {
		return url;
	}
	return defaultUrlTransform(url);
}

function markdownComponents(headingLevel: number): Components {
	const Heading = headingTag(headingLevel);
	const heading: Components["h1"] = ({ children }) => (
		<Heading>{children}</Heading>
	);
	return {
		h1: heading,
		h2: heading,
		h3: heading,
		h4: heading,
		h5: heading,
		h6: heading,
		// Links read as their text, as they do in the download.
		a: ({ children }) => <>{children}</>,
		// Only an inline raster `data:` image renders; a remote one is never fetched.
		img: ({ src, alt }) =>
			typeof src === "string" && RASTER_DATA_URL.test(src) ? (
				// biome-ignore lint/performance/noImgElement: an inline data URI from the document text
				<img src={src} alt={alt ?? ""} className="h-auto max-w-full" />
			) : null,
		pre: ({ node, children }) => {
			const code = node?.children[0];
			const className =
				code && code.type === "element"
					? code.properties.className
					: undefined;
			const classes = Array.isArray(className)
				? className.join(" ")
				: String(className ?? "");
			return DIAGRAM_LANGUAGE.test(classes) ? null : (
				<pre>{children}</pre>
			);
		},
	};
}

function SafeMarkdown({
	markdown,
	headingLevel,
}: {
	markdown: string;
	headingLevel: number;
}) {
	return (
		<div className="prose prose-sm dark:prose-invert max-w-none">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				skipHtml
				urlTransform={urlTransform}
				components={markdownComponents(headingLevel)}
			>
				{markdown}
			</ReactMarkdown>
		</div>
	);
}

/** One appendix entry: inline Markdown, no block elements, no HTML, no images. */
function InlineMarkdown({ text }: { text: string }) {
	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			skipHtml
			urlTransform={urlTransform}
			allowedElements={["p", "strong", "em", "del", "code", "br"]}
			unwrapDisallowed
			components={{ p: ({ children }) => <>{children}</> }}
		>
			{text}
		</ReactMarkdown>
	);
}
