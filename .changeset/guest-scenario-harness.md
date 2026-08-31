---
"fabric-app": patch
---

Ship the guest-scenario harness that found the guest defects

It lived under `local/`, which is gitignored, so the thing that found most of the guest problems did not travel with the changes that fixed them. It builds an owner and a project-only guest through the real signup path, so the auto-organization hook fires exactly as it does in production — inserting the rows by hand would have proved nothing about the property being checked.
