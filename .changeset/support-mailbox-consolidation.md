---
"fabric-app": patch
---

Point the code-of-conduct, contributing and waitlist contact addresses at the single support inbox

Three surfaces named mailboxes that were never provisioned, so mail sent to them went
nowhere: the code-of-conduct and contributing reporting address, and the `to:` on the
waitlist signup notification. All three now name the one support inbox the team agreed
to consolidate on, and `SUPPORT_EMAIL` — read by the readiness checklist's "Request
help" — is documented in `.env.example`, which it was missing despite being the only way
to configure that path.

Fizzy #2352. The reporting address had been moved to a dedicated alias in #2082 to keep
conduct reports away from an operational inbox; merging it back into support is a
deliberate call made with that history in view, taken because the dedicated alias was
never actually created and reports were going nowhere at all.

Out of scope, unchanged, and each for its own reason: the security disclosure address
stays separate by the card's own scoping, the sales address is not a support surface, the
addresses in the privacy policy and terms are legal copy, and the `MAIL_FROM` default is
an outbound sender rather than an inbox.
