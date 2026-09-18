---
"fabric-app": patch
"@fabricorg/cli": minor
"@fabricorg/sdk": minor
---

The Fabric CLI can now keep a working copy current with a project's published coding instructions: `fabric instructions init --project <id> --tool claude-code` adds a session-start check and takes the first copy, `fabric instructions check` reports what changed, and `fabric instructions sync` applies it. A sync also repairs a working copy that drifted from the published version — an edited, deleted or chmod-ed instruction file is put back on the next run, without waiting for anyone to publish again — and `fabric instructions check --verify` reports that drift without changing anything.

The sync writes only inside the destination, refuses to follow a symlink out of it, touches nothing that is not an ordinary file, verifies every file's checksum before writing a single byte, and only removes a file its own record says it wrote and that still matches that record at the moment it is removed. The download is bounded by the manifest it has already validated rather than by what the response claims. In session-hook mode it never fails and never runs long: an unreachable server or an expired key becomes one line on stderr within a fixed deadline that covers waiting on the network, with the coding tool's own hook timeout as the hard stop for the decompression and hashing a timer cannot interrupt, and the last known-good files stay where they are. A project whose instructions come from a git repository gets no session hook, and an existing hook stops applying anything if the project is switched over later, because those instructions arrive with `git pull`; a person can still sync one by hand.

Which organization a request runs in is decided by the project, not by a stored default context, so a guest invited to a single project can sync it without belonging to the organization that hosts it.

Two new REST endpoints back it — `GET /api/v1/projects/:projectId/instructions/published` and `POST .../published/download` — reachable with an API key carrying `instructions:read` whose creator still holds the coding-instructions read permission on the project. `@fabricorg/sdk` exposes them as `fabric.instructions.getPublished()` and `fabric.instructions.createDownloadUrl()`.
