# Developer Guide: Coding Instructions on the Command Line

How `fabric instructions check | sync | push | init` keeps a checkout current with a project's published coding instructions, how `init` sets a checkout up in one command (finding the project from the checkout itself and adopting the folder it runs in), how a local edit gets suggested back, how `fabric instructions doctor` checks a machine against what the instructions expect, what each command says when it ends, and what each command is allowed to touch.

- **Audience**: engineers working on `@fabricorg/cli`, `@fabricorg/sdk` or the v1 REST surface; developers setting a project up on their own machine
- **Owner**: Projects / Platform team

## What this is for

A project publishes a tree of coding instructions in Fabric — `AGENTS.md`,
`.claude/` or `.codex/` skills, rules, and settings. These commands put that tree into a working
copy and keep it current, so a coding agent reads the same instructions
everyone else does without anybody pasting anything.

The intended trigger is a Claude Code or Codex `SessionStart` hook: every
session asks whether the published version moved, and either says so or applies
it.

There are two shapes of project, and the commands treat them differently.

- **Repository-sourced** (the instructions are committed to a git repository
  and mirrored into Fabric): the working copy is a real clone of that
  repository, with its own `.git`. Fabric is an interface on top of the
  clone, not a second copy of it, so these commands never download or write
  instruction files for such a project. `init` sets the folder up (cloning
  into an empty one) and writes the session hook; at each session start the
  hook brings the checkout up to the branch with a fast-forward when that is
  safe, and otherwise says in one line why it did not.
- **Uploaded** (the files were uploaded from the Coding Instructions tab):
  there is no repository, so `sync` copies the published tree into the folder
  and keeps a ledger, `.fabric/instructions.lock`, of what it wrote.

Working on the project is also when the instructions are most obviously wrong,
so the traffic goes both ways: `fabric instructions push` sends the checkout's
edits back as a **proposal** an editor approves in the tab, or — with
`--publish`, and a key granted that separate authority — as a new version
directly. An agent with no CLI can only propose: the MCP tools
`fabric_propose_project_instruction_change` and `fabric_add_instruction_lesson`
have no publish mode and no scope that would reach one. All of it lands in the
same place and runs the same checks as a folder upload from the browser.

## Install and authenticate

Nothing has to be installed first. The deployment serves the build it supports,
and one `npx` line runs it straight from its URL (Node.js 22 or later is the
only requirement; `npx` comes with it):

```bash
npx -y https://example.com/cli/fabric-<version>-<build>.tgz instructions init --project <id> --tool claude-code
```

The Connect dialog shows the exact line for the deployment, the project and
the tool. It always names the project (`--project <id>`), because the sign-in
is for that one project and a connection made from a project reaches that
project alone, and it always writes the tool (`--tool claude-code` or
`--tool codex`), because without it `init` writes a hook for every tool found
on the machine. Run it where the project's instructions are: the top folder of
the clone, or the project's folder inside it when the instructions live in a
subfolder, never any other folder; an uploaded project's line is run in the
folder the agent works in. For a machine with no clone yet, one command clones
and sets up:

```bash
npx -y https://example.com/cli/fabric-<version>-<build>.tgz instructions init --project <id> --tool claude-code --clone <dir>
```

Each line is one command with no `&&` and no `cd`, so it runs in Windows
PowerShell 5.1 too.

The tarball a deployment serves is packed for that deployment. When it knows
the deployment's origin it talks to that deployment (and signs in to it)
without `--base-url`; the dialog adds `--base-url <origin>` to the line
whenever the page you are on is not that origin, and always when the build knew
none. `<build>` is ten hex digits of the bundle's own hash: the version changes
only on a release, `npx -y <url>` keeps running whatever it first fetched from a
URL, and a changed build has to be at a URL it has not seen. A tarball name an
earlier deployment served is answered with a redirect to the current one.

**The package on npm is not the way in.** It is the same CLI built for no
deployment, and its latest release predates `--base-url`, so a line that names a
deployment fails there. It is only for a machine that wants a global `fabric`
for everyday use (`npm install -g @fabricorg/cli`), and its commands need
`--base-url` for any deployment but `https://fabric.pro`.

#### How a command refers to itself

A person who ran the `npx` line has no `fabric` command, so the CLI never tells
anyone to run one it knows is not there. Every command a message tells you to
run starts the way this install is started: `fabric` for a globally installed
CLI, and `npx -y <tarball URL>` for the served build, wherever it runs from: its
tarball, or the copy a hook keeps (below). The line is short, and it keeps
working after the deployment ships a newer build, because a tarball name it
served earlier answers with a redirect to the current one. Only a served build
that never learned its tarball's name (one packed by hand) says `node <file>`,
naming the file it runs from. The examples in this guide say `fabric` for short.

### Signing in

