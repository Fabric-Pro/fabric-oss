import { BlogListClient } from "@marketing/blog/components/BlogListClient";
import { getAllPosts } from "@marketing/blog/utils/lib/posts";
import { getBaseUrl } from "@repo/utils";
import type { Metadata } from "next";
import { getLocale } from "next-intl/server";

const baseUrl = getBaseUrl();

export async function generateMetadata(): Promise<Metadata> {
	return {
		title: "Blog | Fabric AI Insights",
		description:
			"Insights on enterprise digital transformation, legacy modernization, AI agents, and engineering best practices from the Fabric AI team.",
		keywords: [
			"digital transformation blog",
			"legacy modernization insights",
			"AI transformation articles",
			"enterprise engineering",
			"cloud migration strategy",
			"enterprise software modernization",
		],
		openGraph: {
			title: "Fabric AI Blog | AI Transformation Insights",
			description:
				"Expert insights on legacy modernization, AI transformation, and enterprise engineering practices.",
			url: `${baseUrl}/blog`,
			type: "website",
			images: [
				{
					url: new URL(
						"/api/og?title=Fabric+AI+Blog&description=Insights+on+AI+agents%2C+engineering%2C+and+software+delivery.",
						baseUrl,
					).toString(),
					width: 1200,
					height: 630,
					alt: "Fabric AI Blog",
				},
			],
		},
		twitter: {
			card: "summary_large_image",
			images: [
				new URL(
					"/api/og?title=Fabric+AI+Blog&description=Insights+on+AI+agents%2C+engineering%2C+and+software+delivery.",
					baseUrl,
				).toString(),
			],
		},
	};
}

export default async function BlogListPage() {
	const locale = await getLocale();

	const allPosts = await getAllPosts();

	// Filter posts by locale and published status
	const posts = allPosts
		.filter((post) => post.published && locale === post.locale)
		.sort(
			(a, b) =>
				new Date(`${b.date}T00:00:00`).getTime() -
				new Date(`${a.date}T00:00:00`).getTime(),
		);

	return (
		<div className="container max-w-7xl pt-32 pb-16">
			<div className="mb-12 pt-8 text-center">
				<div className="mb-4 inline-block rounded-full bg-primary/10 px-4 py-1.5 font-medium text-primary text-sm">
					Insights & Resources
				</div>
				<h1 className="mb-4 font-bold text-5xl">
					AI Transformation Insights
				</h1>
				<p className="mx-auto max-w-2xl text-lg opacity-60">
					Expert perspectives on legacy modernization, AI
					transformation, and enterprise engineering best practices.
				</p>
			</div>

			<BlogListClient posts={posts} />
		</div>
	);
}
