/**
 * Azure DevOps `azureProject` derivation.
 *
 * The ADO **project** segment (distinct from organization=owner and
 * repo=name) is NOT stored as a column — it is parsed from `repositoryUrl` at
 * call time. The live ADO code-search API requires it.
 *
 * Handles BOTH URL shapes:
 *   - modern: `https://dev.azure.com/{org}/{project}/_git/{repo}`
 *   - legacy: `https://{org}.visualstudio.com/{project}/_git/{repo}`
 *
 * Extracted into its own module (rather than living inline in `route.ts`) so it
 * is unit-testable as the source of truth without exporting non-handler symbols
 * from a Next.js route file.
 */

/** Extract the ADO project segment from a dev.azure.com / visualstudio.com URL. */
export function extractAdoProject(url: string): string | undefined {
	const m = url.match(/dev\.azure\.com\/[^/]+\/([^/]+)\/_git\//i);
	if (m) {
		return m[1];
	}
	const m2 = url.match(/\.visualstudio\.com\/([^/]+)\/_git\//i);
	return m2?.[1];
}
