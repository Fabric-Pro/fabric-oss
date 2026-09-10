---
"fabric-app": patch
---

Consolidate the remaining published contact addresses onto the single support inbox

Follows the first pass, which covered the code-of-conduct, contributing and waitlist
surfaces. This one takes the rest of the published addresses: the security disclosure
address in the security policy, the enterprise-pricing address in the organizations docs
(English and German), the company address in the privacy policy and terms, and the
contact point in the marketing page's structured data.

Fizzy #2352. The security disclosure address was raised as a concern before this change
and merged deliberately, with the option of splitting it back out if the shared inbox
proves wrong for that traffic.

The outbound sender default is untouched on purpose: it is a from address, not an inbox,
so consolidating it would mean sending product mail from the support queue rather than
routing anything into it.
