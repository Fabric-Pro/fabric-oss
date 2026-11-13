import type { ContrastPreference } from "@repo/utils/contrast-preference";
import { contrastPreferenceBootstrapScript } from "@saas/shared/lib/contrast-preference-dom";

/**
 * Sets the high-contrast class before the authenticated app paints (Fizzy
 * #1444). Rendered by the server layout ahead of any page content, so the
 * browser runs it while parsing, before it lays out what follows.
 *
 * A server component on purpose: an inline script only runs when it arrives in
 * the HTML. On a client-side navigation React inserts it without running it,
 * and `ContrastPreferenceProvider` applies the class on mount instead.
 */
export function ContrastPreferenceScript({
	preference,
	userId,
}: {
	preference: ContrastPreference;
	userId: string;
}) {
	return (
		<script
			// biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed bootstrap built from module constants and a two-value union (see contrastPreferenceBootstrapScript)
			dangerouslySetInnerHTML={{
				__html: contrastPreferenceBootstrapScript(preference, userId),
			}}
		/>
	);
}
