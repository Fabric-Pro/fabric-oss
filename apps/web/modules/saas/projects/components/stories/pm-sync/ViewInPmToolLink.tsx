import {
	detectPMTypeFromUrl,
	normalizeAdoWebUrl,
	pmDetectedTypeDisplayName,
} from "@repo/utils";
import { cn } from "@ui/lib";
import { ExternalLinkIcon } from "lucide-react";

/**
 * Validate + normalize a stored PM-tool URL. Returns a safe http(s) URL, or
 * null when the value is missing / not an absolute web URL. `normalizeAdoWebUrl`
 * rewrites legacy Azure DevOps REST-API endpoints to their browser URL.
 */
export function getValidExternalUrl(
	url: string | null | undefined,
): string | null {
	if (!url) {
		return null;
	}
	const normalized = normalizeAdoWebUrl(url);
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			return normalized;
		}
	} catch {
		// Not a valid absolute URL — render nothing rather than a dead link.
	}
	return null;
}

type Props = {
	/** The entity's stored PM-tool card URL (`externalUrl`). */
	externalUrl: string | null | undefined;
	/**
	 * Project-level PM-tool key (e.g. "gitlab"), used as a label fallback when
	 * the type can't be derived from the URL host.
	 */
	pmTool?: string | null;
	className?: string;
};

/**
 * "View in {PM tool}" external link. Renders nothing when the item has no valid
 * external URL. Callers gate this to the synced/linked state — it is the
 * "ticket exists, here it is" affordance and is deliberately NOT shown for
 * failure/conflict states. Opens the PM card in a new tab; theme-aware and
 * accessible (decorative icon `aria-hidden`, focus-visible underline).
 * `stopPropagation` keeps a click from triggering an enclosing row/card handler.
 */
export function ViewInPmToolLink({ externalUrl, pmTool, className }: Props) {
	const href = getValidExternalUrl(externalUrl);
	if (!href) {
		return null;
	}
	const toolName =
		pmDetectedTypeDisplayName(detectPMTypeFromUrl(externalUrl)) ??
		(pmTool ? (pmDetectedTypeDisplayName(pmTool) ?? pmTool) : null) ??
		"PM tool";
	const label = `View in ${toolName}`;

	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			aria-label={`${label} (opens in a new tab)`}
			onClick={(event) => event.stopPropagation()}
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:underline focus-visible:outline-none",
				className,
			)}
		>
			<ExternalLinkIcon className="size-3.5" aria-hidden="true" />
			<span>{label}</span>
		</a>
	);
}
