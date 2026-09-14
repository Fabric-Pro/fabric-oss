---
"fabric-app": patch
---

Ask a teammate to connect a coding tool, see when an API key is close to expiring, and let a read-only member create a read-only key.

Fizzy #2457, four follow-ups to the CLI-connection prompt.

**A read-only member can now get a key.** The ticket asked for this and the first
pass delivered only half of it: key creation reached members and above, leaving a
read-only role unable to obtain one at all. Viewers now hold key creation and
revocation, and the create handler clamps the requested scopes to what the
caller's live organization role can actually reach, refusing anything beyond it
rather than quietly narrowing. Twelve scopes qualify, each checked against what
the surface behind it enforces rather than against how its name reads.

**The prompt claims only what the record knows.** It used to say no coding tool
was connected. Nothing in the data supports "coding tool": a reach record carries
an organization, a credential and two timestamps, and although the protocol
offers a client to name itself at handshake, neither host reads or stores that —
a CLI, a desktop assistant and a script are one fact here. It now says nobody is
using the MCP surface, which is what was actually observed — and says it in the
present tense, because the signal underneath is present tense: a reach record
leaves the answer when its credential is revoked, expires, or its owner is
offboarded, so a team that connected with a key that has since lapsed has
plainly used MCP and would have been told nobody ever had. It also says nothing
about SETUP: a key can exist and a configuration block can be pasted without the
surface seeing any of it, so the prompt reports only what is reaching Fabric.
Tests forbid words implying intensity, recency, a kind of client, setup state,
or anything about the past.

**Ask a teammate.** A new control on the prompt notifies project members — picked
individually, or by function tag — naming who asked, about which project, and
what connecting takes. Recipients are resolved against the project roster
server-side, capped, deduplicated per person per project, and filtered to people
who can actually mint a key. The result reports what was delivered, what was
skipped and what failed, separately, so the sender is never told a colleague was
reached when they were not.

The email these send carries a fixed subject line with nothing typed by the
sender in it. A notification title becomes the subject verbatim, and a subject is
read in an inbox before anything identifies who sent it, so a display name there
reads as an identity rather than as content — and a display name is something its
owner chooses. The attribution moved into the body, where it is read alongside
the sender.

**Key expiry is visible.** The organization API keys table gained an Expires
column that reads Expired, Expiring soon, or No expiry in words rather than in
colour alone. Proactive warning ahead of expiry needs a scheduler and is not
included.
