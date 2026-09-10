---
"fabric-app": patch
---

Agent discovery and registration no longer let the server be aimed at internal addresses

Fizzy #2380, found in the same QA round as the key-role gap. Agent discovery,
registration, refresh and health-checking all take a URL from the caller and
make the server fetch it, then return `healthy`, a response time and validation
errors. That is enough for an ordinary organization member, with no elevated
privilege, to map an internal network — cloud metadata, an admin port, anything
that trusts the network it sits on.

The membership half of the finding did not reproduce: all three discovery
procedures already carry `requireInputOrgPermission(AGENT_UPDATE)`, and SYSTEM
scope is admin-only on both write paths. The destination half was exactly right.
Nothing checked where the URL pointed.

`@repo/utils/url-security` already answers this and three other places in
`packages/api` use it — the agent registry never got it. Applying it was not a
straight copy for one reason: for those three a private destination is always
wrong, while for an agent it is often the point. Local development runs agents
on `localhost`, and a self-hosted deployment may legitimately keep them on its
own network.

So the block is unconditional and the exception is explicit, declared by whoever
runs the deployment rather than by whoever is making the request:

    AGENT_DISCOVERY_ALLOWED_HOSTS=localhost,127.0.0.1,host.docker.internal

In production an unset variable means no exceptions. Outside production it falls
back to loopback, so a fresh checkout works unconfigured while link-local and LAN
addresses stay refused. Nothing in a request can widen it.

Guards go on the request, not only on the write: a stored `deploymentUrl` is
editable, an update can move an agent to an address creation would have refused,
and the health monitor later probes stored URLs on a path with no caller to
refuse. `safeFetchOutbound` re-checks at DNS-resolution time and declines to
follow redirects, closing the two bypasses a one-time hostname check leaves open
— a public name that resolves to a private address, and a public host that 302s
to one. An allowlisted host is fetched directly, since blocking it at lookup time
is precisely what the operator said not to do.
