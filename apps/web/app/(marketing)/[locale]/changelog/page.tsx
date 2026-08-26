import { ChangelogSection } from "@marketing/changelog/components/ChangelogSection";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export const metadata: Metadata = {
	title: "Changelog | Fabric",
	description:
		"See what's new in Fabric — product updates, improvements, and new features.",
	openGraph: {
		title: "Changelog | Fabric",
		description:
			"See what's new in Fabric — product updates, improvements, and new features.",
		images: [
			{
				url: "https://fabric.pro/api/og?title=Changelog&description=Product+updates%2C+improvements%2C+and+new+features+from+Fabric.&label=Updates",
				width: 1200,
				height: 630,
				alt: "Fabric Changelog",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "Changelog | Fabric",
		description:
			"See what's new in Fabric — product updates, improvements, and new features.",
		images: [
			"https://fabric.pro/api/og?title=Changelog&description=Product+updates%2C+improvements%2C+and+new+features+from+Fabric.&label=Updates",
		],
	},
};

export default async function PricingPage() {
	const t = await getTranslations();

	return (
		<div className="container max-w-3xl pt-32 pb-16">
			<div className="mb-12 text-balance pt-8 text-center">
				<h1 className="mb-2 font-bold text-5xl">
					{t("changelog.title")}
				</h1>
				<p className="text-lg opacity-50">
					{t("changelog.description")}
				</p>
			</div>
			<ChangelogSection
				items={[
					{
						date: "2024-03-01",
						changes: ["🚀 Improved performance"],
					},
					{
						date: "2024-02-01",
						changes: ["🎨 Updated design", "🐞 Fixed a bug"],
					},
					{
						date: "2024-01-01",
						changes: ["🎉 Added new feature", "🐞 Fixed a bug"],
					},
				]}
			/>
		</div>
	);
}
