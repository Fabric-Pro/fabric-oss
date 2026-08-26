"use client";

import {
	GitHubBrandIcon,
	GitLabBrandIcon,
	JiraBrandIcon,
} from "@saas/data-connections/components/ProviderIcon";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { cn } from "@ui/lib";

/**
 * Fabric's own mark, adapted to the `Entry.Icon` shape the vendor logos use.
 *
 * `FabricLogo` sizes with a numeric `size` prop rather than a className, so the
 * wrapper pins it to the 16px the other marks render at. Kept theme-aware
 * (`variant="auto"`) — the black mark disappears on a dark row.
 */
function FabricRunIcon({ className }: { className?: string }) {
	return <FabricLogo className={className} size={16} />;
}

/**
 * The brand mark for a pipeline result's SOURCE — so a run's provider is legible
 * at a glance instead of inferred from the pipeline name.
 *
 * Keyed by the provider tag the ingestion pipeline stores on every run
 * (`TestPipelineRun.provider`), which is the same string the temporal mappers
 * emit. Brand SVGs are reused from the data-connections `ProviderIcon` rather
 * than redrawn; only Azure DevOps needed a new mark. Brand hex is deliberate
 * here (as in that component) — a recognisable logo is the point, and these are
 * the vendors' colours, not theme colour.
 */

function AzureDevOpsBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M0 8.877 2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707Zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415Z" />
		</svg>
	);
}

type Entry = {
	Icon: React.ComponentType<{ className?: string }>;
	/** Human provider name — the icon's accessible label and tooltip text. */
	label: string;
	/** Brand tint. Neutral-on-light for GitHub, whose mark is near-black. */
	colorClass: string;
};

const PROVIDERS: Record<string, Entry> = {
	"github-actions": {
		Icon: GitHubBrandIcon,
		label: "GitHub Actions",
		colorClass: "text-foreground",
	},
	"gitlab-ci": {
		Icon: GitLabBrandIcon,
		label: "GitLab CI",
		colorClass: "text-[#FC6D26]",
	},
	"azure-devops": {
		Icon: AzureDevOpsBrandIcon,
		label: "Azure DevOps",
		colorClass: "text-[#0078D7]",
	},
	"jira-xray": {
		Icon: JiraBrandIcon,
		label: "Jira (Xray)",
		colorClass: "text-[#2684FF]",
	},
	// Fabric's OWN runs. Missing from this map until now, and the omission was
	// invisible in code and glaring on screen: `AGENTIC_RUN_PROVIDER` is
	// "fabric-agentic", an unknown provider renders nothing, and on a project
	// that mostly runs its cases through Fabric that means almost every row in
	// the history had no mark at all — "I don't know what this execution is".
	//
	// The one entry that is deliberately NOT a vendor logo, so a Fabric-driven
	// run is distinguishable from a CI-reported one at a glance rather than
	// looking like a fifth external provider. Themed, not brand hex, for the
	// same reason.
	"fabric-agentic": {
		Icon: FabricRunIcon,
		label: "Fabric agentic run",
		// The mark carries its own colour, so no brand tint is applied over it.
		colorClass: "",
	},
};

/** The human label for a provider tag — falls back to the raw tag. */
export function pipelineProviderLabel(provider: string): string {
	return PROVIDERS[provider]?.label ?? provider;
}

/**
 * Render one provider's mark. An unknown provider (a source we ingest but have
 * no mark for) renders nothing rather than a broken/placeholder glyph — the row
 * still shows the provider name in its metadata line.
 */
export function PipelineProviderIcon({
	provider,
	className,
}: {
	provider: string;
	className?: string;
}) {
	const entry = PROVIDERS[provider];
	if (!entry) {
		return null;
	}
	const { Icon, label, colorClass } = entry;
	return (
		<span
			role="img"
			aria-label={label}
			title={label}
			className={cn("inline-flex shrink-0", colorClass, className)}
		>
			<Icon className="size-4" />
		</span>
	);
}
