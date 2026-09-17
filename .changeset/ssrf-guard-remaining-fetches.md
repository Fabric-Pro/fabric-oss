---
"fabric-app": patch
---

MCP servers, search-provider endpoints, OpenID discovery and browser automation no longer let the server be aimed at internal addresses

Follow-up to the agent-endpoint fix. That one closed agent discovery; this
round is every other place the server fetches, connects to, or drives a
browser at a URL a tenant supplied and hands back enough of the result to
enumerate a network. Four sites, one shape:

- An MCP config's `baseUrl` is saved unchecked and connected to later on paths
  with no caller present. The client had a hostname check, but only in
  production and only until someone set `MCP_ALLOW_PRIVATE_URLS=true`, which
  turned the whole thing off. The OpenID discovery procedure fetched the
  caller's URL with a bare `fetch`.
- Tavily, Firecrawl and Parallel accept a self-hosted `endpoint`. It is saved
  by an ordinary member and every later search POSTs to it, including
  searches run by an AI tool with nobody watching.
- Browser automation drives a real Chromium to a caller's URL, then returns
  the page title, extracted content and screenshots.

The guard's allowlist logic now lives once in `@repo/utils/url-security` as
`createOutboundHostAllowlist`, and the agent registry uses it too. Same
philosophy: the block is unconditional and the exception is explicit, declared
by whoever runs the deployment rather than by whoever is making the request.

    MCP_SERVER_ALLOWED_HOSTS=localhost,127.0.0.1,host.docker.internal
    SEARCH_PROVIDER_ALLOWED_HOSTS=localhost,127.0.0.1,host.docker.internal
    BROWSER_AUTOMATION_ALLOWED_HOSTS=localhost,127.0.0.1,host.docker.internal

In production an unset variable means no exceptions. Outside production it
falls back to loopback, so a developer's local MCP server, self-hosted
Firecrawl or dev site works unconfigured while link-local and LAN addresses
stay refused. Nothing in a request can widen it. `MCP_ALLOW_PRIVATE_URLS` is
gone; a self-hosted deployment names its hosts instead of switching the check
off. Fabric's own `/api/mcp/*` routes on `NEXT_PUBLIC_SITE_URL` remain
permitted, and the test-connection route and the persisted-config client now
agree on that, where before each had its own list.

Guards go on the request, not only on the write. The MCP SDK transports take a
`fetch` implementation, so the client and the test-connection route hand them
one built on `safeFetchOutbound`: every initialize, SSE stream and JSON-RPC
POST is re-checked at DNS-resolution time and refuses redirects. The
`@ai-sdk/mcp` OAuth transport accepts no fetch, so on that path the URL is
resolved and checked before every connect instead. Search providers fetch
through the same guard, so an endpoint that was fine when stored cannot later
point inside, and the write and test procedures refuse it up front with the
variable named in the message.

A browser cannot be pinned the way `fetch` can, so it gets two layers. Every
`goto` resolves the hostname first, and each browser context carries a
Playwright route that judges every request the page then makes — the
navigation itself, redirects, subresources, page-script fetches — aborting any
aimed at a private, link-local or metadata address. It is registered after the
resource-type blocker on purpose: Playwright runs handlers newest-first, and
this one must see the request before anything else does.

Two review follow-ups. The browser guard no longer remembers an approving
decision: a name that resolved to a public address once can be rebound to an
internal one, and Chromium performs its own lookup for every connection, so
each request re-checks the current answer (concurrent requests to one origin
still share a single in-flight resolution, and refusals are still remembered).
And a residual is stated rather than hidden: OAuth-protected MCP servers are
connected through `@ai-sdk/mcp`, whose transport does not accept a custom
`fetch`, so that path gets the resolved-address check before every connect but
not the redirect-closed, DNS-pinned dispatcher the plain path gets. Moving it
onto the SDK transports with `authProvider` is the follow-up; it changes the
error type the OAuth flow keys on, so it is not folded into this change.

