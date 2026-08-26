import { LocaleLink, localeRedirect } from "@i18n/routing";
import { PostContent } from "@marketing/blog/components/PostContent";
import { ShareButtons } from "@marketing/blog/components/ShareButtons";
import type { Post } from "@marketing/blog/types";
import { getPostBySlug } from "@marketing/blog/utils/lib/posts";
import { getBaseUrl } from "@repo/utils";
import { getActivePathFromUrlParam } from "@shared/lib/content";
import Image from "next/image";
import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";

/**
 * Build the OG image URL for social media (must be absolute URL)
 * Uses API route for dynamic generation since social media can't fetch data URIs
 */
function getOgImageUrl(post: Post): string {
	if (post.image) {
		return post.image.startsWith("http")
			? post.image
			: new URL(post.image, getBaseUrl()).toString();
	}
	// Use API route for generated OG images
	const params = new URLSearchParams({
		title: post.title,
		tags: (post.tags || []).join(","),
	});
	return new URL(`/api/og/blog?${params}`, getBaseUrl()).toString();
}

type Params = {
	path: string;
	locale: string;
};

export async function generateMetadata(props: { params: Promise<Params> }) {
	const params = await props.params;

	const { path } = params;

	const locale = await getLocale();
	const slug = getActivePathFromUrlParam(path);
	const post = await getPostBySlug(slug, { locale });

	if (!post) {
		return {};
	}

	const ogImage = getOgImageUrl(post);

	return {
		title: post.title,
		description: post.excerpt,
		openGraph: {
			title: post.title,
			description: post.excerpt,
			type: "article",
			publishedTime: post.date,
			authors: post.authorName ? [post.authorName] : undefined,
			tags: post.tags,
			images: [
				{
					url: ogImage,
					width: 1200,
					height: 630,
					alt: post.title,
				},
			],
		},
		twitter: {
			card: "summary_large_image",
			title: post.title,
			description: post.excerpt,
			images: [ogImage],
		},
	};
}

export default async function BlogPostPage(props: { params: Promise<Params> }) {
	const { path, locale } = await props.params;
	setRequestLocale(locale);

	const t = await getTranslations();

	const slug = getActivePathFromUrlParam(path);
	const post = await getPostBySlug(slug, { locale });

	if (!post) {
		return localeRedirect({ href: "/blog", locale });
	}

	const {
		title,
		date,
		authorName,
		authorImage,
		authorLink,
		tags,
		body,
		excerpt,
	} = post;

	// Build the full URL for sharing
	const shareUrl = new URL(`/blog/${slug}`, getBaseUrl()).toString();

	// Format date safely
	const formatDate = (dateString: string) => {
		try {
			// Parse date - handle various formats
			const parsedDate = new Date(
				dateString.includes("T")
					? dateString
					: `${dateString}T00:00:00`,
			);

			if (Number.isNaN(parsedDate.getTime())) {
				return dateString; // Return original if parsing fails
			}

			return new Intl.DateTimeFormat("en-US", {
				year: "numeric",
				month: "long",
				day: "numeric",
			}).format(parsedDate);
		} catch {
			return dateString; // Return original on error
		}
	};

	return (
		<div className="container max-w-6xl pt-32 pb-24">
			<div className="mx-auto max-w-4xl">
				<div className="mb-12">
					<LocaleLink href="/blog">
						&larr; {t("blog.back")}
					</LocaleLink>
				</div>

				<h1 className="font-bold text-4xl">{title}</h1>

				<div className="mt-4 flex flex-wrap items-center justify-start gap-6">
					{authorName && (
						<div className="flex items-center">
							{authorImage && (
								<div className="relative mr-2 size-8 overflow-hidden rounded-full">
									<Image
										src={authorImage}
										alt={authorName}
										fill
										sizes="96px"
										className="object-cover object-center"
									/>
								</div>
							)}
							<div>
								{authorLink ? (
									<a
										href={authorLink}
										target="_blank"
										rel="noopener noreferrer"
										className="font-semibold text-sm opacity-50 transition-opacity hover:opacity-100"
									>
										{authorName}
									</a>
								) : (
									<p className="font-semibold text-sm opacity-50">
										{authorName}
									</p>
								)}
							</div>
						</div>
					)}

					<div>
						<p className="text-sm opacity-30">{formatDate(date)}</p>
					</div>

					<div className="ml-auto">
						<ShareButtons
							title={title}
							url={shareUrl}
							tags={tags}
							description={excerpt}
						/>
					</div>
				</div>

				{tags && (
					<div className="mt-4 flex flex-wrap gap-2">
						{tags.map((tag: string) => (
							<LocaleLink
								key={tag}
								href={`/blog?tag=${encodeURIComponent(tag)}`}
								className="rounded-full bg-primary/10 px-3 py-1 font-semibold text-primary text-xs uppercase tracking-wider transition-colors hover:bg-primary/20"
							>
								#{tag}
							</LocaleLink>
						))}
					</div>
				)}
			</div>

			<div className="pb-8">
				<PostContent content={body} />
			</div>
		</div>
	);
}
