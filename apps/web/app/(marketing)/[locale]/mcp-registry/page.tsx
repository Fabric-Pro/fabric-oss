import { PublicMcpRegistryView } from "@marketing/mcp-registry/components/PublicMcpRegistryView";
import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";

export const metadata: Metadata = {
	title: "MCP Server Registry | Fabric",
	description:
		"Discover and explore Model Context Protocol (MCP) servers. Connect your AI applications to powerful tools and data sources.",
	openGraph: {
		title: "MCP Server Registry | Fabric",
		description:
			"Discover and explore Model Context Protocol (MCP) servers. Connect your AI applications to powerful tools and data sources.",
		images: [
			{
				url: "https://fabric.pro/api/og?title=MCP+Server+Registry&description=Discover+and+connect+MCP+servers+to+your+AI+applications.&label=Integrations",
				width: 1200,
				height: 630,
				alt: "Fabric MCP Server Registry",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "MCP Server Registry | Fabric",
		description:
			"Discover and explore Model Context Protocol (MCP) servers. Connect your AI applications to powerful tools and data sources.",
		images: [
			"https://fabric.pro/api/og?title=MCP+Server+Registry&description=Discover+and+connect+MCP+servers+to+your+AI+applications.&label=Integrations",
		],
	},
};

export default async function McpRegistryPage({
	params,
}: {
	params: Promise<{ locale: string }>;
}) {
	const { locale } = await params;
	setRequestLocale(locale);

	return <PublicMcpRegistryView />;
}