**`init` does this for you.** With no sign-in for the project, meaning no key
and no browser sign-in of that project's own (see [A sign-in for one
project](#a-sign-in-for-one-project)), `init` opens the browser once, you
approve it, and setup carries on. It does not need a terminal: an agent running
the line for you (no terminal on either end) gets the URL on stderr to hand
over, and `init` waits up to five minutes for you to finish, then gives up with
`Could not sign in to <origin>`. Two cases refuse instead, naming the one line
to run, and exit 3: a run under `CI` (the `CI` environment variable set to
anything but empty, `0` or `false`), where nobody can finish a browser sign-in,
and a session hook, which never signs anybody in — it has no one to ask, and it
must never open a port or a browser:

```text
Not signed in to https://example.com. Run: fabric auth login --base-url https://example.com --project <id>
```

Every other command, run by hand, says the same, and the hook says it on stdout
(see "What each command says").

To sign in on its own, sign in to the deployment that hosts the project:

```bash
fabric auth login --base-url https://example.com
```

With no key, `login` signs in through the browser (OAuth 2.1, authorization
code with PKCE S256):

1. It reads the gateway's protected-resource metadata
   (`/.well-known/oauth-protected-resource/api/mcp-gateway`) and the
   authorization server's metadata, and refuses either when the issuer does not
   match or an endpoint points at another origin.
2. It registers itself as a public client named "Fabric CLI" with a
   `http://127.0.0.1:<port>/callback` redirect, once per profile and
   deployment. A later login reuses that client on any port, and registers a
   new one only when the server no longer knows it.
3. It opens the browser (and prints the URL in case it cannot), where you
   choose the organization and approve the CLI. The approval lists exactly
   what the CLI may do: read the organization's projects and context, read
   coding instructions, and suggest changes to them for review. It never
   publishes.
4. It waits up to five minutes for the callback, checks its `state`, and
   exchanges the code for tokens bound to `<deployment>/api/v1`.

The profile keeps the access token, the refresh token and their expiry, in the
same owner-only (`0600`) config file that holds a key. The access token lives
an hour; the CLI renews it when it expires within 60 seconds or the server
answers 401. Refresh tokens rotate, and the server ends the whole sign-in if a
spent one is presented again, so a renewal holds a lock file beside the profile
(`<config>.refresh.lock`, taken over after 30 seconds if its holder died) and
re-reads the profile once it has the lock: two session-start hooks that start
together renew once, not twice.

Every write to the config file, whether a login, a logout, `fabric ctx` or a
renewal's save, also takes a second lock for the milliseconds it lasts
(`<config>.write.lock`, taken over after 10 seconds if its holder died, waited for
up to 8) and reads the file again inside it, so a write that began before another
process's write never puts the file back as it was. That matters most for a
renewal's rotated refresh token: written back as the spent one, it would be
replayed at the next renewal, and the server ends every sign-in of this CLI's
client when it sees a spent refresh token again, for every project and for the
organization-wide one. It is not the refresh lock, which a renewal holds across a
network round-trip and writes under.

`fabric auth logout` revokes the refresh token and the access token at the
server, then clears the profile. A sign-in shows under **Account → Connected
agents**, where revoking it ends every token issued under it at once.

For CI and machines with no browser, sign in with an organization API key
instead (the Connect dialog's "CI or headless? Use an API key" section mints one):

```bash
fabric auth login --key <api-key> --base-url https://example.com
```

**A credential belongs to one deployment.** The CLI keeps one profile per
deployment, keyed by its origin (`https://example.com`), in the same
owner-only config file; a sign-in also records the `issuer` that granted it. A
browser sign-in is only ever sent to the origin of its issuer: a request for
any other origin is refused before anything is refreshed or sent, so a hook
written for one deployment can never hand its token to another. And a sign-in
is kept at all only when the server that granted it is the deployment's own:
the issuer's origin must be the origin the person asked to sign in to, or the
tokens are neither stored nor used and the command says so in one fixed
sentence. A deployment address that is not a URL (`--base-url`,
`FABRIC_BASE_URL` or the saved profile) is a failure, `The deployment address
is not a URL. Use --base-url https://example.com`, never a silent fall back to
the default deployment and its credential. Signing in to a
second deployment leaves the first one's profile alone and makes the new one
the active profile, which is what a command with no `--base-url` uses.
`fabric auth logout` clears the active profile's credential, and `fabric auth
logout --base-url <origin>` clears another deployment's, so a person signed in to
two of them can pick one without making it the active profile.

A config file written by an older CLI (profiles with a name and a `baseUrl`)
is read as if it were keyed by origin, and is saved in the new form the next
time anything is saved.

An explicit `--base-url` is stored with its profile, and every `fabric
instructions` command accepts `--base-url <origin>` to say which deployment one
run is for. Which deployment a command talks to is, in order: `--base-url`,
`FABRIC_BASE_URL` (an execution-time override, never stored), the deployment
the tarball was packed for, the active profile's, and the default. A login with
no `--base-url` from a deployment's own tarball signs in to, and keeps its
credential under, that deployment. `FABRIC_API_KEY` takes precedence over
anything stored.

### A sign-in for one project

A browser sign-in does not have to reach every project. The setup line in a
project's Connect dialog, and `init --project <id>`, sign in for that one
project:

```bash
fabric auth login --project <id> --base-url https://example.com
```

- **What it is.** The same browser sign-in, asked for the project's own
  resource, `<origin>/api/v1/projects/<id>`. The approval page names the project
  and asks for no organization. What the sign-in can reach is fixed by the
  server, not by this CLI: `GET /auth/whoami`, `POST /instructions/checkouts/resolve`
  and the routes under `/projects/<id>/`, and nothing else. Every other project,
  and every organization-wide route, answers 403. `--project` cannot be combined
  with `--key`, because a key is not limited to one project; and the CLI refuses a
  sign-in whose `whoami` does not report that project.
- **Where it is kept.** Beside the deployment's own credential, in the same
  profile, in an optional `projects` map keyed by project id. The config file
  stays at version 2: the map is an added field, and a file with no project
  sign-ins reads exactly as it did. Signing in for one project never replaces
  the deployment's key or its organization-wide sign-in, and neither of those
  replaces a project's.
- **Which credential a command uses.** In order: `FABRIC_API_KEY`; the project's
  own sign-in, for a command that names the project (`--project`, or a hook,
  which always does); the deployment's key or organization-wide sign-in. A command
  that names no project never uses a project's sign-in. `init` needs a key or
  the project's own sign-in: an organization-wide sign-in reaches every project,
  which is what a project's setup is there to stop relying on, so with only that
  one stored `init` signs in again for the project, once the checkout has named it.
- **Renewal and expiry.** It renews itself into its own entry, like the other
  sign-ins. When it has expired the line names the project:
  `Your sign-in to <origin> has expired. Run: fabric auth login --base-url <origin> --project <id>`.
- **Signing out.** `fabric auth logout --project <id>` revokes that sign-in at
  the server and removes it, and touches nothing else. `fabric auth logout`
  signs out of the deployment's own credential only, and says which project
  sign-ins are left and the line that ends one. Both take `--base-url <origin>`,
  as `login` and `whoami` do: it picks the deployment whose profile is used, and
  with `--project` that project's sign-in on it, whatever `FABRIC_BASE_URL` or the
  active profile say. The line that ends a project's sign-in on a deployment other
  than the default carries it.
- **Who it is.** `fabric auth whoami --base-url <origin> --project <id>` asks
  with that project's sign-in and adds a `Project` row; `--base-url` alone asks
  another deployment you are signed in to. `doctor`'s `auth` check says
  "signed-in session limited to this project", and, when the sign-in reaches every
  project, that this project has none of its own.

## The commands

### Finding the project from the checkout

`check`, `sync`, `init`, `doctor` and `push` take `--project <id>` as an
override. Without it they find the project from where they run:

1. the folder's git work tree, and each remote's **effective** fetch URL (after
   any `insteadOf` rewrite, so a remote rewritten to a local mirror is not
   taken for the repository);
2. each URL as the credential-free HTTPS spellings a deployment stores
   (`https://github.com/<owner>/<repo>`, `https://gitlab.com/<group>/.../<repo>`,
   and both `https://dev.azure.com/<org>/<project>/_git/<repo>` and
   `https://<org>.visualstudio.com/<project>/_git/<repo>` for Azure DevOps),
   sent to the deployment's checkout resolver — never a userinfo, port or
   query; a host a deployment cannot have connected is not asked about;
3. the answer is the projects **you can see** that sync their instructions
   from that repository, narrowed by the folder the command runs in (several
   projects can share a repository, each with its own `rootPath`).

| Answer | What happens |
|---|---|
| one project | the command carries on with it |
| several, and a terminal | it lists them and asks which |
| several, no terminal | exit 2, listing a `--project <id>` for each |
| none | exit 4: `This checkout's remote (github.com/owner/repo) is not connected to any project you can see. Connect the repository in Fabric first.` |

A project id, from `--project` or from the resolver's answer, and an
organization slug from `--org`, must be plain identifiers: letters, digits,
`.`, `_` and `-`, starting with a letter or digit, at most 64 characters. They
end up in the command line a session hook runs, so anything else is refused
(`--project must be a project id: …`, exit 2) before it reaches a hook, a
request or a line of output. A resolver answer with an id that is not one is
treated as no answer: the `none` line above, with nothing from the answer
printed. The organization and project names it lists have their control
characters taken out. A `--remote` value must be a plain git remote name
(letters, digits, `.`, `_`, `-` and `/`, not starting with `-` or `/`: the rule
the CLI applies to the remotes it reads from git), or it is refused with
`--remote must be the name of a git remote: …` (exit 2) before a hook can be
written with it.

`--remote <name>` looks at one remote only, which is how a checkout with two
remotes for the same repository (a fork and its upstream) is told apart.
Matching ignores letter case, on the CLI and on the deployment alike: GitHub,
GitLab and Azure DevOps names are case-insensitive, and an Azure DevOps
`<org>.visualstudio.com` remote spells the organization in lowercase whatever
the connected repository says. Only repository-sourced projects are found
this way; an uploaded project needs `--project`.

**A session hook never resolves.** It runs unattended at every session start,
and what it would answer could change between two sessions, so a hook names
its project. `--hook` without `--project` skips with `this hook names no
project. Run: fabric instructions init` on stderr and exits 0.

### `fabric instructions check [--project <id>] [--dest <dir>] [--verify] [--hook]`

Compares the digest in `<dest>/.fabric/instructions.lock` with the published
one and reports the difference. One request, no download, nothing written.
Informational: it exits 0 for a report, whatever the report says, and with the
documented codes only when the run itself failed — 3 not signed in, 4 project
not found, 2 usage (an unresolved project, a bad `--base-url`), 5 forbidden, 6
rate limited, 7 a refused or inconsistent source, 1 anything else. Under
`--hook` it always exits 0.

Without `--verify` it reads no local file at all, which is why "published
coding instructions unchanged" is the wording: it means the published version
has not moved, not that your copy still matches it. `--verify` also hashes
every file the lock names and reports the ones that drifted — edited,
deleted, chmod-ed or replaced by a symlink. It stays informational and still
exits 0. A file whose edit an earlier `sync` kept is reported as `(kept)`, and
the report names `fabric instructions sync --repair` as the way to replace it.
`--format json` also lists those paths as `keptEdited`.

### `fabric instructions sync [--project <id>] [--dest <dir>] [--dry-run] [--repair] [--hook]`

Applies the published version. It plans against the working tree rather than
the lock alone, so it can tell a file it wrote from a file the developer
edited, and reports which is which:

| Report line | What happened |
|---|---|
| added | the file was not there |
| updated | the file matched the lock, so the sync's own copy moved forward |
| replaced local edits | the file matched neither the lock nor the published bytes, and `--repair` was given |
| kept local edits | the same without `--repair`: the file stays as it is, and the lock records the published hash with `kept: true` |
| removed | the file left the snapshot and still matched the lock |
| kept, modified locally | the file left the snapshot but had been edited, so it stayed |
| kept, renamed in the published snapshot | the lock names it under one spelling and the manifest under another that means the same file — the write covers it, so the old spelling is left alone |

`--dry-run` prints that plan and downloads nothing.

**A sync downloads only what it writes.** A plan with up to 100 writes asks
`POST .../instructions/published/files` for a signed URL per written file and
downloads just those, eight at a time, so changing one file of a thousand
costs one download rather than the whole archive. Each file is checked against
the manifest entry the plan was made from — the manifest's size bounds the
read and its sha256 must match — and a mismatch refuses the run before
anything is written, the same rule the archive path applies. A plan with more
than 100 writes (a first sync, `--repair` of a wrecked tree) takes the archive
as before. If the published version moves after the plan was made, the route
answers 409 `PUBLISHED_CHANGED` before signing anything; the CLI then reads a
fresh manifest once, plans again, and takes the archive of what is published
now. It does not retry further.

A `sync` never accepts the server's "unchanged" on its own, and the ledger it
checks is validated before it is read: a lock naming `../outside`, a reserved
path, or two paths one filesystem cannot tell apart stops the run rather than
directing a read. That answer is
about the published snapshot, so before acting on it the command verifies the
lock's own ledger against the working tree. If a file is missing, has the
wrong mode or is no longer a regular file, it asks for the full manifest and
plans normally, which restores deleted files and repairs modes. An edit alone
needs neither: it is kept and listed, and the command answers from the
unchanged digest. With `--repair`, every drifted file is restored from the
published version, and an edited file comes back as **replaced local edits**,
because that is what overwriting it is.

**Local edits are kept.** A `sync` never overwrites a local edit to a synced
file unless `--repair` is given, in hook mode and by hand alike. New files and
the sync's own files still move forward in the same run. The report lists the
kept files under **kept local edits** and prints the `--repair` command with
the `--org` and `--dest` the run had. In hook mode the same news is also one
line on stderr, which also names the local-notes files:
``fabric: 3 local edit(s) kept; run `fabric instructions sync --project <id> --repair` to replace them. Keep notes meant only for this machine in CLAUDE.local.md or .claude/settings.local.json.``

- A file that was already in the checkout before the first sync, and differs
  from the published one, is kept the same way.
- So is a file saved or created while the run was downloading: every write
  re-hashes its target first and leaves it alone if it changed since the plan
  was made.
- When the `--dest` path cannot be pasted safely (it holds a newline), no
  command is printed; the report says to run `fabric instructions sync
  --repair` with the run's `--project` and `--dest` instead.
- A kept file whose published version later changes stays as it is. The lock
  records the NEW published hash, so `fabric instructions push` offers the edit
  as a change against the version everyone else now has.
- Notes meant only for one machine belong in `CLAUDE.local.md` or
  `.claude/settings.local.json`. Neither is ever part of a snapshot
  (`.claude/settings.local.json` at the top of the instruction set,
  `CLAUDE.local.md` at any depth), and `fabric instructions` never writes,
  deletes or pushes either one.

For a repository-sourced project (source of truth `REPOSITORY`), what `sync`
does depends on the directory it runs in; see
[Repository-sourced projects](#repository-sourced-projects). In a checkout of
the project's repository it downloads nothing and writes no lock, and
`--dry-run` and `--repair` are ignored because there is no download for them
to shape: by hand it only reports, and as a session hook (`sync --hook`) it
fast-forwards the checkout when that is safe (see below); `check --hook` only
reports. Outside any git checkout it syncs the
way it does for an uploaded project. In a checkout of some *other* repository
a sync run by hand still downloads, because for someone without access to the
project's repository a download is the only way to read the instructions at
all; a hook there stops with one line. Everywhere this cannot tell whether
the directory is a checkout of the project's repository — git could not
answer, the server reports no repository, a provider this build does not
know, two matching remotes, or the right repository in the wrong directory — `sync`
fails closed: a hook prints one line, and by hand it exits 7 with that line.
Nothing is written in either case.

The lock is read only once the directory is classified, and only where it is
used: a malformed, symlinked, unsupported or other project's lock left in a
checkout of the repository does not stop the report there. Its digest is
still sent with the first request as a hint when it can be read safely, so a
session start stays one request.

Every response a command acts on is held to the first one: when a later
response names a different source of truth or a different repository
configuration (provider, host, path, branch, root path or generation) — a
project switched while a sync was in flight — the command stops before it
plans, downloads or writes anything, exit 7 by hand and one skip line on
stderr under `--hook`.

`--format json` prints one JSON object instead of prose. Any other value —
`table`, `yaml`, `csv`, the defaults the rest of the CLI uses — prints text,
because these commands have no other shape. The flag resolves the way
Commander resolves it: `fabric --format table instructions check` beats
`FABRIC_FORMAT=json`, because the environment is the root option's default and
an explicit flag replaces a default.

### `fabric instructions push [--project <id>] [--dest <dir>] [--add <path>] [--publish] [--include-proposed] [--dry-run]`

Suggests this checkout's edits back to the project. By default it opens a
**proposal**: nothing changes for anybody reading the instructions until
somebody who can edit them approves it in the Coding Instructions tab, where
each changed file is reviewed as a unified diff of its two sides. `--publish`
sends the same change set as a new version with nobody in between — see
"publishing takes its own key" below for the key it needs.

The diff is computed against `<dest>/.fabric/instructions.lock`, so `sync` has
to have run here first — without that ledger there is nothing to diff against,
and the command says so rather than guessing. Four outcomes per locked path,
and nothing else is ever sent:

| Outcome | What happened |
|---|---|
| sent as a change | the local bytes differ from the hash the lock recorded |
| sent as a deletion | the lock names the file and nothing is there any more |
| skipped | the local bytes still equal the lock |
| left out as already proposed | one of your open proposals already makes this change: the same path with the same bytes, or the same deletion |

**A change you have already proposed is not sent again.** The lock names the
*published* version, and a proposal does not change what is published, so the
diff alone cannot tell an edit you already proposed from a new one. Without
this, a second session on the same checkout that edits another file would send
the first session's change as well, and its proposal (or pull request) would
carry that change twice. So before sending, `push` asks the server for your own
open proposals on the project (`GET .../instructions/proposals/open`, hashes
only) and leaves out every change one of them already carries. Each one is
listed as `<path> — already proposed in version <N>`, followed by the pull
request's URL when the proposal has one; `--dry-run` lists them the same way.
A file whose bytes differ from what the proposal carries is a new edit and is
sent as usual.

Only a proposal that can still reach review counts. It has to be stated
against the version your lock names, its checks have to be running or passed,
and on a repository-sourced project its pull request has to be queued, opening
or open. A proposal against an older version can no longer be approved, and a
failed, rejected or withdrawn one lands nothing, so their changes are sent
again. That costs a duplicate, whereas leaving them out could lose the edit.

`--include-proposed` sends every change, including ones your open proposals
already carry, without asking the server. If everything was already proposed,
a proposal push sends nothing, says so, and exits 0, because what you wanted
is already under review. The same case under `--publish` exits 7, because
nothing was published.

If the lookup cannot be made (a server that does not offer it yet answers
404, or the request fails or takes longer than 15 seconds), `push` prints
`Could not check your open proposals (<reason>)` on stderr and sends every
change. The server handles a duplicate correctly, since each proposal is
diffed against its own base, so the worst case is the extra copy this check
exists to avoid, never a lost edit. The answer is read strictly: a
malformed one, or one naming a proposal or pull-request state this CLI does
not know, counts as unavailable as a whole rather than being read in part.
`--format json` reports what was left out in `alreadyProposed` and whether the
check ran in `openProposalCheck` (`checked`, `skipped` under
`--include-proposed`, or `unavailable` with the reason). A `--publish` whose
every change was already proposed prints that JSON too, and then exits 7.

**A file the lock does not name is sent only when you name it**, with `--add
<path>` (repeatable). That is the one case the ledger cannot discover, and the
alternative — walking the checkout — would mean inventing a rule about which of
your repository's files are instruction files. The exclusion rules that decide
that live on the server, with the project's frozen settings, and the CLI has no
copy of them.

At most 50 changes in one push. A change set larger than that is a replacement
rather than an edit, and the tab's folder upload is the operation for it — it is
also the only path that re-reads the project's exclusion rules.

**Publishing takes its own key.** `--publish` is a different authority, not a
mode of the same one. The key the Connect dialog mints carries
`instructions:write`, which it offers to read-only roles and describes as
review-gated; publishing from that key would make the description untrue for
anybody holding `INSTRUCTION_CREATE`, and a scope has to mean the same thing
whoever mints it. So `--publish` calls a different route behind a different
scope, `instructions:publish`, which the Connect dialog never mints. To get
one, create an organization API key in **Settings → API keys** and tick
**Instructions Publish**; a read-only role cannot be granted it. The server
then checks, on every call, that the key's creator still holds
`INSTRUCTION_CREATE` on that project — the scope alone publishes nothing, and
a demotion takes effect at once. A key without the scope gets
`Missing required scope: instructions:publish` and exit code 5.

**A publish is not instant, and `READY` does not by itself mean it landed.**
What comes back is a version whose checks have just started: the same verify
→ secret-scan → publish run a folder upload goes through decides, and the
auto-publish that follows is a separate step that normally completes AFTER
this command has already returned. So the command reports "Published version
N" only once it has actually observed that — never inferred from the checks
alone — and otherwise says the version has been sent and publishes on its own
once its checks pass, pointing at the project's Coding Instructions tab to see
its state. That covers the ordinary case (the publish lands a moment later)
and the one worth naming explicitly: a concurrent edit's own publish can win
the race first, in which case this version stays `READY` and unpublished —
intact, not lost — and the tab's History is where to see that and publish it
deliberately if it is still wanted. The lock is not rewritten on either path —
run `fabric instructions sync` afterwards to bring the checkout onto the
version that landed.

`--dry-run` prints the change set and sends nothing; with `--publish` it says
so, because the two do different things.

**`--publish` leaves out already-proposed changes too.** Publishing a change
that is still waiting for review would skip that review and ship it in this
push's version, so the rule is the same in both modes. Once the version you publish
lands, the proposal that carries the left-out change is stated against an
older version and can no longer be approved; run `fabric instructions sync`
(which keeps your local edits) and push again to propose that change against
the new version. Add `--include-proposed` to publish it along with everything
else.

**Nothing is read until the lock is verified against the server.** `push` fetches
the published manifest first and refuses before opening a single file if the
lock names a version that is no longer published, or if its ledger is not that
version's file list. The lock is a plain JSON file in your checkout: anything
that can write to the working tree can add a path to it, and a command that
trusted the ledger would read that file and upload it. The manifest decides
which paths may be touched; `--add` is the only way to send anything else.

**The lock is never written by a push**, on any outcome, `--publish` included.
It names the published version, which is what `sync` compares against, and a
proposal does not change what is published. A publish does, but only once its
checks pass — after this command has returned — and what lands is the server's
manifest, inherited files and all, which this side cannot compute. Either way
`fabric instructions sync` is what brings the checkout, and the lock, forward.

Two refusals are worth recognising:

- *"published instructions moved past your last sync"* — somebody published
  while you were working. The server refuses rather than rebasing your change
  onto a version you never saw (the spec's `PULL_FIRST` rule; there is no
  server-side merge in any version). Run `sync`, re-apply the edit, push again.
- *the project's instructions come from its repository* — `--publish` on a
  project whose source of truth is `REPOSITORY`, where the files are changed in
  git and mirrored into Fabric. Commit and push to the repository instead.
  Nothing was sent.

On a repository-sourced project a push without `--publish` is a suggestion
that is reviewed and merged in the repository. Each member has one branch,
`fabric/instructions/members/<name>-<id>/<n>`, with one pull request: once the
files pass their checks Fabric adds the suggestion to that branch as one
commit, and opens the pull request if the branch has none yet. After that
pull request merges or closes, the next suggestion starts a new branch.

Unless `--no-wait` is given, `push` then waits up to 60 seconds for the
suggestion to reach the branch and for the branch's pull request to be open,
and ends on one line:

| Outcome | Line | Exit |
|---|---|---|
| First change on the branch | `Opened pull request <url>` | 0 |
| Added to an open pull request | `Added to your pull request <url>` | 0 |
| Every file already matched the branch | `Already on your branch; nothing to add.` | 0 |
| A file on the branch was changed outside Fabric (`BRANCH_CONFLICT`) | names the paths; make the change on the branch in the repository, or wait for the merge | 7 |
| A newer change of yours already edits the file (`SUPERSEDED_BY_LATER_CHANGE`) | names the paths; use Try again in the Coding Instructions tab, or withdraw it | 7 |
| Any other blocked state | the reason, and whether Fabric retries on its own | 7 |
| The pull request merged or closed while the change was being added | says so; the tab shows whether it carried the change | 0 |
| The pull request is being closed | push again once it has closed | 7 |
| The branch closed before its pull request opened | push again | 7 |
| The repository connection now points at another repository | close the pull request there, then stop tracking it in the Coding Instructions tab | 7 |
| The wait ran out | the pull request is being opened | 0 |

`--format json` carries the same outcome in `pullRequest`: `state`, `url`,
`failure` (with `params.paths` for the two conflicts), `timedOut`, and the
`branch` and `append` blocks REST v1 returns for the proposal. The already-proposed rule
applies to those suggestions as well, and the line for a left-out change
names the pull request (`already proposed in version <N>, pull request
<url>`). That keeps a second session's pull request free of the first
session's change.

### `fabric instructions init [--project <id>] [--tool <claude-code|codex>] [--clone [<folder>]] [--dest <dir>] [--remote <name>] [--apply] [--report-only] [--lessons] [--no-mcp]`

Sets a checkout up for a project's coding instructions: finds the project (see
above), signs in when it has to, takes over the folder it runs in, and writes
the `SessionStart` hook. For one project and one folder it is the only command
a developer runs.

**The hook, for every tool found.** `--tool` is optional. Without it, a coding
tool counts as present when its folder is in the checkout (`.claude`,
`.codex`) or in the home directory (`~/.claude`, `~/.codex`), or its command
(`claude`, `codex`) is on `PATH` (found by `stat`, never run), and every
present tool gets a hook in the one run. With none found, `init` writes
Claude Code's and says so; `--tool` names one tool and ignores the rest.
Claude Code writes `<dest>/.claude/settings.local.json` — never
`settings.json`; Codex writes `<dest>/.codex/hooks.json`. For an uploaded
project the hook runs `fabric instructions check` by default, so rules are not
swapped under a developer mid-task, and `--apply` makes it run `sync`
instead. For a repository project it runs `sync`, which fast-forwards the
clone when that is safe (see [What the hook does](#repository-sourced-projects));
`--report-only` writes `check` there instead. Running `init` again replaces
its own entry rather than adding a second one.

The command carries the deployment and, when `--remote` was given, the remote:

```text
<launcher> instructions check --project <id> --base-url <origin> [--remote <name>] [--org <slug>] --hook
```

`--base-url` binds the hook to the deployment `init` set it up against, so it
can only ever talk to that one. A hook written before hooks named a deployment
(no `--base-url`) still runs and is still recognised, so `init` replaces it
and `doctor` reports it as a warning.

**What `<launcher>` is.** A hook runs at every session start, in whatever shell
the coding tool uses, and a person who ran the `npx` line has no `fabric` on
`PATH`: a hook that said `fabric instructions …` would fail with `command not
found` every time. So the build a deployment serves, which is one file with
every dependency inlined, keeps a copy of itself where the hook can find it, and
the hook runs that:

```text
node <config folder>/cli/<deployment>/fabric.mjs instructions check --project <id> --base-url <origin> --hook
```

- The copy is one file per deployment, `cli/<deployment>/fabric.mjs` in the CLI's
  config folder (`%APPDATA%\fabricai-nodejs\Config` on Windows,
  `~/.config/fabricai-nodejs` on Linux, `~/Library/Preferences/fabricai-nodejs`
  on macOS), written to a temporary file and renamed into place, and replaced on
  every `init` and by its own daily update (next bullet), which is how a newer
  build reaches a machine that already has the hook. It is an `.mjs` file so Node
  loads it as an ES module wherever it sits. `update-check.json` sits beside it
  and holds when the copy last asked, and which tarball it was told about.
- **The copy updates itself**, once a day, so a deployment that ships a newer CLI
  reaches every machine that has the hook, without anyone running `init` again.
  At the end of a `check` or `sync` hook run, after the hook has printed what it
  has to say, and only when the file running is exactly the copy `init` keeps for
  the deployment the hook is bound to (`--base-url`; an `npx` run, the npm build
  or another deployment's copy never updates anything):
  1. It reads `<origin>/.well-known/fabric-cli.json` from that origin and
     compares the `tarball` path with the one baked into the running build. The
     same path ends the step (nothing is downloaded); `update-check.json` records
     the check either way.
  2. A different path is downloaded from the same origin (never a host the
     document names), with a size cap (8 MiB, 24 MiB unpacked) and no redirects.
     The SRI `sha512` in the document is checked against the bytes first, then
     `package/fabric.js` is read out of the gzip and tar in memory (matched by
     its exact name; nothing is extracted to disk and nothing is run) and must
     begin with the build's `#!/usr/bin/env node` line.
  3. It is written to a temporary file beside the copy and renamed over it, the
     way `init` writes it. The running process keeps its code; the new copy runs
     from the next session.

  The step is bounded so it can never delay or cost the hook's own output: it
  starts only when at least five seconds of the hook's ten-second deadline are
  unspent (a slow run skips it), it has a budget of four seconds of its own
  (`selfUpdateBudgetMs` in `hook-timing.ts`), and its output is at most one line
  on stderr, never stdout: `fabric: this CLI copy was updated to <version>; it
  runs from the next session`, or `fabric: this CLI copy was not updated (<why>);
  the earlier copy was kept`. A failure of any kind (no network, a non-2xx
  answer, an integrity mismatch, a package without the bundle, a copy another
  process holds open on Windows) leaves the earlier copy exactly as it was. The
  slot is claimed in `update-check.json` before anything is asked, so two
  sessions starting together do not both download, and a deployment that is down
  is asked once a day, not at every session start; a check dated in the future is
  treated as never made. Over `https` only, except `http` to `localhost`,
  `127.0.0.0/8` and `::1`. It is off when `FABRIC_CLI_NO_SELF_UPDATE` is set to
  anything but `0`, `false` or empty, and whenever `CI` is. A hook refused
  because this CLI is older than the deployment supports asks too: a newer copy is
  the fix. `init` is unchanged; it still refreshes the copy from whichever build
  it was run from.
- The command starts with a bare `node`, never a quoted word: Codex runs hooks
  through PowerShell, where a quoted first word is a parse error. The path uses
  forward slashes on Windows, and is put in double quotes only when it holds
  something a shell would split or interpret, such as a space in a user name. A
  config folder whose path cannot be written safely into a command (it holds a
  `$`, a backtick, a double quote or a `!`) is refused with the variable to set
  (`XDG_CONFIG_HOME`, or `APPDATA` on Windows).
- The build npm publishes is not a single file and cannot be copied. Its hook
  runs `fabric`, which exists when that is how the CLI was installed; when
  `fabric` is not on `PATH`, `init` says so in one line, and still writes the
  hook, so it works as soon as `fabric` is installed.
- `doctor` accepts a hook in either form, warns when the file a copy-form hook
  runs does not exist, and warns when a `fabric` hook finds no `fabric` on
  `PATH`. `init` recognises both forms, so running it again replaces an earlier
  hook of either form with exactly one.
- The lesson-capture hook (`--lessons`) starts the same way.

**To verify it,** run `instructions doctor --project <id>` and read its
`hook` check. **To undo it,** delete the project's `instructions check` or
`instructions sync` entry (and its `lesson-prompt` entry, if there is one) from
`.claude/settings.local.json` or `.codex/hooks.json`, and the deployment's folder
under `cli/` in the config folder when no other checkout uses it;
`auth logout` removes the saved sign-in.

In Codex, trust the folder when Codex asks, then use `/hooks` once to review and
trust the project hook. `init` does not change that trust decision, and the
hook's stdout becomes developer context in Codex.

**The project's MCP server, for every tool that got a hook.** After the hook is
written, `init` registers the project's own gateway,
`<origin>/api/mcp-gateway/projects/<id>`, with each tool, so the tool reaches
that project's context through MCP and nothing else. When no tool was found
and none was named, the fallback Claude Code hook gets no registration. It does
so through the tool's own command line and never by editing its files:

| Tool | Registers | Scope |
|---|---|---|
| Claude Code | `claude mcp add --scope local --transport http fabric <url>` | this checkout only (Claude Code's local scope) |
| Codex | `codex mcp add fabric-<last six letters and digits of the id> --url <url>`, which also signs in | Codex's one global list, so each project's server has a name of its own |

The Connect dialog's Codex commands use the same name for the same project, so a
server added from either is the one the other finds; a test in the CLI runs one
corpus of ids through both rules and fails if they differ.

Before it writes anything it reads what the tool already holds, from the tool's
own files as data (Claude Code's `~/.claude.json`, for the checkout's local scope
and the user scope, and the checkout's `.mcp.json`; Codex's `config.toml`), and
acts on what it finds. It never asks the tool: Claude Code's `mcp get` and `mcp
list` start the servers they name to check them, and one of those can be a
`fabric` server that the repository's own `.mcp.json` runs as a command, before
anyone has been asked to trust it. A file that cannot be read, or that writes
Codex's servers in a form the reader does not follow (an inline table, a dotted
key, `[mcp_servers]` on its own), stops the registration with the line to run by
hand, since `codex mcp add` would replace a server the reader had missed.

- **The same URL is already registered**: nothing is registered or run. For
  Codex that holds under any name, so a server the person named themselves
  counts. Registered does not mean signed in, so `init` adds one line, `If <tool>
  has not signed in to it yet, run: <tool> mcp login <name>`, and never runs that
  login itself, so a rerun opens no browser the person did not ask for.
- **The name holds another gateway of this deployment** (the project was
  connected to another one before): it is replaced. For Claude Code only in the
  checkout's own scope; the same name in another scope is left, with the line
  that removes it.
- **Anything else under that name** (a different vendor's server, another
  deployment's gateway, a server with no URL): it is left alone, and `init`
  says so with the line to run once the person has removed it.
- **The tool is not on `PATH`**: one line, with the command to run once it is.
  (Codex with no terminal is not asked, so there it is the line to run by hand.)
- **The tool cannot register it**: one line with the command to run by hand.
  `init` still succeeds, and the hook is written either way.

A line to run by hand is printed only when every word of it is plain (`A-Z a-z
0-9 . _ : / = @ + -`), the same rule the arguments `init` hands the tool follow. A
deployment's address is `new URL(...).origin`, which keeps `$ ( ) ; & ' " ! ~ , { }`
and a backtick in a host, and no quoting reads the same in bash, PowerShell and cmd. When
the address is not plain, the line is replaced by one fixed sentence, "This
deployment's address cannot be written into a command, so there is no line to
run for it", which does not repeat the address, and the sign-in lines that name
the deployment (`Run: fabric auth login ...`) print `<no command: the
deployment address cannot be written into one>` in the same way. `init` also
refuses such an address before it signs in or writes anything, because the
session hook it would write carries the address into a command a shell runs at
every session start; a plain host, a port and a bracketed IPv6 address
(`http://[::1]:3001`) are accepted.

A server that was just registered or replaced still has to sign in, which is a
step in the person's browser, and the two tools do it differently. "At a
terminal" below means standard input, output and error are all terminals, not
under `CI`, not `--format json`.

- **Claude Code**: `claude mcp add` only registers, so at a terminal `init` then
  runs `claude mcp login fabric` with the terminal handed to it, for at most five
  minutes. Anywhere else it prints that line.
- **Codex**: `codex mcp add` signs in as part of adding. A project's gateway
  answers an unauthenticated request with an OAuth challenge, so the command
  registers the server, opens the browser and waits for the callback, and it has
  no option that skips that. At a terminal `init` runs that one command with the
  terminal handed to it, for at most five minutes, and runs no `codex mcp login`
  after it. Anywhere else it does not run `codex mcp add` at all, because it would
  block until it timed out, report a failure for a server it had written, and may
  open a browser nobody asked for: it prints one line, "Codex signs in as part of
  adding the Fabric MCP server, which opens your browser and waits for you, so
  init did not run it. Run: codex mcp add ...", and under `--format json` the
  outcome is `manual`, with that line as `registerLine`. If the add exits non-zero
  or is cut off while it waits, `init` reads Codex's configuration again: a server
  that is there is reported as registered and not signed in, with `The Codex
  sign-in did not finish. Run: codex mcp login <name>`, and one that is not as
  `Could not register ...` with the add line.

A sign-in that does not finish prints the line and `init` still succeeds.
`--no-mcp` leaves the tools alone altogether. Under `--format json` the result is
the `mcp` array: each tool's `name`, `url`, `outcome`, `login`, `registerLine` and
`loginLine`.

How the tools are run: found on `PATH` by name, started without a shell, with
every `FABRIC_*` variable taken out of their environment. Every argument is
checked against `A-Z a-z 0-9 . _ : / = @ + -` before anything starts. On Windows
Codex is a `codex.cmd` shim that only the command interpreter can start, so it
goes through `cmd.exe /d /s /c` with a verbatim command line made only of those
checked arguments and a shim path that holds no character the interpreter reads;
a command that runs out of time (20 seconds to write, five minutes for a command
that signs in) ends the whole process tree there, with `taskkill` started by its
path under `SystemRoot` and not looked up on `PATH`, and stops waiting on the
command's pipes, so a process the tool left behind that still holds them cannot
keep this one from exiting. What a tool says is never printed, and what its files hold is read
only as far as the server of the name: a server's headers, which can hold a
credential, are never kept. A name read from Codex's file is shown only when it
is plain (letters, digits, `_` and `-`, at most 64); any other is shown as "a
name with unusual characters" and never put into a line to run. `doctor` reports
the registrations by reading the same files, and runs nothing.

**Keeping the per-machine files out of commits.** In a git work tree `init`
appends the hook files it wrote (and, for an uploaded project, `.fabric`) to
the checkout's `.git/info/exclude`, the local ignore file nobody else sees. It
asks git where that file is (a linked worktree shares the main checkout's),
adds only what git does not already ignore, adds each line once, refuses a
file that is a symlink or not a regular file, and never touches `.gitignore`.
It also refuses a line that would not name exactly that path: a folder name
with a newline, a `#` first, or any of `* ? [ ] \ !` (a folder called `a*`
would exclude every sibling that starts with `a`). When it cannot, it says so
and names the lines to add yourself.

For a repository-sourced project `init` adopts the folder; see
[Repository-sourced projects](#repository-sourced-projects) below. For an
uploaded project it takes the first copy before writing the hook, as before: a
failed first sync leaves no new or updated hook behind, and if nothing is
published yet it installs the hook so it can report the first version when it
arrives.

An explicit `--org <slug>` is carried into the generated hook command. These
commands read no stored default context, so a slug supplied once on the
command line has nowhere else to live.

#### Repository-sourced projects

A project whose source of truth is `REPOSITORY` publishes each snapshot from
one commit on the branch its repository sync follows. The working copy is the
developer's own clone of that repository, with its `.git`; the instruction
files arrive with git, so Fabric never writes them there. `init` sets the clone
up, and the session hook's job is to say when the branch has newer published
instructions than the checkout, and to bring it up to date: never to download
instruction files, never to write a lock, and never to do anything to the
checkout but fetch the branch and fast-forward it (see "What the hook does").

Developer setup, in the top folder of the clone (or in the project's folder
inside it, when the instructions live in a subfolder) and nowhere else:

```bash
npx -y https://example.com/cli/fabric-<version>-<build>.tgz instructions init --tool claude-code
```

That one line resolves the project from the clone's remote, signs in if it has
to, writes the hook for the tool it names, and ends on one sentence:

```text
Set up for github.com/owner/repo (main). Claude Code fast-forwards main at session start when safe.
```

On a machine that has no clone yet, one command makes the folder, clones into
it and finishes the setup there:

```bash
npx -y https://example.com/cli/fabric-<version>-<build>.tgz instructions init --project <id> --tool claude-code --clone <dir>
```

`<dir>` is relative to the current folder (or `--dest`). It is made when it is
missing and refused, before any request is made, when it exists and holds
anything: `That folder already exists and is not empty, so nothing was cloned
into it.` (exit 7). `--project` is required with it, because there is no
checkout yet to find the project from (exit 2 without), and the project has to
be a repository project (exit 7 for an uploaded one, which has nothing to
clone). When the project's instructions live in a subfolder of the repository,
`init` carries on there with no second run, and says where it set up
(`Cloned into <dir>/<root folder>. Open your coding tool in that folder.`).

With a bare `--clone` (no folder), `fabric instructions init --project <id>
--clone` in an **empty** folder clones the repository into it first (with a
terminal and no `--clone`, it asks), and then does the same; when the
instructions live in a subfolder it stops there and prints the one line that
sets that folder up (`init --dest <folder>`). The clone is
`git clone --quiet --branch <ref> --no-tags --no-recurse-submodules -- <url>
.` with the developer's own git credentials. The URL is the credential-free
HTTPS one the deployment reports, and only when it names the very repository
shown in the prompt (the same provider, host and path) on the default port; a
URL for another host, another repository or a port is treated as if the
deployment had not said, and nobody is asked. Fabric never hands out a
repository token. The clone keeps the developer's credential helpers and their
`GIT_ASKPASS` and `SSH_ASKPASS` programs on purpose, so a helper such as `gh`
or a credential manager can answer git, and may ask the person in its own
window: the clone is interactive by design and bounded to 5 minutes. git's own
terminal prompt is off (`GIT_TERMINAL_PROMPT=0`, `-c
credential.interactive=never`, `GCM_INTERACTIVE=never`), and ssh runs with
`-o BatchMode=yes` unless the developer already set `GIT_SSH_COMMAND` or
`GIT_SSH`, so a missing credential is a one-line failure rather than a hang. It
never clones into a folder that has anything in it.

Run `init` from the directory the project's instructions live in — the
repository root, or the sync's root folder when it has one. In a clone it
writes the `SessionStart` hook (`sync`, or `check` with `--report-only`; no
matcher; timeout 15 seconds), copies nothing, writes no lock, and leaves every existing
file exactly as it was. A `.fabric/instructions.lock` that **this project**
wrote earlier (from before the project moved to a repository) is removed with
one line, `Removed .fabric/instructions.lock: this checkout follows <host>/<path>
through git now.`; another project's lock, or one that does not read, is left
alone. When nothing has been published from the repository yet, the hook is
still written and `init` says so.

**How the directory is classified.** From the first response of each run, the
CLI asks git (read-only, see below) where the directory's work tree is and
which URL each remote actually fetches from — after any `insteadOf` rewrite,
so a remote rewritten to a local mirror is not taken for the repository. A URL
matches when it is `https://host/path`, `ssh://[user@]host/path` or scp-like
`[user@]host:path` (optional `.git`; no port, except the default `:22` on the
two Azure DevOps SSH hosts), the host equals the project's, and the path equals
the project's (case-insensitively on GitHub, exactly on GitLab; every GitLab
subgroup segment counts).

**Azure DevOps.** The project's `path` is the repository's URL path including
`_git` (`<org>/<project>/_git/<repo>`), and one repository has several
spellings — `https://dev.azure.com/<org>/<project>/_git/<repo>` (also with the
organization as userinfo), `https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>`,
`git@ssh.dev.azure.com:v3/<org>/<project>/<repo>`,
`ssh://git@ssh.dev.azure.com[:22]/v3/<org>/<project>/<repo>` and
`<org>@vs-ssh.visualstudio.com:v3/<org>/<project>/<repo>`. All of them are
reduced to the organization, project and repository and compared
case-insensitively; names are percent-decoded first, so a project called
`Example Project` matches however the URL spells the space. A project whose
path names no Azure DevOps project cannot be told from another project's
repository of the same name, so it is reported as `unknown repository` rather
than guessed at. Webhooks exist only for GitHub; an Azure DevOps project
follows its branch on the deployment's poll.

| Class | When | `check --hook` / `sync --hook` | `init` |
|---|---|---|---|
| matching | exactly one remote fetches from the repository, and the directory is the sync's root folder in that work tree | the report line below, or nothing when current | writes the hook for every tool found, copies nothing, writes no lock |
| not a git checkout, empty | no work tree at or above the directory, and nothing in it | `check` reports, `sync` downloads and writes the lock (an uploaded copy) | with `--clone`, or a yes at the prompt: clones, then as for matching. Otherwise `This folder is empty. Run: fabric instructions init --clone to clone <host>/<path> (<ref>) into it.`, exit 2 |
| not a git checkout, not empty | no work tree, and something in the folder | as above | refused, exit 7, nothing written: `This folder is not a clone of <host>/<path>. Run: fabric instructions init --project <id> [--tool <tool>] --clone <dir>` |
| foreign | no remote fetches from the repository | `fabric: coding instructions: no remote of this checkout fetches from <host>/<path>; nothing was checked.` | refused, exit 7, with the same clone line (a manual `sync` still downloads here) |
| ambiguous | two or more remotes fetch from it | `fabric: coding instructions: remotes <a>, <b> all fetch from <host>/<path>; nothing was checked. Run: fabric instructions init --remote <a>` | refused, exit 7: `Remotes <a>, <b> all fetch from <host>/<path>. Run: fabric instructions init --remote <a>` |
| unmapped | the right repository, the wrong directory | `fabric: coding instructions: this checkout is <host>/<path>, but the project's instructions are at <root folder>, not this directory; nothing was checked.` | refused, exit 7: `This checkout is <host>/<path>, but its instructions are in <relative folder>. Run: fabric instructions init --dest <relative folder>` |
| unknown | git could not answer: not installed (in a directory that does have a `.git` above it), timed out, an untrusted owner, a bare repository, a `.git` that points nowhere; or a branch name or root folder the CLI will not use | `fabric: coding instructions: this git checkout could not be read (<reason>); nothing was checked.` | refused, exit 7, with that line |
| unknown repository | the server reports no repository configuration, or an Azure DevOps path with no project | `fabric: coding instructions: the project is repository-sourced but reports no repository to compare with; nothing was checked.` | refused, exit 7, with that line |
| unsupported provider | a provider this build does not know | `fabric: coding instructions: <PROVIDER> repositories are not compared yet; nothing was checked.` | refused, exit 7, with that line |

A clone that fails says why in one line and writes no hook: `git has no
credentials for <host>. Run: gh auth login` (`glab auth login` for GitLab;
for Azure DevOps `git ls-remote <url>`, which Git Credential Manager signs in
on its first run from a terminal; exit 3), `<host> did not answer` (1), `it
has no branch <ref>` (7), or `Run: git clone -- <url> to see why` (1). With
`--clone <dir>`, a project whose instructions live in a subfolder is set up in
that subfolder; a bare `--clone` into the current folder ends with the
`init --dest <folder>` line to run, since the hook belongs in that folder.

**What the hook does.** `init` writes `fabric instructions sync --hook` for a
repository project, and says so: `Claude Code fast-forwards main at session
start when safe.` At each session start, in a matching checkout, it:

1. looks at the checkout (read-only), and decides whether a fast-forward is
   safe: the branch is the one the project follows, it tracks `<remote>/<ref>`,
   the tree is clean (untracked files included), no merge, rebase, cherry-pick,
   revert or bisect is in progress, it is not a shallow clone or a submodule of
   another repository, no `index.lock` or `HEAD.lock` exists, and no other work
   tree of the repository has the branch checked out (a sparse checkout is
   fine);
2. if it is, takes `<git common dir>/fabric/ff.lock` without waiting (a second
   hook that finds it held says another process is updating the checkout and
   changes nothing), looks again, and fetches the branch with `git fetch
   --no-tags --no-recurse-submodules -- <remote>
   refs/heads/<ref>:refs/remotes/<remote>/<ref>`, a refspec that is not forced:
   a branch whose upstream was rewritten is refused as diverged, never reset;
3. moves to the fetched tip with `git merge --ff-only` when HEAD is an ancestor
   of it. **The target is the branch tip, not the published commit**: git is
   the authority on where the branch is, and Fabric's published copy only
   mirrors it;
4. says what happened, once (below), and appends one line to a trace.

It runs with the developer's own credentials but nothing that can ask a person
(no askpass programs, no terminal prompt, ssh in batch mode), and inside the
hook's budget: the fetch gets the 10 seconds minus a 1.5 second reserve, and the
merge runs only if that reserve is still there, so a slow remote can never leave
the hook mid-merge. It never pulls, rebases, stashes, resets, checks out,
commits or pushes; a checkout it cannot fast-forward is left exactly as it was.
`check --hook` never writes at all, and a person's own `sync` only reports.

*Opting out.* `init --report-only` writes `check --hook` instead, and a
`sync --hook` run with `--no-fast-forward` only reports (the trace says
`opted-out`). An uploaded project's hook is untouched.

| Result | What a session reads |
|---|---|
| fast-forwarded | `fabric: coding instructions: fast-forwarded main from <old7> to <new7> (v<n>).` (`(v<n>)` only when the new HEAD is the commit that version was published from) |
| already there | nothing |
| Fabric's copy lags the branch | `fabric: coding instructions: main is at <sha7>; Fabric's copy is behind (<why>).` Why: a commit was refused by the secret scan, a sync is in progress, the last sync failed, automatic sync is paused or off, or the next sync has not run yet. Said once per published version and reason |
| dirty, another branch, detached, an operation in progress | the matching `behind` line in the table below, once per published version and reason; nothing when the checkout is not behind the published commit |
| shallow clone, submodule, tracks nothing or another branch, git busy, branch held by another work tree | one line each, saying what to run, once per published version and reason, and only when the checkout is behind |
| diverged (a rewritten upstream, or local commits) | `…: main and origin/main have diverged, so nothing was updated. Run: git pull --rebase origin main, or merge origin/main yourself.` Once per version |
| git has no credentials | `…: could not fetch <host>/<path>: git has no credentials for <host>. Run: gh auth login` (`glab auth login`; for Azure DevOps the checkout's `git fetch <remote> <ref>`, which Git Credential Manager signs in), every time |
| another fabric process holds the checkout | `…: another fabric process is updating this checkout; nothing was changed.` |
| network, slow remote, no such branch, other fetch or merge failure, budget spent | stderr only, behind `fabric: coding instructions sync skipped:`; stdout says where the checkout stands |

"Once" is kept in `<git common dir>/fabric/ff-notice.json` (one record: project,
published version, reason; readable by its owner only), so an agent is not
told the same thing at every session start. A fast-forward and missing
credentials always print, and a fast-forward forgets what was said before it.
The trace, `<config dir>/traces/instructions-hook.jsonl` (owner only, the last
50 runs), holds `{ at, projectId, outcome, reason, ms }` and nothing else: no
path, URL, commit or word git said. A trace or notice that cannot be written
never fails a session start.

**The report in a matching checkout.** The published commit is the snapshot's
`source.commitSha`; the question is whether it is in `HEAD`'s history
(`git merge-base --is-ancestor`):

| Situation | Line |
|---|---|
| it is | nothing at all |
| nothing published from the repository yet | `fabric: coding instructions: the project is repository-sourced but nothing has been published from <host>/<path> yet` |
| the published snapshot came from an earlier branch or repository | `fabric: coding instructions v<n> was published from <source.ref>; the project now syncs <ref> of <host>/<path> — pull <ref> to pick up the next publication` |
| behind, on `<ref>`, clean | `fabric: coding instructions v<n> (<sha7>) is on <ref>; this checkout is behind — run: git pull --ff-only <remote> <ref>` |
| behind, working tree has changes (untracked files included; the hook's own `.claude/settings.local.json` or `.codex/hooks.json` is excepted only while untracked — a committed copy that was modified counts) | `…; this checkout is behind and has uncommitted changes — commit or stash, then pull.` |
| behind, a merge, rebase, cherry-pick, revert or bisect in progress | `…; this checkout is behind; a <operation> is in progress; nothing was changed.` |
| behind, detached `HEAD` | `…; this checkout is behind; HEAD is detached — check out <ref> and pull.` |
| behind, on another branch | `…; this checkout is behind; you are on <branch> — pull <ref> when you switch to it.` |

When the published commit is not in the clone at all, "this checkout is
behind" reads "this checkout has not fetched it yet". A shallow clone, a
sparse checkout and a submodule add `(shallow clone)`, `(sparse checkout)` and
`(inside a superproject)` right after that phrase; they change nothing else.

**The output contract.** Every one of these lines goes to stdout — Claude Code
discards a successful hook's stderr and gives its stdout to the session as
context — with nothing on stderr and exit 0. Every interpolated name (branch,
remote, path, commit prefix) has control characters removed and a length
limit applied, and the suggested `git pull` is shell-quoted. A remote URL,
and any credential in one, is never printed. A manual `check` prints the same
line after its usual report; a manual `sync` in a matching checkout prints it
(or `fabric: coding instructions v<n> (<sha7>) from <ref> of <host>/<path> is already in this checkout's history; nothing to sync`)
and writes nothing. All of the lines a command can end a run with are listed
under [What each command says](#what-each-command-says).

`check --format json` adds a `checkout` block — `null` for a project that is
not repository-sourced:

```json
{
  "class": "matching",
  "remote": "origin",
  "branch": "main",
  "head": "<40-hex HEAD>",
  "clean": true,
  "operation": null,
  "contains": false,
  "traits": ["shallow"],
  "line": "fabric: coding instructions v7 (abc1234) is on main; this checkout is behind (shallow clone) — run: git pull --ff-only origin main"
}
```

`contains` is `null` when git could not say (usually: not fetched yet) and is
absent when there was no current repository-built snapshot to look for. The
other classes carry only `class`, `traits: []` and `line`.

**How git is run.** Only through a fixed set of read-only questions
(`packages/cli/src/lib/instructions/git.ts`): `rev-parse` (including `--git-path
info/exclude`), `remote`, `ls-remote --get-url` (which contacts no server),
`symbolic-ref`, `merge-base --is-ancestor`, `status --porcelain`, `config --get
core.sparseCheckout`, `check-ref-format`, `check-ignore -q`, `for-each-ref` of
a branch's upstream, `rev-parse --git-path` for the lock files, `worktree list
--porcelain` and `rev-parse --git-common-dir`, plus three bounded writes,
callable only from `init` and the session hook: `clone` into an empty folder
(see `init`), `fetch` of one branch, and `merge --ff-only` to a commit.
Nothing pulls, rebases, stashes or checks out. git is spawned without a shell,
with stdin
closed, `-c core.fsmonitor=false`, prompts disabled (`GIT_TERMINAL_PROMPT=0`,
no `GIT_ASKPASS`/`SSH_ASKPASS`), optional locks and lazy fetches off, and an
environment without every `FABRIC_*` variable; without `GIT_DIR`,
`GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR` and
`GIT_NAMESPACE`, so an inherited value cannot point it at another repository;
and without `GIT_CONFIG_COUNT`, every `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`,
`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and
`GIT_CONFIG_NOSYSTEM`, so injected configuration such as an `insteadOf` cannot
change which repository a remote fetches from. Names are compared
case-insensitively. Under a hook every git command must be done 750 ms before
the hook's 10-second deadline (shared with the server call); one that runs out
makes the checkout `unknown`, and that line still reaches stdout rather than
losing a race with the deadline's generic stderr line. By hand the git
commands get 10 seconds together. Output is capped, and git's stderr is never
printed. The branch name must pass both a conservative
literal check and `git check-ref-format --branch`, so `@{-1}` and friends are
never expanded.

The one write keeps the developer's own credential helpers and askpass
programs on purpose — that is how their git credentials answer, and it makes
the clone interactive by design (see `init` above). Everything that redirects
git or carries a Fabric credential is stripped from it as well. The clone URL
is re-parsed first: only `https://host/path`, with no userinfo, port, query or
fragment, is passed, so a credential, a port or an `ext::` transport cannot
ride in. A git that outlives its deadline gets SIGTERM, and SIGKILL a second
later unless it has exited. (On Windows, stopping `git` leaves the
`git-remote-https` helper it started running until it ends by itself: a known,
documented limit.) The hook's fetch and merge run with a narrower environment
than the clone: both askpass programs are stripped, so nothing can open a
prompt nobody is there to answer, and `-c credential.interactive=never` is
passed. The fetch is not `--quiet`, because a refused non-fast-forward update
says nothing at all under it; stderr is classified by shape and never printed.

#### `--lessons`: a Stop hook that asks for a lesson

With `--lessons`, `init` also writes a Claude Code `Stop` hook running
`fabric instructions lesson-prompt --project <id> --hook`. A lesson is a
mistake the team should not repeat, written down as
`Lessons/<date>-<slug>.md` so it becomes a rule instead of a memory. The hook
turns the end of a piece of work into the moment it gets written:

- It asks **at most once per session**, and only after the assistant has
  edited files in that session; a session that only answered questions is
  never interrupted. Once-per-session is tracked in a marker directory next to
  the CLI's own config file, keyed by a hash of the session and project, never
  by the raw ids.
- It makes **no network calls** and needs no API key. It reads the hook's
  stdin and the session transcript, and either prints nothing or prints one
  `{"decision":"block","reason":…}` object that tells the assistant to ask the
  developer the question — *was there a mistake in this session the team
  should not repeat?* — and, only after the developer confirms a draft, to
  call the MCP tool `fabric_add_instruction_lesson`. The tool opens a
  proposal; a person approves it in the tab.
- It **never fails the stop**: malformed input, an unreadable transcript or a
  missing marker directory all exit 0 with nothing on stdout, and a stop the
  assistant is already continuing through (`stop_hook_active`) is passed
  straight through so the hook cannot loop. To see why it stayed quiet, set
  `FABRIC_DEBUG=1`: the reason goes to stderr as one line, which Claude Code
  does not treat as hook output on exit 0.

Running `init` again without `--lessons` removes the Stop entry and leaves the
`SessionStart` one alone; `init` describes the hooks you want, not the ones you
have. `--lessons` is refused with `--tool codex` for now: a Codex hook for
lesson capture is not wired.

### `fabric instructions doctor [--project <id>] [--base-url <origin>] [--dest <dir>] [--org <slug>] [--probe-network] [--format text|json]`

Answers "is this machine set up the way this project's coding instructions
expect?" — the question `check` cannot, because `check` only compares digests.
Ten checks run in a fixed order. Each one reports a status, the evidence it
rests on, a one-line detail, and at most one proposed fix. Nothing is written,
nothing named by published content or by `.mcp.json` is executed, and no
declared environment variable's value is read, printed or transmitted: the
environment check compares names only. The CLI does read some variables to do
its own job, and it never prints them. These are its settings (`FABRIC_API_KEY`,
`FABRIC_BASE_URL` and the other `FABRIC_*` variables), `PATH`, `PATHEXT`, and
the variables that locate its config file, such as `HOME`. It reads them
whether or not a declaration also names them.

| Check | What it verifies | Evidence | Proposed fix |
|---|---|---|---|
| API key (`auth`) | A key or a browser sign-in is configured, `GET /auth/whoami` accepts it, and its scopes include `instructions:read` (or a legacy `*`). The detail names the key type and prefix, or "signed-in session", and the scope that satisfied the check. | server | `fabric auth login` (browser), or `--key <api-key>` for CI. A personal key without the scope is pointed at an organization key, because personal keys cannot carry `instructions:*` scopes. A sign-in limited to this project reads "signed-in session limited to this project"; one that reaches every project adds "; this project has no sign-in of its own" when the project has none. |
| Project access (`access`) | `GET .../instructions/published` succeeds for this project. A missing scope (403 `MISSING_SCOPE`), a missing project permission (other 403) and an unknown project (404) are reported as three different failures. | server | Ask a project maintainer for access, or check the project id and `--org`. |
| Published instructions (`published`) | A version is published. The detail gives its version, a digest prefix and its file count, and — for a repository-mirrored snapshot — the commit and branch it was published from (`source.commitSha`/`source.ref`, the snapshot's OWN provenance). Nothing published is a warning. The check also carries the project's CURRENT repository host, path, branch and root path (`repository`, `null` for an upload-sourced or disconnected project — no commit here, since that is per-snapshot, not the project's present configuration), and, for the snapshot's own provenance, whether it still matches that current configuration (`source.current`). | server | Publish a version from the project's Coding Instructions tab. |
| Lock (`lock`) | `.fabric/instructions.lock` exists, belongs to this project, names the published digest, and its ledger matches the published manifest path for path, hash for hash and mode for mode. | machine | `fabric instructions sync --project <id>`. A lock written for another project gets no command, because `sync` refuses such a lock. The fix says to rerun doctor with the `--dest` that was synced for this project. |
| Checkout (`checkout`) | In a clone of a repository-sourced project: whether the checkout holds the published commit, through the same decision the MCP tool makes from facts its caller reports. Here the facts are observed: `HEAD`, the branch, whether the tree is clean, and whether `HEAD`'s history contains the published commit (the answer `check` also gives). `pass` when `HEAD` is the published commit, or is ahead of it on the branch (its history contains it), with a clean tree; `warn` when the tree has uncommitted changes, when the history does not contain the published commit (behind or diverged), or when Fabric's own copy lags the branch tip (and why: the secret scan refused a commit, a sync is running or failed, or automatic sync is off or paused); `skip` on another branch or a detached `HEAD`, for an uploaded project, outside a git checkout, in a checkout of another repository, when the published version was uploaded rather than synced from the repository, and when nothing has been published yet. | machine | Commit or stash, or pull `<ref>` yourself; a lagging Fabric copy is fixed in the project's Coding Instructions tab, not in the checkout. A fix is a proposal, never authority to pull or reset. |
| Local files (`drift`) | Every file the lock names still hashes to what the lock recorded, and still has the recorded mode. Each drifted file is listed. Edits alone are a warning, because `sync` keeps them; an edit a sync already kept reads `edited (kept by sync)`. A missing file, a changed mode or a path that is not a regular file fails. | machine | `sync --repair` to replace edits with the published bytes, `sync` to restore anything else, or `fabric instructions push` to propose the edits instead. |
| Hook configuration (`hook`) | `.claude/settings.local.json` and `.codex/hooks.json` are checked separately. A hook passes when a `SessionStart` entry for this project runs exactly one of the two commands `init` writes today (`check` or `sync`, bound to the deployment doctor ran against with `--base-url`, and carrying the same `--remote` and `--org`), started either as `fabric` or as `node` and the copy of the served build `init` keeps; a copy-form hook whose file is gone is a warning (`not found; run init again to put it back`, with no path in the report). A hook written before hooks named a deployment (the same command with no `--base-url`) is a warning, `unbound to a deployment`, because it follows whichever deployment the machine is signed in to. A Fabric entry for the project under another event, or running another subcommand, is ignored. Also looks `fabric` up on PATH, which only a hook that runs `fabric` depends on. | machine | `init --project <id> --tool claude-code`, started the way this install starts (the `npx` line, or `node` and the copy), which also takes a first sync for an uploaded project (`--tool codex` for Codex); `npm install -g @fabricorg/cli` when a hook runs `fabric` and it is not on PATH. |
| Environment variables (`environment`) | Every variable [`fabric.environment.json`](#the-environment-declaration-fabricenvironmentjson) declares is present in this shell, checked by name. A missing required variable fails and a missing optional one warns. | machine | Set the named variables. The fix is a description only, never an `export NAME=` line. |
| Tools (`tools`) | Every tool the declaration names resolves on PATH, checked for presence only. A declared version is shown as "declared, not verified". | machine | Install the named tools. The fix is a description only. |
| MCP servers (`mcp-servers`) | For each server in `<dest>/.mcp.json`, a `command` must resolve on PATH (or at its absolute path, or at a relative path under the checkout). A `url` server is probed only under `--probe-network`. A `url` server on the deployment doctor ran against that carries an `Authorization` header is a warning: the deployment's sign-in supplies that credential itself, and a stale header committed beside it wins and fails. Only whether the header is there is read — never its value — and another service's header is not this check's business. For each coding tool the project's hook is set up for, one more item says whether the project's own Fabric server is registered with it, read from the tool's files and never by running the tool: registered at this project's gateway passes, a server of the name at another URL is a warning, and no registration or an unreadable file is a skip (`init` registers it, unless it was run with `--no-mcp` or, for Codex, with no terminal to sign in at). | machine | Fix or remove the failing server, or remove the stale `Authorization` header. For a server of the name at another URL, remove it from the tool, then run the `init` registration line the fix gives. |

A hook check that passes proves one thing: the command recorded in the file is
one this CLI writes today. The hook records no binary path and no CLI version.
Whether the coding tool trusts and runs the hook, and whether `fabric` is on
that tool's PATH as opposed to this shell's, is not verified, and the detail
says so.

**Status and exit codes.** `pass` means no failure was found under the
evidence the check names. It is not a guarantee beyond that evidence. `fail`
means a problem was found, and every failing check proposes a fix, including a
check that could not run. `warn` does not block but deserves attention: an
optional variable is missing, a hook differs from the canonical command (or is
unbound to a deployment), the checkout does not hold the published commit, an
`.mcp.json` entry carries a stale `Authorization` header, or a declaration
exists locally but is not published. `skip` means the check was
not evaluated here, because a prerequisite failed, nothing is declared, or the
check does not apply. A skip never fails the run. The command exits `0` when
no check fails, warnings and skips included, and `1` when any check fails,
after printing the whole report. A missing or refused key does not crash the
command. The `auth` check fails, the checks that need the server skip, and
`mcp-servers` still runs because it needs nothing from the server.

**A repository-sourced project** (source of truth `REPOSITORY`) is checked
according to the directory's class (see
[Repository-sourced projects](#repository-sourced-projects)), classified once
with the same read-only git questions the hook asks:

- In a **matching** checkout, `lock` is skipped ("not used in a checkout of
  the repository"). `drift` passes when the published commit is in `HEAD`'s
  history — "history contains the published commit <sha7> (ancestry, not a
  file comparison)" — and otherwise warns with the hook's report line. The
  environment declaration is read from the checkout, and every detail that
  depends on it starts with "from the local checkout".
- **Outside any git checkout** every check runs as it does for an uploaded
  project.
- In any **other** class, `drift` is skipped with the class line and a local
  `fabric.environment.json` is never read as this project's declaration —
  only a published one, verified as below. `lock` is checked as for an
  uploaded project in a checkout of some other repository, where a manual
  `sync` still copies, except that a folder with no lock is skipped ("not
  used here: this folder is not a checkout of the project's repository")
  rather than failed with a `sync` fix; everywhere else `sync` refuses, so
  `lock` is skipped with the class line.
- `hook` is checked in every class. It proposes `init` only in a matching
  checkout or outside any checkout; elsewhere `init` would refuse, and the fix
  says so instead.

**Where the declaration is read from.** If the published manifest lists
`fabric.environment.json`, the lock names the published digest, and the local
file's sha256 equals the manifest entry, the local file is read. Otherwise the
file is taken from the published bundle, with three checks:

- The manifest entry's size is checked first. An entry over 64 KiB is refused
  before anything is downloaded.
- The download endpoint resolves the *current* snapshot, so its snapshot id
  and digest are compared with the manifest being checked. When they differ,
  the manifest read and the download are both retried once. A second mismatch
  is reported as a warning: "publication changed while checking; rerun".
- The extracted bytes are hashed against the manifest before they are parsed,
  and the same buffer is hashed and then parsed. A mismatch fails with
  "published declaration failed integrity check".

A declaration that exists only on disk is still evaluated, and the detail adds
"declaration exists locally but is not published". A result that would pass is
reported as a warning instead. A missing required variable still fails.

**Every generated command is built only from what you typed.** A
`fix.command` uses the project id, `--org` and `--dest` you gave doctor,
POSIX-shell-quoted. It carries `--org` and `--dest` whenever doctor had them,
so a pasted command acts on the same project, context and checkout. No part of
it comes from declaration text, `.mcp.json`, or a server response.

**Fixes are proposals, not authority.** The report lists findings and proposed
remedies. It grants no authority to install software, change credentials or
overwrite files. A person decides whether to run a fix. `sync --repair` in
particular overwrites local edits to instruction files. This applies equally when an
agent reads the report, whether from `--format json` or from the MCP gateway's
`fabric_instruction_checks` tool. That tool returns the same report shape with
`surface: "mcp"`. It runs on the server, so it cannot see this machine's files,
hooks, PATH or `.mcp.json`, and it reports the local-only checks as skipped.
What the caller sends it, the lock digest and the names of the variables that
are present, is marked `evidence: "caller-reported"`. The server compares that
input with the published version but cannot check it independently, so a
`pass` on caller-reported evidence is only as accurate as the input it was
given.

**The commands doctor proposes act on the deployment it checked.** Every
`fix.command` carries `--base-url <origin>` right after `--project` when that
deployment is not the default one (`https://fabric.pro`), the same deployment
the hook command is bound to, and the login fix is `fabric auth login
--base-url <origin>`. They carry `--org` and `--dest` as before, and the `init`
fix carries `--remote` when doctor was given one. `sync`'s own repair command
(`sync --repair`, printed when it keeps local edits) follows the same rule.

#### `--probe-network`, and why it is opt-in

Without the flag, doctor contacts only Fabric. A `url` server in `.mcp.json`
is listed as skipped with "network probe disabled (rerun with
--probe-network)". `command` servers are always checked, because a PATH lookup
sends nothing anywhere.

`.mcp.json` is repository content: each URL in it is an address somebody else
chose. Contacting it from your machine tells that host you ran doctor and from
which network, and a URL can just as easily name an internal host that is only
reachable from where you are sitting. So the request is sent only when you ask
for it. With `--probe-network`:

- Only `http:` and `https:` URLs are probed. A URL that embeds a user name or
  password is not probed, and is reported as a warning.
- One `GET` is sent per server. It carries no headers from the config, and an
  entry's `env` is never read. A redirect is not followed: a `3xx` counts as
  reachable. The response body is never read.
- Each request has 5 seconds. At most 20 servers are probed, 4 at a time,
  within 15 seconds in total. Servers the budget does not reach are skipped
  with "probe budget exhausted".
- Any HTTP response counts as reachable, including `401`, `403` and `404`.
  That means a server answered, not that it is a working MCP server or that
  your credentials for it work, and the detail says so.
- A failure is reported only as a class: connection refused, timed out, DNS
  lookup failed, TLS error, connection reset, or unsupported scheme. The URL is
  never printed. A server is identified by its key in `mcpServers`, with
  control characters removed and a 64-character limit.

#### What doctor will not do

- **Execute anything a project names.** Tools named by the declaration and
  commands named by `.mcp.json` are found with `stat`. A candidate counts when
  it is a regular file with an execute bit, or has a `PATHEXT` extension on
  Windows. Only absolute PATH entries are searched. Running `<tool> --version`
  would be code execution chosen by whoever can publish the instructions or
  commit to the repository. The one program doctor runs is `git`, for a
  repository-sourced project only, and only the read-only questions listed
  under [Repository-sourced projects](#repository-sourced-projects).
- **Read a declared variable's value.** Declared variables are checked by
  name, against the names in the environment. Doctor necessarily uses its own
  settings (`FABRIC_API_KEY`, `FABRIC_BASE_URL` and the other `FABRIC_*`
  variables), `PATH`, `PATHEXT` and the variables that locate its config file
  to do its job, and it never prints them.
- **Repeat content.** Details are fixed wording, numbers, validated
  identifiers, or published and repository text with control characters
  removed and a length limit applied. A server's error message, an exception
  message, a parser excerpt and a URL are never printed. An unexpected error
  inside one check fails that check with the error's class name, for example
  "check could not run (TypeError)", and the next check runs.
- **Read without bounds.** `fabric.environment.json` is read through the
  guarded reader with a 64 KiB limit and `.mcp.json` with a 256 KiB limit and
  at most 50 servers. The guarded reader refuses a symlinked component or
  anything that is not a regular file. The lock is read through the same
  guarded reader with a 16 MiB limit, so a symlinked `.fabric` directory or
  lock is refused rather than followed, and then checked with the validator
  `sync` uses. The hook files are read through it with the 1 MiB limit `init`
  applies to them.
- **Write anything**, or create `--dest` if it does not exist.

Text output puts one line per check, then its items and its fix:

```text
✓ API key                 organization key org_abc12345 with instructions:read
✗ Lock                    lock is at version 3, published is 4
    fix: fabric instructions sync --project project-id
         brings this checkout to the published version; a local edit to an instruction file is kept and listed, and `sync --repair` replaces it
! Hook configuration      a hook for this project is not in the canonical form; execution, trust and the coding tool's PATH are not verified
- MCP servers             no .mcp.json in this folder

6 passed, 1 failed, 1 warning, 1 skipped
Fixes are proposals: doctor installed nothing, changed no credentials and wrote no files.
```

`--format json` prints the report object, which has the same shape as the MCP
tool's report:

```ts
interface InstructionChecksReport {
  projectId: string;
  surface: "cli" | "mcp";
  checks: Array<{
    id: "auth" | "access" | "published" | "lock" | "checkout" | "drift"
      | "hook" | "environment" | "tools" | "mcp-servers";   // always in this order
    title: string;
    status: "pass" | "fail" | "warn" | "skip";
    evidence: "server" | "machine" | "caller-reported";
    detail: string;
    items?: Array<{ name: string; status: string; detail?: string }>;
    fix?: { command?: string; description: string };
  }>;
  summary: { pass: number; fail: number; warn: number; skip: number };
  ok: boolean;   // no failures among the evaluated checks — not a readiness attestation
}
```

## What each command says

A run ends in one of a closed set of states, and each has one fixed line and,
where there is one, the single thing to do next (`outcome.ts`). The rules:

- **One line** for the person or the agent. A failure is a fixed sentence
  picked by its status and code, never the words of a server, the SDK or the
  network library, and it names only the deployment's origin. Set
  `FABRIC_DEBUG=1` to see the original on its own `debug:` line.
- **No absolute path** unless `--dest` was typed, **no sha256**, and no class
  name in parentheses. What the CLI writes itself has the folder the person did
  not type, the home folder and any digest taken out before it is printed.
  `--format json` is for programs and keeps its fields.
- Under `--hook`, **stdout** carries what the agent has to act on: the
  checkout's state, a sign-in that cannot be used, a deployment's upgrade
  line. **stderr** carries everything that only stopped the check, behind
  `fabric: coding instructions <verb> skipped:`. The exit code is always 0.

Exit codes are the CLI's documented ones (`src/bin/fabric.ts`): `0` success,
`1` general failure, `2` invalid usage, `3` auth failure, `4` not found, `5`
forbidden, `6` rate limited, `7` refused or inconsistent.

| State | By hand | Under `--hook` |
|---|---|---|
| set up | `Set up for <host>/<path> (<ref>). <tool> checks for updates at every session start.` (0); `… In Codex, run /hooks once to trust the project hook.` when Codex is set up. The npm build adds a line of its own, first, when `fabric` is not on `PATH` for the hook to run; `--clone <folder>` adds `Cloned into <folder>. Open your coding tool in that folder.` | — |
| behind, current, or any other checkout state | the lines in [Repository-sourced projects](#repository-sourced-projects) | the same line, on stdout; nothing when current |
| deployment address not a URL | `The deployment address is not a URL. Use --base-url https://example.com` (2) | stderr, skipped |
| deployment address a shell would read (`init` only) | `The deployment address has characters a shell reads, so init will not write a session hook that carries it. Use an address of letters, digits, '.', '-' and a port.` (2) | — |
| a project id or organization slug that is not an identifier | `--project must be a project id: …` or `--org must be an organization slug: …` (2) | stderr, skipped |
| not signed in | `Not signed in to <origin>. Run: fabric auth login --base-url <origin> --project <id>` (3), with `--project <id>` whenever the command names a project; `init` signs in on the spot through the browser, with no terminal needed (not under `CI`) | stdout: `fabric: coding instructions: not signed in to <origin> — run: fabric auth login --base-url <origin> --project <id>` |
| sign-in expired or refused (401) | `Your sign-in to <origin> has expired. Run: fabric auth login --base-url <origin>` (3), with `--project <id>` whenever the command names a project | the same stdout line as not signed in |
| an agent's MCP server | one line per tool: `Registered the Fabric MCP server for <tool> as "<name>".`, `The Fabric MCP server is already registered for <tool>.`, `Replaced the Fabric MCP server …`, a left-alone line, `Skipped the <tool> MCP server: <command> is not on PATH. Once it is, run: <line>`, `Codex signs in as part of adding the Fabric MCP server, which opens your browser and waits for you, so init did not run it. Run: <line>` (no terminal), or `Could not register the Fabric MCP server for <tool>. Run: <line>`; then `To finish, sign <tool> in to it: <line>`, `If <tool> has not signed in to it yet, run: <line>` (for a server registered before) or `The <tool> sign-in did not finish. Run: <line>` (0, always) | — (a hook never registers anything) |
| missing permission (403) | `This credential is missing the <scope> permission. Create a key that carries it, or run: fabric auth login --base-url <origin>`, or `You do not have access to this project's coding instructions. Ask a project maintainer for access.` (5) | stderr, skipped |
| project not found (404) | `Project not found, or you cannot see it.` (4) | stderr: `… skipped: no project for this checkout` |
| project unresolved | `This checkout's remote (<host>/<path>) is not connected to any project you can see. Connect the repository in Fabric first.` (4), or the list of `--project` choices (2) | stderr: `… skipped: this hook names no project. Run: fabric instructions init` |
| rate limited (429) | `Too many requests. Wait a minute and try again.` (6) | stderr, skipped |
| deployment unreachable | `Could not reach <origin>. Check your network and try again.` (1) | stderr, skipped |
| deployment error (5xx) | `<origin> had a problem answering. Try again in a moment.` (1) | stderr, skipped |
| CLI too old (426) | the deployment's own line, or `This CLI is older than the deployment expects. Run: npm install -g @fabricorg/cli` (2); the served build says `… Run the project's setup line from its Connect dialog again to get the current one.` instead | stdout, that one line |
| deadline | — | stderr: `… skipped: gave up after 10 s` |
| folder not a clone, wrong folder, several remotes | the single action line in the class table (7) | the class line on stdout |
| a lock from another project | `This folder was synced from a different project, so nothing was changed. Use another --dest, or delete .fabric/instructions.lock to start over.` (7) | stderr, skipped |

A deployment that asks for an upgrade also sends the line with ordinary
responses (the `X-Fabric-Cli-Upgrade` header). It is shown **once**: on stdout
under a hook, where an agent reads it, and on stderr by hand, so a command's
stdout stays what was asked for. Its text is the deployment's, so control
characters (including the C1 range and the line separators) and the characters
that reorder text are shown as spaces, and it is cut at 300 characters. The CLI
never updates itself, and the SDK
sends a `User-Agent` of the form `fabric-cli/<version> (node/<version>;
<platform>)` so a deployment can tell which build is calling.

## What these commands will not do

These are guarantees, and the tests under `packages/cli/__tests__/` exist to
keep them:

- **`--hook` never fails, and never runs long.** Network, auth, timeout, HTTP
  error, a damaged lock, a retired context default — every failure becomes one
  line and exit 0: on stderr when it only stopped the check, on stdout when the
  agent has to act on it (a sign-in that cannot be used, an upgrade). Hook mode
  also has one absolute deadline (10 seconds) covering the manifest call and the
  bundle download together, with SDK retries disabled, so it cannot outlive the
  hook timeout Claude Code applies to it. That bounds the sign-in too: the
  request's own timeout covers the wait for the refresh lock another process
  holds, so a hook gives up with the rest instead of waiting the lock out. A
  session that will not start is worse than instructions one version stale. The
  kept copy's daily update (see "What `<launcher>` is") runs after the hook has
  printed, only when five seconds of that deadline remain, and ends inside it.
- **A hook never signs anybody in.** The loopback listener and the browser are
  started only by `auth login` and by `init` at a terminal, never under
  `--hook`.
- **Only `init` runs a coding tool, and only for the project's MCP server.** It
  starts `claude` or `codex` for `mcp add`, `mcp remove` (Claude Code's own scope
  only) and `mcp login` (Claude Code's only), each with arguments it built itself
  from a short list of safe characters, without a shell, without any `FABRIC_*`
  variable, and within a time limit. `codex mcp add` is started only at a
  terminal, since it signs in as part of adding and waits for a browser. It never
  starts a tool to ask what it holds (`mcp get` and `mcp list` health-check the
  servers they name, and in a checkout one of them can be the repository's own),
  and it never starts one at all under `--no-mcp`. A hook and every other command
  run none, and `doctor` reads the tools' files. It never prints what a tool said.
- **The hook command never carries the key.** It names a project and a
  deployment. The CLI reads its credential from `FABRIC_API_KEY` or its own
  per-user config file, and `init` refuses to write the hook at all if that
  config file resolves inside the destination.
- **A credential goes only to the deployment that issued it.** See "Signing
  in": a browser sign-in is refused, before anything is sent, for any other
  origin than its issuer's.
- **Nothing is written outside `<dest>`, except two things `init` does on
  purpose:** a clone into an empty folder (the repository's own files, in the
  folder it was told to use) and a line appended to `.git/info/exclude`.
  Otherwise nothing is written outside it. Absolute paths, `..` segments,
  backslashes, control characters, Windows device names (`NUL`, `COM1`, …),
  names containing `< > : " | ? *`,
  segments ending in a dot or space, and colons are refused; two paths that a
  case-insensitive or Unicode-normalising filesystem would treat as one file
  are refused as a pair. The destination is canonicalised with `realpath`, the
  resolved path must sit inside it, and no segment on the way down may be a
  symlink. That holds for the instruction files, the lock and the settings
  file alike — they share one writer.
- **The kept copy's self-update trusts what the `npx` line trusts, and no
  more.** It talks only to the deployment the hook is bound to, over `https`
  (plain `http` only to a loopback host), without following a redirect; it
  verifies the manifest's `sha512` before unpacking a byte, reads one file out of
  the archive in memory and never executes anything it downloaded; and it writes
  only the copy and `update-check.json`, inside the CLI's own config folder
  (never `<dest>`), the copy through a temporary file and a rename. A failure
  leaves the earlier copy. `FABRIC_CLI_NO_SELF_UPDATE=1` and `CI` turn it off.
- **Nothing is written on a checksum mismatch.** Every file's sha256 is
  verified against the manifest before the first byte is written, so a
  corrupt bundle leaves the tree and the lock exactly as they were.
- **No file the sync did not write is ever deleted.** A path must be in the
  lock, and still match the hash the lock recorded, before it can be removed —
  and that hash is checked again immediately before the unlink, not only when
  the plan was made. A file edited while the bundle was downloading is
  reported as *kept, modified locally* instead of removed. `.git/**` and
  `.fabric/**` are refused outright, from the manifest and from the lock
  alike. The server never publishes `.fabric/` either: it is always excluded
  from folder uploads and repository syncs, even when project ignore settings
  or `.fabricignore` otherwise exclude nothing, so a repository that commits
  its `.fabric/instructions.lock` still publishes a bundle the CLI accepts.
  The root-level hook files `init` owns — `.claude/settings.local.json` and
  `.codex/hooks.json` — are always excluded the same way. The CLI also
  refuses them from a manifest or lock; the rest of `.claude/` and `.codex/`,
  including nested same-name paths, is ordinary instruction content.
- **Only ordinary files are touched, and every read is guarded as well as
  every write.** Manifest paths, delete paths and the lock's own ledger paths
  all go through the same per-segment walk: nothing resolving outside the
  destination, no symlinked component anywhere on the way down, and a regular
  file or nothing at all at the end. A symlink, a directory or a device node
  standing where a file should be refuses the whole sync rather than being
  written through, followed, hashed or unlinked — including when the link is
  an ancestor directory rather than the file itself.
- **A manifest is complete or it is a refusal.** Every entry's path, hash,
  size and mode is checked, no two entries may name the same file, the entry
  count must match the snapshot's, and the digest is recomputed locally from
  the entries and compared. A response that says "published" and carries no
  manifest is an error, never an empty one. The manifest is also held to the
  published snapshot limits — at most 5000 files, 5 MiB each, 50 MiB in total
  — so a malformed response cannot describe an unbounded download.
- **The download is bounded by the manifest, not by the response.** The
  archive size is capped at what the (already validated) manifest describes
  plus 1 MiB of framing; a larger `Content-Length` is refused before the body
  is read, and a body that grows past the cap is abandoned mid-stream. The cap
  scales with the entry count and path lengths, the way zip framing does, so a
  legitimate snapshot of thousands of small files is not refused for being
  mostly structure.
- **A lock belongs to one project.** Running `sync --project B` in a tree
  synced from project A is refused rather than allowed to use A's ledger to
  decide what to delete — and `push --project B` there is refused for the same
  reason, before a byte leaves the machine.
- **A push sends only what you can name.** Every path it reads goes through the
  same guarded walk the writes use, so a symlink standing where an instruction
  file belongs refuses the push rather than being followed, hashed and
  uploaded. Reserved paths (`.git/**`, `.fabric/**`,
  `.claude/settings.local.json`, `.codex/hooks.json`) are refused from the
  lock and from `--add` alike.
- **The same push twice is the same proposal.** The change route identifies a
  proposal by its content — the version it is stated against plus the set of
  paths, operations and hashes it applies — so a request whose response was
  lost comes back with the proposal the first attempt opened rather than a
  second one against the cap of five. Retries are therefore on, here and in the
  SDK, and repeating a push that failed is safe.
- **A failed push is closed out rather than left hanging.** A proposal that
  gets as far as a row and then fails before its validation is started — a
  storage outage mid-upload, an unreachable workflow service — is marked
  rejected by the same request, instead of sitting open for the six hours the
  server's abandonment sweep waits. It still occupies one of your five active
  proposals until the next cleanup sweep clears its staged files, which is
  what keeps those files findable; what changes is hours, not the count. Once
  validation has been started the row is left alone, because by then it may
  belong to a run already reading it.
- **A name that will not install is refused on the way in.** Windows device
  names (`CON.md`, `nul.txt`), names with a trailing dot or space, and NTFS
  names containing any character Windows will not put in a filename
  (`< > : " | ? *`, the colon also naming an NTFS alternate data stream) are
  refused by the server as well as by this CLI, and two spellings of one name
  that differ only by Unicode normalisation are treated as the collision they
  are. A version that stores
  is a version that installs. Files your ignore rules already exclude are
  never judged on their names, and a file that predates these rules can
  always still be **deleted** — that is how such a name gets fixed.
- **A `sync` never reports success over a tree it has not checked.** An
  unchanged published digest is verified against the ledger before it is
  accepted, so a deleted or chmod-ed instruction file is restored on the next
  sync rather than surviving until someone happens to publish again, and an
  edited one is reported as kept rather than passed over in silence.
- **Nothing outside `<dest>` decides which organization a request names.** A
  stored default context and `FABRIC_ORG` are not consulted: the project
  decides, which is what keeps an invited guest — whose own organization is
  never the project's host — able to sync at all. `--org` still binds a
  request explicitly.
- **Writes are atomic.** Each file is written to a temp name in its own
  directory and renamed into place, with the published mode applied on POSIX.
  Only `0644` and `0755` are accepted; anything else in a manifest is a
  refusal rather than a mode to apply.

### What these guarantees do not cover

Two residuals, stated rather than hidden.

**Concurrent mutation of the destination by the same user.** The guards are
`lstat`-then-act: a directory replaced by a symlink between the check and the
write, or a file edited between its hash and its unlink, is a window that
narrows but does not close. Shutting it entirely needs handle-relative
syscalls (`openat`, `renameat`) that Node does not expose. Someone editing the
tree while their own sync runs is out of scope; someone else editing it is a
question of who can write to the checkout, which is the same question the lock
raises below.

**CPU time inside the deadline.** Hook mode's 10-second bound covers waiting —
the manifest request, the download — because that is what a timer can
interrupt. Decompression and hashing are synchronous and hold the event loop,
so the promise race cannot preempt them. The bundle is bounded so that work
stays small, and Claude Code's own hook timeout is the hard stop for it.

## The lock

A checkout of a repository-sourced project's own repository has no lock:
nothing is copied into it, so there is no ledger to keep (see
[Repository-sourced projects](#repository-sourced-projects)). Everywhere else,
`<dest>/.fabric/instructions.lock` records the snapshot that was applied and
every path it wrote or verified:

```json
{
  "version": 3,
  "projectId": "project-id",
  "snapshotId": "snapshot-id",
  "snapshotVersion": 7,
  "digest": "<sha256 over the sorted path+hash lines, plus the mode when it is not 0644>",
  "syncedAt": "2026-09-17T10:00:00.000Z",
  "files": {
    "AGENTS.md": { "sha256": "…", "mode": 33188 },
    "CLAUDE.md": { "sha256": "…", "mode": 33188, "kept": true }
  },
  "source": {
    "kind": "REPOSITORY",
    "ref": "main",
    "commitSha": "0123456789abcdef0123456789abcdef01234567",
    "current": true
  }
}
```

It is rewritten last, after every write has succeeded. A lock naming files
that are not there would authorise deleting whatever is in their place on the
next run.

An entry carries `"kept": true` when a sync left a local edit at that path.
Its `sha256` and `mode` are still the published values. That is what lets
`check --verify` and doctor report the edit as kept, and `push` diff it
against the published file. `--repair` drops the marker along with the edit,
and so does a sync that finds the file matching the published version again.

**`source`** records the published snapshot's own provenance: `{ "kind":
"UPLOAD" }` when someone uploaded it directly, or `{ "kind": "REPOSITORY",
ref, commitSha, current }` when it was mirrored from a repository sync.
`current` reports whether that snapshot still matches the project's present
sync configuration — the same integration and the same branch — as of the
sync that wrote the lock; it goes `false` once the project moves to a
different repository or branch, even though the snapshot's own `ref` and
`commitSha` never change. The field is absent, not defaulted, when an older
server did not report a source. The repository itself — its host, owner/name,
and root path — is the project's CURRENT configuration, not this snapshot's,
and is deliberately not recorded in the lock; `fabric instructions check` and
`doctor` read it live from the server instead.

**Lock version 3.** Version 2 added the `kept` marker; version 3 adds
`source`. Both are additive, so this build still reads version 1 and version
2 locks (a version 1 or 2 lock simply carries no `source`). An older `fabric`
that only reads version 1 refuses a version 2 or 3 lock whole ("its version
is 3 and this build writes version 1"), writing nothing, so it never
overwrites a kept edit it cannot see. Deleting the lock is the one way around
that: the next sync, by any build, then starts from no ledger at all. That
also ends the fail-closed protection for edits made before the delete — an
older CLI can no longer see they were kept and plans a plain replacement over
them, so the safe move on a refused lock is to upgrade the CLI rather than
delete it.

### The lock is a content ledger, not an authenticated one

It is a plain JSON file inside the checkout, so anything that can write there
can write it.

The threat model this reflects: the lock lives at `<dest>/.fabric/` because
that is where the card places it, and a ledger inside the tree cannot
authenticate itself against anyone who can write to the tree. It does not have
to. An attacker who can edit `.fabric/instructions.lock` can already edit —
and delete — every file the lock could name, directly and without waiting for
a sync to run. The lock does not extend their reach; it only means a sync
might perform a deletion they could have performed themselves. What would
change that is a ledger kept outside the checkout, keyed by canonical
destination and project, or one the server signs with a secret repository
content cannot reach. Neither is in scope here, and neither is necessary to
make the lock safe against the reach it actually has.

That bounds what a tampered lock can do rather than preventing it, and the
bound is worth stating plainly:

- it can cause the DELETION of a file whose *current* content hash it names
  correctly — so a file the tampering party can already read and already
  modify;
- it cannot cause a write anywhere new, because the bytes and paths that get
  written come from the server manifest;
- it cannot name `.git/**`, `.fabric/**`, `.claude/settings.local.json` or
  `.codex/hooks.json` at all;
- it cannot cause the deletion of a file whose content has changed since the
  plan was made, because the hash is rechecked immediately before the unlink;
- it cannot be partially honoured: a lock that fails schema validation stops
  the run rather than being read as far as it parses.

Treat `.fabric/instructions.lock` with the same care as any other file in the
tree.

`.fabric/`, `.claude/settings.local.json`, and `.codex/hooks.json` are local
to one machine. In a git work tree `init` appends them to `.git/info/exclude`
(see `init`); it never edits `.gitignore`. Outside a git work tree there is
nothing to ignore.

## The environment declaration: `fabric.environment.json`

A project states which environment variables and command-line tools its
instructions assume by adding `fabric.environment.json` at the root of the
instruction set. It is published and synced like any other file and lands at
`<dest>/fabric.environment.json`. It does not live under `.fabric/`, because
`.fabric/**` is reserved to the CLI and a manifest that names a path there is
refused as a whole.

```json
{
  "version": 1,
  "variables": [
    { "name": "OPENAI_API_KEY", "description": "Model access for the eval scripts", "required": true },
    { "name": "SENTRY_DSN", "required": false }
  ],
  "tools": [
    { "name": "pnpm", "version": ">=11", "description": "Package manager" },
    { "name": "gh" }
  ]
}
```

| Field | Rule |
|---|---|
| `version` | Must be the number `1`. Unknown top-level keys are ignored, so a later version can add fields. |
| `variables[].name` | Required. A POSIX identifier, `^[A-Za-z_][A-Za-z0-9_]*$`, of at most 128 characters. Unique, compared case-sensitively. |
| `variables[].required` | Optional boolean, default `true`. A missing required variable fails the check, and a missing optional one warns. |
| `variables[].description`, `tools[].description` | Optional string of at most 200 characters. Control characters are replaced when it is displayed. |
| `tools[].name` | Required. A bare executable name, `^[A-Za-z0-9][A-Za-z0-9._+-]*$`, of at most 64 characters: no path separators, no whitespace, no leading dot. Unique. |
| `tools[].version` | Optional string of at most 64 characters. It is informational only and is reported as "declared, not verified". |

**Limits.** The file may be at most 65,536 bytes and may list at most 200
variables and 100 tools. A file over a limit, or malformed in any way, makes
the `environment` check fail with a reason that refers to a position (for
example `variables[3].name must be an environment variable name`), never to
the offending value. The `tools` check is then skipped as "declaration
unreadable".

**Names only.** The file declares variable *names*. Neither the CLI nor the
MCP gateway reads, prints or transmits the value of a variable declared here
in order to check it. The CLI reads its own settings, `PATH`, `PATHEXT` and
the variables that locate its config file to do its job, even when a
declaration also names them, and never prints them. Never put a value in this
file. Like everything else in the instruction set, it is published content
that everyone with read access can see.

**Nothing named here is executed.** Tools are checked by PATH lookup, and a
declared `version` is never verified by running the tool. The declaration is
published content, so running `<tool> --version` because it names `<tool>`
would be code execution chosen by whoever can publish the instruction set.

**Classification.** The instruction-file classifier reports a root-level
`fabric.environment.json` as kind `SETTINGS`; the same name in a subfolder
stays `OTHER`. Doctor reads it by its path, so its kind makes no difference to
the checks.

## What it talks to

| Layer | Where |
|---|---|
| CLI commands | `packages/cli/src/commands/instructions/index.ts` |
| Filesystem modules | `packages/cli/src/lib/instructions/` |
| The one guarded writer | `packages/cli/src/lib/instructions/safe-write.ts` |
| Push plan (local diff against the lock, and what open proposals already carry) | `packages/cli/src/lib/instructions/push.ts` |
| Push's open-proposal lookup (deadline, warn-and-send) | `packages/cli/src/lib/instructions/open-proposals.ts` |
| `doctor` checks, PATH lookup, `.mcp.json` reader | `packages/cli/src/lib/instructions/doctor.ts`, `path-lookup.ts`, `mcp-config.ts` |
| Repository-sourced checkouts: read-only git questions and the three bounded writes (clone, fetch, fast-forward), remote URL matching and the stored-URL spellings, classification and report lines | `packages/cli/src/lib/instructions/git.ts` (the vocabulary), `git-run.ts` (the runner and its environments), `git-write.ts`, `git-literals.ts`, `repository-identity.ts`, `checkout.ts` |
| The session hook's fast-forward: the gate, what each result prints, the run (lock, fetch, move), what is said once, the trace | `packages/cli/src/lib/instructions/fast-forward.ts` (pure), `fast-forward-run.ts`, `fast-forward-memory.ts`, `hook-trace.ts`, `packages/cli/src/lib/exclusive-lock.ts` (also the refresh lock's) |
| Finding the project from the checkout (resolver call, narrowing, the prompt) and what an id may look like | `packages/cli/src/lib/instructions/resolve-project.ts`, `prompt.ts`, `identifiers.ts` |
| What `init` does with a folder: adoption, tool detection, hooks, `.git/info/exclude`, retiring a lock | `packages/cli/src/lib/instructions/adoption.ts`, `tools.ts`, `init-hooks.ts`, `git-exclude.ts`, `drop-lock.ts` |
| The kept copy: what the hook runs, how it is written, and its daily self-update (the check, the bounded download and its integrity check, the in-memory tar read, the hook's clock) | `packages/cli/src/lib/instructions/hook-launcher.ts`, `self-update.ts`, `npm-tarball.ts`, `hook-timing.ts`; `packages/cli/src/lib/launcher.ts` (how every printed command starts); `packages/cli/__tests__/self-update.test.ts` pins each branch |
| Every outcome line and exit code; failures as fixed sentences | `packages/cli/src/lib/instructions/outcome.ts`, `failure.ts`; `packages/cli/__tests__/outcome.test.ts` pins every line |
| Credentials per deployment: profiles keyed by origin, issuer-bound sign-in, the browser sign-in, the `User-Agent` and upgrade line | `packages/cli/src/lib/config.ts`, `client.ts`, `origin.ts` (the packed origin: `__FABRIC_BAKED_ORIGIN__`, defined only by the bundle build), `oauth/session.ts`, `oauth/sign-in.ts`, `user-agent.ts` |
| A sign-in for one project: the resource it asks for (mirrored from `@repo/utils/oauth-project-resource`, which this published package cannot import) and the per-project entries | `packages/cli/src/lib/oauth/project-resource.ts` (`project-resource.test.ts` pins it), `config.ts`, `commands/auth/login.ts`, `logout.ts`, `whoami.ts` |
| `init`'s MCP step: running the tools, registering the server, reading the tools' files for `doctor` | `packages/cli/src/lib/instructions/agent-run.ts`, `agent-mcp.ts`, `agent-mcp-config.ts`; the one rule for what may be written into a command, `packages/cli/src/lib/shell-words.ts`; `packages/cli/__tests__/helpers/no-real-agent-tools.ts` keeps every other test off the machine's real tools; the Connect dialog's twin of the Codex name is `codexServerName` in `apps/web/modules/saas/projects/components/cli-connection/lib/agent-sign-in.ts`, held to it by `packages/cli/__tests__/server-name-agrees-with-web.test.ts` |
| Shared report vocabulary and declaration parser | `packages/cli/src/lib/instructions/checks.ts`, byte-identical after its header to `apps/web/modules/saas/mcp/lib/gateway/instruction-checks.ts`; `packages/cli/__tests__/checks-agree-with-gateway.test.ts` fails on any divergence |
| SDK resource | `packages/sdk/src/resources/instructions.ts` |
| REST routes | `packages/api/modules/v1/instructions.ts`, `packages/api/modules/v1/instruction-checkouts.ts`; the per-project read gate they share is `packages/api/modules/v1/instruction-project-gate.ts` |
| The shared server entry point behind a change | `packages/api/modules/projects/procedures/instructions/submit-change.ts` |
| MCP proposal tool | `apps/web/modules/saas/mcp/lib/gateway/platform-tools.ts` |
| MCP lesson tool (file name and frontmatter) | `apps/web/modules/saas/mcp/lib/gateway/instruction-lessons.ts` |
| Stop hook command (`lesson-prompt`) | `packages/cli/src/lib/instructions/lesson-prompt.ts` |

Three scopes, one per authority:

| Scope | Reaches | Live permission re-checked per call |
|---|---|---|
| `instructions:read` | `GET .../instructions/published`, `POST .../published/download`, `POST .../published/files` — `check`, `sync`, `init`, `doctor`, and the MCP tool `fabric_instruction_checks`; `GET .../instructions/proposals/open` — the open-proposal check `push` makes before sending; `POST /instructions/checkouts/resolve` — which projects a checkout's repository belongs to | `INSTRUCTION_READ` |
| `instructions:write` | `POST .../instructions/changes` — `push`, and the MCP tools `fabric_propose_project_instruction_change` and `fabric_add_instruction_lesson` | `INSTRUCTION_READ` |
| `instructions:publish` | `POST .../instructions/versions` — `push --publish` | `INSTRUCTION_CREATE` |

The scope is a ceiling and never a grant: every route independently re-checks
that the key's creator still holds the permission the Coding Instructions tab
requires for the same action, so the command line is neither broader nor
narrower than the browser.

`instructions:write` reads as a write scope a read-only role should not have,
and it is deliberately one a viewer may carry. What it reaches is the proposal
path — a suggestion somebody with edit rights approves or rejects — which is
exactly what a viewer can already do in the tab on `INSTRUCTION_READ`.
Withholding it would make the key narrower than the browser for the same
person. It cannot publish: `POST .../instructions/changes` has no mode to ask
for, and the publishing route refuses it by scope.

`instructions:publish` is the opposite case, and is described that way where
it is granted: **it creates a new version of a project's coding instructions
that publishes without review once its checks pass, for callers who could
publish in the tab, and it is never issued by the Connect dialog.** A key carrying it is created by hand
in the organization's API-key settings by a member or above — a read-only role
is refused it, because `INSTRUCTION_CREATE` is not a viewer permission — and
every call re-checks that the key's creator still holds `INSTRUCTION_CREATE`
on that project at that moment. Holding only this scope means a key can
publish but cannot open a proposal, and holding only `instructions:write`
means the reverse; a key may of course carry both. No MCP tool asks for it:
`fabric_propose_project_instruction_change` and `fabric_add_instruction_lesson`
are proposal-only and an agent cannot publish.

**The publish route requires an organization key by TYPE, not only by scope
name.** A personal (`fab_*`) key is refused here even when it happens to
carry `instructions:publish`-equivalent access through a wildcard `*` scope —
a legacy key from before this scope existed satisfies the scope check on `*`
alone, so the route re-checks the key's type before it looks at anything
else and refuses a personal key outright, with a 403 that says so. An
organization (`org_*`) key is the only credential that can reach this route,
whatever scopes it carries.

The Connect dialog mints `mcp:read`, `instructions:read` and
`instructions:write` for the coding-instructions flow, and says before the key
is created that a tool holding it can suggest a change held for review. It
never mints `instructions:publish`, which is what keeps that sentence true for
every key it has ever issued.

The `GET .../instructions/published` route mirrors the MCP
`fabric_get_project_instruction_bundle` tool's delta semantics: an equal
`sinceDigest` is answered before any file row is read, and an unknown base
answers `changes: null`, meaning "take a full copy".

On a repository-sourced project the response's `repository` block names the
repository and says how it is syncing:

| Field | Meaning |
|---|---|
| `host`, `path` | The repository's identity. GitHub and GitLab: the host and `<owner>/<name>` (a GitLab owner may be a subgroup path). Azure DevOps: always host `dev.azure.com` and the URL path with `_git`, `<org>/<project>/_git/<repo>` (`<org>/_git/<repo>` when the URL names no project), whichever of its remote spellings the project was connected with. |
| `cloneUrl` | The canonical HTTPS URL to clone from, with no credentials; `null` only for a legacy stored value that is not one. Fabric never hands out a repository token with it: the developer's own git authenticates. |
| `sync.automatic`, `sync.pausedReason` | Whether the published copy follows the branch on its own, and why it stopped doing so. Automatic sync is on by default for a newly configured repository sync; a project that turned it off keeps it off. |
| `sync.lastRun` | The newest run of the current configuration: `trigger`, `status`, `error` (a closed code, `TREE_REFUSED` being the secret scan refusing a commit), `commitSha` (the tip the run evaluated) and `finishedAt`. `status` and `finishedAt` are `null` while it runs; the whole field is `null` before the first run. |

`sync` moves on every sync, so a client that compares two responses to see
whether the configuration changed must leave it out.

`POST /instructions/checkouts/resolve` takes `{ "candidates": [...] }`, one to
ten canonical repository URLs of at most 512 characters, and answers
`{ "matches": [...] }` with the repository-sourced projects those URLs are
connected to that the caller may read: `projectId`, `projectName`,
`organizationSlug`, `provider`, `host`, `path`, `ref`, `rootPath` and
`cloneUrl`. A candidate with user information, a port, a query or a fragment,
or on an unsupported provider, is a 400 that names the position and never the
value. An empty list is the one answer for nothing connected, another
organization's project, no read permission, and a project that keeps uploads,
so the route cannot be used to discover which repositories other
organizations connected. Every project goes through the same per-project gate
as the routes above. The lookup compares the canonical URL ignoring letter case
(exactly otherwise: no pattern matching), and only finds repositories whose
connection is active; a repository whose connection has lapsed is answered
with an empty list.

The MCP tool `fabric_instruction_checks` takes an optional `checkout` — the
checkout's `remoteUrl`, `headSha`, `branch` (omitted when HEAD is detached)
and whether the tree is `clean` — and answers a `checkout` check labelled
`caller-reported`: `current`, `dirty`, `behind-or-diverged`, `other-branch`,
`foreign`, or `fabric-lags` when the checkout is at a branch tip Fabric's last
sync did not take (a refused commit, a failed or paused sync). It compares what
it is told and cannot tell behind from diverged without the history, so that
verdict says the session hook settles which at each session start, and that
re-running the setup line from the project's Connect dialog checks now. It names
no command that someone who only ran the `npx` line could not run. Every remedy
in the report is a proposal for the developer, never leave for the agent to run
git.

`POST .../instructions/changes` carries the changed files' bytes inline rather
than through signed uploads — a change set is a handful of small text files, so
a round trip per file buys nothing — and refuses a set over 50 changes or ~2 MB
of content. It computes each file's size and sha256 itself; a client-supplied
hash would only ever be a way to make the stored row disagree with the stored
object. Everything after that is the tab's own path: the same derived-snapshot
query, the same staging keys, the same validation workflow — whose publish
step this route never enables. The secret gate decides every file, but an
inherited file is read again only when its source version was not cleared by
the scan rule set now in force, so a one-file change checks and saves one file
(the unchanged ones are copied inside storage, never downloaded). A refusal carries a
`code` the CLI branches on — `PULL_FIRST`, `REPOSITORY_SOURCE_OF_TRUTH`,
`NOTHING_PUBLISHED`, `PROPOSAL_PROPOSER_LIMIT`, `PROPOSAL_PROJECT_LIMIT`.

`POST .../instructions/versions` is the same body, the same validation and the
same refusal codes, with the publish step enabled and no review state — the
two proposal caps do not apply, because a version is not a proposal. It is a
sibling route rather than a mode on the one above so that a key's scope list
alone says which of the two it can do. Its one behavioural difference worth
knowing: a proposal is deduplicated by the content of its change set, so a
retried request comes back with the proposal the first attempt opened, while a
version is not — the SDK therefore sends `publishChange` once and never
retries it, and a response lost in transit is reported rather than repeated.

The project supplies the tenant, which is what keeps an invited project guest
working: they hold a `ProjectMember` row and no membership in the host
organization, so a membership-based context check would refuse them for a
project they can open in the app. An explicit `?org=<slug>` still binds — it
is resolved without a membership check and must equal the project's own
organization, 404 otherwise — and `?personal=1` is refused, because coding
instructions are an organization surface with no personal arm to select. That
slug is only resolved after the caller's permission on the project has been
checked, and an unknown slug and a mismatched one get the same generic 404, so
no key can use `?org=` to discover which organizations exist.

## Related

- [Coding instructions design](../superpowers/specs/2026-09-16-coding-instructions-design.md)
- [API standards](../../fabric/standards/backend/api.md)
