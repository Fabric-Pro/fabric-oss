---
"fabric-app": patch
---

MCP App frames no longer run third-party HTML in the app's own origin

An MCP App is HTML served by whichever MCP server a user has configured
(Excalidraw by default, but `baseUrl` is free text). The host fetches that HTML
and loads it into an iframe through a blob: URL. A blob: document inherits the
origin of the page that created it, and the iframe sandbox granted
`allow-same-origin`, so a malicious or compromised MCP server had a script
running as the Fabric origin: it could read `window.parent.document`, the app's
local storage, and call the API with the user's session cookie. Every user who
rendered that server's tool output was exposed.

The sandbox now drops `allow-same-origin`, in both places it was declared, the
iframe attribute and the `sendSandboxResourceReady` payload for the sandbox
proxy flow, through one shared constant. The frame runs in an opaque origin.
Nothing the apps need depends on same-origin: the bridge posts with a `"*"`
target and validates `event.source`, relative assets resolve through the
injected `<base href>`, and the host already fetches every MCP resource and
tool call on the app's behalf, so nothing inside the frame ever needed cookies.
The default Excalidraw app was checked against an opaque origin; its storage
access is wrapped in try/catch and degrades to no local checkpoint cache.

A source test pins the constant so the flag cannot come back in a refactor.
