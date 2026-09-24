---
"fabric-app": patch
---

An uncaught coding-instructions automatic-check failure now logs the stage that failed, the sync and project identifiers, and the error's class before the check rethrows it.

Fizzy #2684. The worker log carried only the wrapped activity failure, so the stage had to be recovered from the failure receipt. The structured line names a lease, permission, remote-head, failure-receipt, or write-back failure without logging the error's message, the repository ref, the integration URL, or a credential.
