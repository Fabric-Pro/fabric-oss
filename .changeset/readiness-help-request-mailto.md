---
"fabric-app": patch
---

Request help now opens a pre-filled draft in your own mail client instead of sending from Fabric, and replies to Fabric email reach the support inbox

The readiness checklist's "Request help" sent the mail itself and then reported
that the support inbox had been notified. Two things were wrong with that. The
message carried only fields, so nobody could say what was actually stuck; and
it went out from a no-reply sender, so the answer had nowhere to go.

The button now returns a `mailto:` draft the person sends themselves. The body
carries the full payload the spec asked for — organization, project, checklist
item, requester, timestamp and the deployment URL — of which organization name,
timestamp and deployment were missing from the old email entirely. It opens with
blank lines so the cursor lands above the context block rather than below it.

The "Help requested" label goes with it: once the person sends the mail
themselves, Fabric cannot honestly show a request as outstanding. Readiness
scores are unaffected — Help Requested and Incomplete already count identically
as active gaps. The `HELP_REQUESTED` state and the `everHelpRequested` analytics
flag are both still written, so this is reversible and the friction is still
measurable.

Separately, `sendEmail` gained `replyTo`, defaulting to the configured support
inbox. Every Fabric email goes out from a no-reply address with no mailbox
behind it, and the mail helper had no reply-to support at all, so hitting Reply
on a magic link or an invitation reached nobody. The From header and the sending
domain are unchanged, so deliverability is untouched.

Composing a draft needs no mail provider, sending domain or credentials, so
"Request help" now works on a self-hosted install that has configured nothing
beyond the address itself.

Also retires the now-unused ReadinessHelpRequested email template, and points
Code of Conduct reports at the merged shared inbox.
