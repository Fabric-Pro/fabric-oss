"use client";

import { pmDetectedTypeDisplayName } from "@repo/utils";
import {
	AsanaBrandIcon,
	ClickUpBrandIcon,
	GitHubBrandIcon,
	GitLabBrandIcon,
	JiraBrandIcon,
	LinearBrandIcon,
	NotionBrandIcon,
} from "@saas/data-connections/components/ProviderIcon";
import type { ComponentType } from "react";

function AzureDevOpsBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.39L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.594z" />
		</svg>
	);
}

function FizzyBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<circle cx="12" cy="12" r="10" opacity="0.15" />
			<path d="M7.5 6h9v2.4h-6v2.85h5.1v2.4H10.5V18H7.5z" />
		</svg>
	);
}

function TrelloBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M21 0H3a3 3 0 00-3 3v18a3 3 0 003 3h18a3 3 0 003-3V3a3 3 0 00-3-3zM10.44 18.18a1.32 1.32 0 01-1.32 1.31H5.08a1.31 1.31 0 01-1.31-1.31V5.08a1.31 1.31 0 011.31-1.31h4.04a1.32 1.32 0 011.32 1.31zm9.79-7a1.31 1.31 0 01-1.31 1.32h-4a1.32 1.32 0 01-1.32-1.32V5.08a1.32 1.32 0 011.32-1.31h4a1.31 1.31 0 011.31 1.31z" />
		</svg>
	);
}

function MondayBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<ellipse cx="4" cy="12" rx="2.4" ry="6.4" />
			<ellipse cx="12" cy="12" rx="2.4" ry="6.4" />
			<ellipse cx="20" cy="12" rx="2.4" ry="6.4" />
		</svg>
	);
}

type IconComponent = ComponentType<{ className?: string }>;

// Registry keys MUST match values produced by `detectPMTypeFromUrl()` in
// `packages/utils/lib/pm-tool-patterns.ts`. Bitbucket is intentionally
// omitted — its host is not in `PM_TOOL_HOST_PATTERNS`, so an entry here
// would be unreachable from URL detection and silently mask its absence.
const PM_TOOL_BRAND_ICONS: Record<string, IconComponent> = {
	"azure-devops": AzureDevOpsBrandIcon,
	fizzy: FizzyBrandIcon,
	jira: JiraBrandIcon,
	linear: LinearBrandIcon,
	github: GitHubBrandIcon,
	gitlab: GitLabBrandIcon,
	trello: TrelloBrandIcon,
	asana: AsanaBrandIcon,
	notion: NotionBrandIcon,
	monday: MondayBrandIcon,
	clickup: ClickUpBrandIcon,
};

/**
 * Resolve the brand-icon React component for a detected PM-tool type
 * (e.g. `"jira"`, `"azure-devops"`, `"fizzy"`). Returns `undefined` for
 * unknown types so callers can fall back to a generic cloud glyph.
 *
 * The detected-type strings are the same values produced by
 * `detectPMTypeFromUrl()` and stored in `pmCapabilities.detectedType`,
 * keeping the icon registry in sync with the host-pattern table at
 * `packages/utils/lib/pm-tool-patterns.ts`.
 */
export function getPmToolBrandIcon(
	pmToolType: string | null | undefined,
): IconComponent | undefined {
	if (!pmToolType) {
		return undefined;
	}
	return PM_TOOL_BRAND_ICONS[pmToolType];
}

interface PmToolBrandIconProps {
	pmToolType: string | null | undefined;
	className?: string;
}

/**
 * Render the brand logo for a detected PM-tool type. Returns `null` for
 * unknown / null types — callers should render their own fallback in
 * that case (the cloud toggle keeps the generic lucide `CloudIcon`).
 */
export function PmToolBrandIcon({
	pmToolType,
	className,
}: PmToolBrandIconProps) {
	const Icon = getPmToolBrandIcon(pmToolType);
	if (!Icon) {
		return null;
	}
	const label = pmDetectedTypeDisplayName(pmToolType) ?? "PM tool";
	return (
		<span
			role="img"
			aria-label={label}
			data-pm-tool-type={pmToolType}
			className="inline-flex items-center justify-center"
		>
			<Icon className={className} />
		</span>
	);
}
