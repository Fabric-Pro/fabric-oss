---
"fabric-app": patch
---

Refuse the MCP gateway's standalone GET stream with 405 so spec-following clients stop reconnecting once a second

Fizzy #2347. `GET /api/mcp-gateway` answered every request with a 200 JSON info page, including the `Accept: text/event-stream` GET a Streamable HTTP client opens to listen for server-initiated messages. The gateway has no such stream, so to the client that response was a stream that closed the instant it opened, and it reconnected — about once a second, for the life of every session, on every developer machine with a coding-agent client configured against the gateway.

Production runtime logs over 24 hours showed roughly 219,000 requests to this route, all HTTP 200, 13x every other route combined; a sampled window was 40 of 40 lines `GET /api/mcp-gateway 200` with no POSTs. None of it authenticated or reached the database: `pg_stat_statements` over the same fortnight showed about 2,800 API-key-authenticated gateway requests in total, under a second of execution time. The card that opened this work attributed the volume to per-request auth re-verification and Neon egress; the measurements do not support that, and a Redis-backed auth cache built against that premise was set aside unshipped.

The Streamable HTTP spec says a server that offers no GET stream MUST answer 405, and official SDK clients treat 405 as "no standalone stream here" and stop asking. The GET handler now returns 405 with `Allow: POST, DELETE` and an empty body when the Accept header names `text/event-stream`, mirroring what the sibling `/mcp` route already does. GETs that do not ask for a stream keep the info page, so browsers and health checks are unaffected. Four route tests pin both halves.
