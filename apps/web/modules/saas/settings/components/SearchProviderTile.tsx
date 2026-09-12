"use client";

import { SiteFavicon } from "@saas/shared/components/SiteFavicon";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { ExternalLinkIcon, SearchIcon } from "lucide-react";

export type SearchProviderSummary = {
	name: string;
	displayName: string;
	description: string;
	docsUrl?: string;
	costPerSearch: number;
};

export type SearchProviderConfigSummary = {
	isDefault: boolean;
	enabled: boolean;
	searchesCount: number;
	totalCost: number;
};

/*
 * Where each provider's brand mark comes from. Docs URLs mostly live on a
 * `docs.` subdomain whose favicon is the same, but a few point elsewhere
 * (YouTube's docs are on developers.google.com), so the site is named
 * explicitly where it matters and derived from the docs URL otherwise.
 */
const PROVIDER_SITES: Record<string, string> = {
	exa: "https://exa.ai",
	tavily: "https://tavily.com",
	firecrawl: "https://firecrawl.dev",
	jina: "https://jina.ai",
	youtube: "https://www.youtube.com",
	parallel: "https://parallel.ai",
};

function siteFor(provider: SearchProviderSummary): string | null {
	const known = PROVIDER_SITES[provider.name];
	if (known) {
		return known;
	}
	if (!provider.docsUrl) {
		return null;
	}
	try {
		const parsed = new URL(provider.docsUrl);
		return `${parsed.protocol}//${parsed.hostname.replace(/^docs\./, "")}`;
	} catch {
		return null;
	}
}

/**
 * One search provider, as a row: brand mark, name and state, one line of
 * description, one quiet line of facts, and the action at the end. Replaces
 * a card that spent five stacked blocks and three badge styles on the same
 * information.
 */
export function SearchProviderTile({
	provider,
	config,
	features,
	readOnly = false,
	onConfigure,
}: {
	provider: SearchProviderSummary;
	config?: SearchProviderConfigSummary | null;
	features: string[];
	readOnly?: boolean;
	onConfigure: () => void;
}) {
	const isConfigured = Boolean(config);
	const isEnabled = config?.enabled ?? false;
	const price =
		provider.costPerSearch === 0
			? "Free"
			: `$${provider.costPerSearch}/search`;

	return (
		<div className="app-surface flex items-start gap-3 rounded-xl p-4">
			<SiteFavicon
				url={siteFor(provider)}
				name={provider.displayName}
				size={32}
				fallback={<SearchIcon className="size-4" />}
			/>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
					<h4 className="truncate text-sm font-medium text-foreground">
						{provider.displayName}
					</h4>
					{config?.isDefault ? (
						<span className="fab-label text-highlight-ink">
							Default
						</span>
					) : null}
					{isConfigured ? (
						<span
							className={cn(
								"fab-label",
								isEnabled
									? "text-success"
									: "text-muted-foreground",
							)}
						>
							{isEnabled ? "Enabled" : "Disabled"}
						</span>
					) : null}
				</div>
				<p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
					{provider.description}
				</p>
				<p className="fab-label mt-2 flex flex-wrap items-center gap-x-2">
					<span>{price}</span>
					{features.slice(0, 3).map((feature) => (
						<span key={feature}>· {feature}</span>
					))}
					{config ? (
						<span>
							· {config.searchesCount} searches · $
							{config.totalCost.toFixed(2)}
						</span>
					) : null}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<Button
					variant="outline"
					size="sm"
					onClick={onConfigure}
					disabled={readOnly}
				>
					{isConfigured ? "Edit" : "Configure"}
				</Button>
				{provider.docsUrl ? (
					<Button variant="ghost" size="icon-sm" asChild>
						<a
							href={provider.docsUrl}
							target="_blank"
							rel="noopener noreferrer"
							aria-label={`${provider.displayName} documentation`}
						>
							<ExternalLinkIcon className="size-4" />
						</a>
					</Button>
				) : null}
			</div>
		</div>
	);
}
