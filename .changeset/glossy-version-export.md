---
"fabric-app": patch
---

Proposals and Business Cases can now be turned into a Glossy edition — a branded, stakeholder-ready version with internal scaffolding moved to an appendix, tightened executive text, and data-faithful visuals — reviewed and downloaded as PDF or DOCX from a new Glossy page, without changing the source document.

Fizzy #2589. Off by default behind the org-scopable `GLOSSY_EDITION` flag (`FABRIC_FEATURE_GLOSSY_EDITION`). Adds six tables (Glossy editions, build attempts, visual decisions, segment cache, project recipient brand, organization Brand kit) in one additive migration with RLS, and a `glossy-edition` Temporal task queue served by the existing worker. Enable the flag for an organization only after the web deployment and the worker are both live and the `glossy-edition` queue shows a poller. Documents without visual slots are written byte for byte as before on every AI and API write path. When a visual slot is involved, the writers that splice slots from an earlier read (Update using context, the MCP and v1 document updates, the in-editor assistant accept, and document regeneration) now refuse to overwrite a newer version: the MCP tool returns an error, v1 answers 409 `DOCUMENT_VERSION_CONFLICT`, the editor keeps the accepted text and asks to reapply, and a stale regeneration is marked failed with the newer document kept.
