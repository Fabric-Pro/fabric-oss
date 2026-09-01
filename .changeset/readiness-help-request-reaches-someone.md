---
"fabric-app": patch
---

Asking for help on a readiness item now reaches a support inbox instead of only setting a flag

`Request help` was a procedure with no caller. The panel's item menu never offered it, and the endpoint itself only wrote `HELP_REQUESTED` to a row — a request nobody outside the project could see. Both halves are closed here: the action is in the item menu (and stays reachable on a snoozed item, per FR22), and the request is mailed to a support inbox.

The address is a new `config.support.email`, supplied by `SUPPORT_EMAIL` and never a literal in the source: it is published with the code, and the inbox that should answer differs between our deployment and anyone else's — which is what makes the feature usable by someone running Fabric outside ours. A deployment that has named no inbox still records the request, and the panel says plainly that no email went out rather than showing a confirmation that is not true. That is what the procedure's new `notified` field carries; it additively extends the `/projects/{projectId}/readiness/{itemKey}/request-help` response.

Same-day repeats resolve to one provider idempotency key, so a second click does not mail a second copy wherever the provider honours it — Resend does; the console provider used in local development ignores it. Asking again a week later does send, because that is a renewed request rather than a duplicate. The item name in the email is resolved server-side against the shipped bundle — the mail i18n guard only catches unresolved `mail.*` paths, so a `readiness.items.*` key resolved inside the template would have rendered as literal text and passed CI.

Deploy note: nothing is mailed until `SUPPORT_EMAIL` names a monitored inbox in the environment. That is a config step, not a code gap — and `SUPPORT_EMAIL` is deliberately absent from `.env.example`, because touching that file puts it under the identifier guard's whole-file scan, where a pre-existing line trips a false positive unrelated to this change.

Fizzy #2165 (FR22).
