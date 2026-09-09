---
"fabric-app": patch
---

Fabric now says up front that Anthropic cannot serve embeddings, image generation or audio, on its provider card and across the app.

Anthropic serves chat, reasoning and tool-calling, and nothing else. Configuring
it produced a success state and no warning, so the contradiction surfaced later
and somewhere else: the AI Models page showing "No models available" against
Embeddings, Image Generation and Audio, or a document search with nothing to
search. Nothing connected that emptiness back to the upstream choice.

Three surfaces changed.

**The Anthropic card** in Direct Providers now carries the limitation beside
its description, on both the personal and the organization pages. It renders
whether or not Anthropic is configured, because saving a key does not close a
vendor gap. Both direct-provider grids gained `items-start`: without it CSS
Grid stretches every card in a row to the tallest, so the notice's height would
have padded blank space under the Configure buttons beside it.

**A new app-wide banner** follows the person who configured Anthropic days ago
and has forgotten. The settings page already said no embedding provider was
set, but it said so to someone standing on the page that fixes it.

**The existing AI-setup reminder** stopped naming Anthropic among the keys that
enable "chat, agents, and document generation". That claim was false — document
generation runs a retrieval step needing embeddings — and it reached the reader
*before* the provider list. It originated in the BYOK-only change, where the
concern was not to overstate the outage; the caution understated the limit
instead. Anthropic keeps a mention rather than vanishing, because silence would
be accurate and unhelpful to someone already holding such a key.

The banner's predicate is worth recording, because two obvious versions are
wrong. It does not ask whether Anthropic is configured, and it does not ask
whether the tenant's default is Anthropic. It asks the status procedure what
embedding resolution will **actually land on for this caller**, and fires when
that is Anthropic.

The reason is that the status payload mixes scopes: `configuredProviders`,
`defaultProvider` and `embeddingProvider` describe the tenant, while
`canResolveProvider` describes the caller and consults their own rows. A
predicate combining them is wrong in three reachable states — an organization
with rows but none marked default, where the handler back-fills one the
resolver would never pick; an organization whose Anthropic default carries a
dead credential, where the resolver falls through to the caller's personal
provider; and a personal Anthropic default inside an organization with no
providers, which the tenant-scoped fields cannot see at all. The first two make
the banner claim a working system is broken; the third makes it stay silent
while document search really is.

So `aiConfig.resolution.getStatus` now reports `resolvedEmbeddingProvider`,
computed by calling the functions the runtime calls —
`getEmbeddingProviderConfig`, then `getAiProviderApiKey` — rather than restating
their logic. It is computed before the `defaultProvider` back-fill so it cannot
inherit that invention, and only the provider identifier leaves the procedure;
the credential material those resolvers return is stored ciphertext and is
dropped where it is read.

It stops one rung short of the runtime on purpose. The runtime's last resort for
an embedding is the deployment's own platform gateway key, and following it here
would buy nothing while costing two things: that config encrypts its key on
every call, and `encryptApiKey` runs a synchronous scrypt, which does not belong
on an endpoint the app shell hits on every page load — and the value it returns
is hardcoded to `VERCEL_GATEWAY`, which would tell every tenant that the
deployment holds a platform key. It can never be the provider a caller needs
warning about, so `null` here means "nothing the tenant can reach", which is
what the notice needs to know.

The cost is two extra reads in personal context and up to three inside an
organization, on a query the client caches for a minute; correctness by
construction was worth it. The call is wrapped, like the model lookup beside it,
because other surfaces read this endpoint and treat a failed call as "not
configured" — two new reads must not take them down.

Three deliberate silences. It says nothing while the answer is unknown, since a
call that has not landed must not paint a notice on every page. It says nothing
while the AI-setup reminder speaks, because "nothing resolves at all" already
covers "this provider cannot embed". And it says nothing on the two provider
settings pages, which already carry the same sentence on the card beside the
prompt that fixes it.

A member who cannot edit the organization's providers is told an admin must
assign one, and is given no control. The sibling reminder offers such a reader
"add a personal key", and is right to — `resolveTenantProviderConfig` has a
personal fallback, so chat really does start working. `getEmbeddingProviderConfig`
has none: inside an organization a personal embedding provider is never
consulted. Copying the sibling's role split would have sent that reader to do
something that changes nothing.

Dismissal lasts the session rather than the pathname, the one place it departs
from its sibling — that banner reports a total outage and earns the right to
ask again on the next page. It is keyed to the organization it was made in, so
switching workspaces does not carry one tenant's dismissal into another's real
gap.

Scoped to Anthropic on purpose. A provider capability registry already exists
and Anthropic is absent from all three lists, so generalising later is data
work — but the gaps are not uniform. DeepSeek, Perplexity, xAI and Cerebras
share all three; Groq serves audio transcription and shares only two. Copying
this three-capability sentence onto a Groq card would ship a false claim about
a vendor.

One pre-existing hole is left untouched and should not be read as a regression
from this change: a gateway whose only enabled sub-provider is Anthropic can
still be assigned as the embedding provider, because `canProviderSupportEmbeddings`
checks that the gateway is configured rather than what it routes to.

The copy lives in one module that all three surfaces import, and its factual
claim is guarded by a test reading the provider registry rather than restating
it, so the sentence fails loudly rather than going quietly stale if Anthropic
is ever listed as embedding-capable.
