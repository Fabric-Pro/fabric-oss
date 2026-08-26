"use client";

import { withReturnTo } from "@saas/settings/lib/settings-return-url";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * Hook that returns a helper to build settings URLs with the current page
 * as the `returnTo` destination.
 *
 * Usage in project components that link to settings pages:
 * ```tsx
 * const settingsHref = useSettingsReturnUrl();
 * <Link href={settingsHref("/app/settings/ai-providers")}>Configure</Link>
 * ```
 */
export function useSettingsReturnUrl() {
	const pathname = usePathname();
	const searchParams = useSearchParams();

	const currentUrl = searchParams.toString()
		? `${pathname}?${searchParams.toString()}`
		: pathname;

	return useCallback(
		(settingsHref: string) => withReturnTo(settingsHref, currentUrl),
		[currentUrl],
	);
}
