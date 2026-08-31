---
"fabric-app": patch
---

The versioned REST API resolves an organization instead of honouring a personal-context flag

Four inputs decided which tenant a v1 request ran in, and only two of them were ever safe. An organization key carries its tenant on the key record, and `?org=<slug>` is looked up and membership-checked. The other two — `?personal=1`, and sending nothing at all — both resolved to no organization, which is the context being removed.

Both now resolve through the same helper the protocol servers use, so a key-authenticated caller meets one rule wherever it arrives.

`?personal=1` is still accepted rather than rejected, deliberately. The command-line client persists a chosen context and keeps sending the flag until its user upgrades, so refusing the parameter outright would break installed clients the moment the server changed. It is accepted, ignored, and resolves to an organization — which is what a no-op has to mean for a flag already in the field.

The refusals match the protocol servers: several organizations and none named is answerable by naming one and returns 400; belonging to none is not answerable and returns 403.

The command-line client still advertises `--personal` and can still store it as a default. That surface is unchanged here and is the remaining half of this item.
