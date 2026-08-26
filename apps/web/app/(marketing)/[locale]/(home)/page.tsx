import { FabricPlatformSection } from "@marketing/home/components/FabricPlatformSection";
import { FinalCta } from "@marketing/home/components/FinalCta";
import { Hero } from "@marketing/home/components/Hero";
import { ImpactStats } from "@marketing/home/components/ImpactStats";
import { Newsletter } from "@marketing/home/components/Newsletter";
import { ContrastTableSection } from "@marketing/home/components/v3/ContrastTableSection";
import { FabricArchitectureSection } from "@marketing/home/components/v3/FabricArchitectureSection";
import { ForEveryTeamSection } from "@marketing/home/components/v3/ForEveryTeamSection";
import { IntegrationsSection } from "@marketing/home/components/v3/IntegrationsSection";
import { TrustSection } from "@marketing/home/components/v3/TrustSection";
import { WeaveAgentsSection } from "@marketing/home/components/v3/WeaveAgentsSection";
import { isPublicNewsletterEnabled } from "@marketing/shared/lib/public-newsletter";
import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";

const SITE_URL = "https://fabric.pro";

export const metadata: Metadata = {
	title: "Fabric | AI connected to your docs, apps, and people",
	description:
		"Fabric connects your meetings, documents, and tools into a living knowledge base — so every team gets instant answers, and your engineering team ships like never before.",
	keywords: [
		"team AI platform",
		"company knowledge base",
		"AI for business teams",
		"enterprise AI assistant",
		"AI connected to your tools",
		"knowledge management AI",
		"AI software development",
		"coding agents",
		"MCP integration",
		"AI workflow automation",
		"software delivery platform",
		"PRD generation",
		"AI SDLC automation",
		"multi-agent platform",
		"AI for every team",
		"team productivity AI",
		"AI search and answers",
		"document AI",
		"meeting intelligence",
		"agent platform",
	],
	authors: [{ name: "TechFabric" }],
	creator: "TechFabric",
	publisher: "TechFabric",
	robots: {
		index: true,
		follow: true,
		googleBot: {
			index: true,
			follow: true,
			"max-video-preview": -1,
			"max-image-preview": "large",
			"max-snippet": -1,
		},
	},
	openGraph: {
		type: "website",
		locale: "en_US",
		url: `${SITE_URL}/en`,
		siteName: "Fabric AI",
		title: "Fabric | AI connected to your docs, apps, and people",
		description:
			"Fabric connects your meetings, documents, and tools into a living knowledge base — so every team gets instant answers, and your engineering team ships like never before.",
		images: [
			{
				url: `${SITE_URL}/api/og?title=Give+your+whole+team+superpowers&description=AI+connected+to+your+docs%2C+apps%2C+and+people`,
				width: 1200,
				height: 630,
				alt: "Fabric — AI connected to your docs, apps, and people",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "Fabric | AI connected to your docs, apps, and people",
		description:
			"Fabric connects your meetings, documents, and tools into a living knowledge base — so every team gets instant answers, and your engineering team ships like never before.",
		images: [
			`${SITE_URL}/api/og?title=Give+your+whole+team+superpowers&description=AI+connected+to+your+docs%2C+apps%2C+and+people`,
		],
		creator: "@fabricai",
	},
	alternates: {
		canonical: `${SITE_URL}/en`,
		languages: {
			"en-US": `${SITE_URL}/en`,
			"x-default": `${SITE_URL}/en`,
		},
	},
	category: "Technology",
	classification: "Developer Tools",
};

// JSON-LD Structured Data for SEO
function JsonLd() {
	const organizationSchema = {
		"@context": "https://schema.org",
		"@type": "Organization",
		name: "TechFabric",
		url: "https://techfabric.com",
		logo: `${SITE_URL}/images/fabric-black-logo.png`,
		description:
			"The Complete Agent Engineering Platform for Software Development",
		sameAs: ["https://github.com/Fabric-Pro"],
		contactPoint: {
			"@type": "ContactPoint",
			contactType: "sales",
			url: "https://techfabric.com/contact",
			email: "contact@techfabric.com",
			availableLanguage: ["English"],
		},
	};

	const softwareSchema = {
		"@context": "https://schema.org",
		"@type": "SoftwareApplication",
		name: "Fabric AI Platform",
		applicationCategory: "DeveloperApplication",
		operatingSystem: "Web",
		offers: {
			"@type": "Offer",
			price: "0",
			priceCurrency: "USD",
			description: "Free to use — bring your own AI provider keys (BYOK)",
		},
		featureList: [
			"Context-aware AI Agents",
			"Code Generation from Context",
			"PRD and Spec Generation",
			"MCP Integration",
			"Durable Workflow Automation",
			"Multi-provider AI Support",
			"Semantic Context Search",
			"Agent Orchestration",
		],
	};

	const webPageSchema = {
		"@context": "https://schema.org",
		"@type": "WebPage",
		name: "Fabric — The Complete Agent Engineering Platform",
		description:
			"Build, ship, and iterate faster with AI agents for software development. From ingesting context to generating code.",
		url: `${SITE_URL}/en`,
		mainEntity: {
			"@type": "Product",
			name: "Fabric AI Platform",
			description:
				"Agent engineering platform that manages context for software development teams",
			brand: {
				"@type": "Brand",
				name: "TechFabric",
			},
			category: "Developer Tools",
			audience: {
				"@type": "Audience",
				audienceType: "Software Development Teams",
			},
		},
	};

	return (
		<>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(organizationSchema),
				}}
			/>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(softwareSchema),
				}}
			/>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(webPageSchema),
				}}
			/>
		</>
	);
}

export default async function Home({
	params,
}: {
	params: Promise<{ locale: string }>;
}) {
	const { locale } = await params;
	setRequestLocale(locale);

	return (
		<>
			{/* JSON-LD Structured Data */}
			<JsonLd />

			{/* Hero — provocative headline, editorial subtext */}
			<Hero />

			{/* Platform capabilities bento grid */}
			<FabricPlatformSection />

			{/* App integrations logo grid */}
			<IntegrationsSection />

			{/* Architecture — nested diagram: Context → Rules → Agents */}
			<FabricArchitectureSection />

			{/* For every team — department value props */}
			<ForEveryTeamSection />

			{/* Weave agents — specialists for every kind of work */}
			<WeaveAgentsSection />

			{/* Fabric vs Copilots — comparison table */}
			<ContrastTableSection />

			{/* Decision Lineage — trace decisions to artifacts */}
			<TrustSection />

			{/* Social proof */}
			<ImpactStats />

			{/* Public newsletter opt-in (rendered only when Fabric-main is configured) */}
			{isPublicNewsletterEnabled() ? <Newsletter /> : null}

			{/* Final CTA */}
			<FinalCta />
		</>
	);
}
