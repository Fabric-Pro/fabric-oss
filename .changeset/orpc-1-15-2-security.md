---
"fabric-app": patch
---

Update the oRPC server, client and OpenAPI packages to 1.15.2, fixing a denial-of-service in RPC request decoding and two prototype-pollution issues in schema coercion.

The denial-of-service was reachable before authentication: `RPCHandler` deserializes the request body before any middleware runs, so a crafted payload could exhaust CPU on any RPC endpoint. The two prototype-pollution issues were reachable through the smart-coercion plugin the API handler enables for OpenAPI requests. Advisories: GHSA-4p2c-m292-ghmh (high), GHSA-4h5r-cv8j-4456, GHSA-gcgf-fh7c-8gf2 and GHSA-j9v4-rhgr-4m5f.

The prompt-binding procedures moved from `prompts.bind` to `prompts.bindings` on the RPC surface. oRPC 1.15 reserves `bind`, `valueOf`, `toString` and `toJSON` on its recursive proxy client, so a router key named `bind` no longer resolves to the procedure group. The REST routes are declared explicitly and are unchanged, so `/prompts/bind` and its sub-paths continue to work.
