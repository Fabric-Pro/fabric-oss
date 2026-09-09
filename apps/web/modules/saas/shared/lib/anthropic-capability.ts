import { ANTHROPIC_PROVIDER_ID } from "@saas/settings/lib/ai-providers";

/**
 * The Anthropic capability notice: its approved copy, and the one rule that
 * decides whether the cross-app banner shows.
 *
 * Three surfaces tell the same story — the Anthropic card in Direct Providers,
 * the embedding prompt beneath it, and the app-chrome banner — so the wording
 * and the rule live here once. Nothing should retype these sentences: they are
 * product-approved, and a second copy is a second place to forget to change.
 *
 * The rule is a plain function of its two arguments rather than a hook so that
 * a consumer and a test can never disagree about when the banner appears.
 */

/** Notice heading. Product-approved wording (Fizzy #2289) — do not reword. */
export const ANTHROPIC_CAPABILITY_TITLE =
	"Some capabilities are unavailable with Anthropic";

/**
 * The body every surface shares. Product-approved wording (Fizzy #2289) — do
 * not reword.
 *
 * Its factual claim — that Anthropic serves no embeddings — is guarded by a
 * tripwire in this module's test that reads the provider registry rather than
 * restating it, so the sentence fails loudly rather than quietly going stale
 * if Anthropic is ever listed as embedding-capable.
 *
 * That tripwire reads the CLIENT mirror of the registry. It catches a backend
 * change only because `packages/database/__tests__/ai-provider-config-sync.test.ts`
 * holds the two lists together; without that test the guard would be one
 * package short of the authority it claims to check.
 */
export const ANTHROPIC_CAPABILITY_BODY =
	"Anthropic does not support embeddings, image generation, or audio. To use these features, configure an additional provider that supports them.";

/**
 * The banner's second sentence, which the card does not carry.
 *
 * Someone reading the card is choosing a provider; someone reading the banner
 * is already working, and needs to know which of the things in front of them
 * still work.
 */
export const ANTHROPIC_CAPABILITY_BANNER_DETAIL =
	"Chat and agents keep working. Document search, retrieval, and the context step in document generation do not.";

/**
 * The AI-config status payload, narrowed to the two fields this rule reads.
 *
 * Both describe the CALLER, and that is the whole point of the narrowing. The
 * procedure also returns `defaultProvider`, `embeddingProvider` and
 * `configuredProviders`, which describe the TENANT's stored rows; mixing the
 * two scopes in one predicate is precisely the bug this shape exists to make
 * unrepresentable (see the rule below).
 *
 * Declared here rather than inferred from the oRPC procedure so the rule
 * states the whole of its own input: a test can build one by hand, and a
 * change to an unrelated field of that procedure's output cannot quietly widen
 * what this rule is thought to depend on.
 */
export type AnthropicCapabilityStatus = {
	canResolveProvider: boolean;
	resolvedEmbeddingProvider: string | null;
	/**
	 * Whose configuration the resolution came from. Not part of the show/hide
	 * rule — the banner shows the same in either case — but it decides who the
	 * copy addresses, which role alone gets wrong: the resolver can land on the
	 * caller's own default inside an organization they do not administer.
	 */
	resolvedEmbeddingSource: "organization" | "user" | null;
};

/**
 * The two AI Providers settings pages, which carry the notice on the Anthropic
 * card and the embedding prompt already. Suffixes, because the same pages are
 * reached under an organization slug and under the account shell.
 */
const AI_PROVIDER_SETTINGS_PATH_SUFFIXES = [
	"/settings/ai-providers",
	"/settings/account/ai-providers",
] as const;

/**
 * Whether the cross-app capability banner should render.
 *
 * The rule asks what the embedding resolver will actually do for this caller.
 * It does NOT infer that from stored configuration — `resolvedEmbeddingProvider`
 * is computed server-side by calling the same resolver functions the runtime
 * calls, so the banner and the failing document search are answering the same
 * question with the same code.
 *
 * True only when every one of these holds:
 *
 * 1. There is a payload. Absent data means "we do not know yet", never "the
 *    resolver lands on Anthropic" — a status call that has not landed must not
 *    put a notice on the page.
 * 2. `canResolveProvider` is true. When it is false the AI-setup reminder is
 *    on screen saying nothing AI-shaped works at all, and that outranks a
 *    notice about which capabilities are missing from something that runs.
 * 3. The reader is not on one of the two AI Providers settings pages, where
 *    the same sentence already sits on the Anthropic card next to the
 *    embedding prompt that fixes it.
 * 4. The embedding path resolves to Anthropic. The id comes from the typed
 *    provider metadata, never a literal written here: the status payload types
 *    `resolvedEmbeddingProvider` as a plain `string`, so a mistyped literal
 *    would typecheck, never match, and leave this banner permanently dead —
 *    with fixtures built from the same typo passing all the while.
 *
 * PRECISION, stated so nobody reads more into this than it carries: the rule
 * equates "resolution lands on Anthropic" with "embeddings will fail", and that
 * holds to the accuracy of provider-level capability data, not absolutely. A
 * gateway whose only enabled route is Anthropic resolves as the GATEWAY, so the
 * banner stays quiet while embeddings still fail. That hole is one layer down,
 * in the capability check itself, and is recorded as pre-existing in this
 * change's plan rather than papered over here.
 *
 * Note what it deliberately does NOT read, and why. An earlier version ANDed
 * `defaultProvider === ANTHROPIC` with `embeddingProvider === null`. Those two
 * fields describe the TENANT's stored rows, while `canResolveProvider`
 * describes the CALLER — it is true when the caller's own personal default
 * rows resolve, even inside an organization that has configured nothing. That
 * mixture of scopes lied in three reachable states:
 *
 * - A fabricated organization default: the organization stores Anthropic as its
 *   default with no usable credential behind it, and `canResolveProvider` is
 *   true only because the caller's personal rows resolved. The banner fired
 *   about a configuration nothing ever runs on.
 * - An organization default whose credential does not work: same shape, broken
 *   key rather than a missing one. The caller's personal fallback may embed
 *   perfectly well, so the banner told someone whose document search works that
 *   it does not.
 * - A personal Anthropic default inside an organization with no providers: both
 *   tenant fields are null, so `defaultProvider !== ANTHROPIC` and the banner
 *   stayed silent — while the caller's own Anthropic default was exactly what
 *   ran and exactly what could not embed. The one person owed the notice never
 *   saw it.
 *
 * `configuredProviders` is not read either: a tenant running on an
 * embedding-capable resolution with a dormant Anthropic row in that list has no
 * gap to be warned about, and an early draft that scanned the list warned them
 * anyway.
 */
export function shouldShowAnthropicCapabilityBanner(
	status: AnthropicCapabilityStatus | undefined,
	pathname: string,
): boolean {
	if (!status) {
		return false;
	}

	if (!status.canResolveProvider) {
		return false;
	}

	if (
		AI_PROVIDER_SETTINGS_PATH_SUFFIXES.some((suffix) =>
			pathname.endsWith(suffix),
		)
	) {
		return false;
	}

	return status.resolvedEmbeddingProvider === ANTHROPIC_PROVIDER_ID;
}
