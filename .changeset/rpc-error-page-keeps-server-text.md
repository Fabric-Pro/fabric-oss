---
"fabric-app": patch
---

When an API call fails with a proxy or platform error page, the browser console now shows the server's own text instead of a bare "Internal Server Error".

Fizzy #2249, logging point ("drops the server message"), closed after staging verification of the shipped change. A 500 in the API's own oRPC error envelope already kept its message. But a non-oRPC error body, such as a proxy's HTML page, a platform JSON error or malformed JSON, reached the client as a generic error:

- `orpcFetch` converted the body to a `{error, message, status}` shape that the oRPC decoder does not read.
- On staging, a 500 HTML page logged only "Internal Server Error".

Such bodies are now rewrapped as oRPC's error envelope (`modules/shared/lib/rpc-error-envelope.ts`):

- The code and message are the ones oRPC picks for the status, so toasts are unchanged and no raw HTML reaches the UI.
- The server's text, trimmed and capped at 200 characters, goes in `data.responseText`.
- `logRpcFailure` prints it as `Server response: …`.

Successful responses and the API's own errors pass through untouched.
