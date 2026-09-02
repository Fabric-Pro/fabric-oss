---
"fabric-app": patch
---

Stop one `@` mention naming two people when one display name is a prefix of another

`mentionedMemberIds` tested every member's name independently, so a token could satisfy two of them at once. The `(?!\w)` guard stops `@Sam` matching inside `@Sammy`, but it does not stop a name that is a prefix of a longer one when the longer one continues past a SPACE: in `@Ann Lee` the character after `Ann` is a space, the guard passes, and a member called "Ann" matched the same token as "Ann Lee".

The visible symptom was an Ask button reading "Ask Ann & Ann Lee" for a single typed `@Ann Lee`, and — had it been clicked — a question assigned to somebody nobody had named, plus a notification they had no reason to receive. Two accounts whose display names are a person and that person's second test account is the ordinary way this arises, not a corner case.

Longest label now wins: candidates are tried longest-first and each match claims its span, so a shorter prefix cannot also match inside a longer name's token. Two people genuinely mentioned in the same sentence still both resolve — `@Ann and @Ann Lee` names both, because the first token's span is free. Output keeps the caller's member order so the Ask label reads the same every time.
