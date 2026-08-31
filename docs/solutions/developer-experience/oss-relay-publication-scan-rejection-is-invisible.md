---
title: "OSS relay fails silently: the publication scan names a rule and a hash, and reports nothing back to the PR"
date: 2026-08-31
category: developer-experience
module: oss relay / publication boundary
problem_type: developer_experience
component: ci
severity: medium
symptoms:
  - "A /relay comment is posted, CI on the staging PR is fully green, and nothing else happens — no comment, no status, no label change."
  - "A PR whose relay was rejected is indistinguishable from one where no relay was ever attempted."
  - "The only error text is 'publication scan rejected file content <12 hex chars>: unsanctioned email address' — no file, no line, no matched text."
  - "The offending content turns out to be a line the branch never wrote."
root_cause: "The publication scan runs after authorization, in the ops repository, and deliberately reports a rule name plus an opaque fingerprint so a public run log cannot disclose what it caught. It writes nothing back to the staging PR, and it scans only changed blobs but scans each one whole — so a line untouched for years fails on its first contact with the relay."
resolution_type: diagnosis
applies_when:
  - "A /relay comment produces no visible outcome on the staging PR"
  - "An OSS Relay run fails in 'Build and scan the synthetic commit off-repository'"
  - "You need to map a publication-scan fingerprint back to a file"
tags: [oss-relay, publication-scan, identifiers, pii, ci, fingerprint, ship]
related_components: [ship]
---

# The relay's rejection is real, and almost nothing shows it

## Context

`/relay <sha>` is posted, the label is on, every staging check is green — and
then nothing. No comment, no status, no label change. **A PR whose relay was
rejected looks exactly like one where no relay was ever attempted.** The silence
is the failure mode, not a symptom of one.

## Why so little is shown

The publication scan is the boundary that decides what leaves the private tree.
Its run log is itself public, so it must not print the thing it caught: naming
the file, the line or the matched text in a public log would disclose exactly
what the boundary exists to withhold. It prints a rule name and a fingerprint,
and that is all it is allowed to print. The same reasoning governs the local
`Identifiers` hook, which reports a rule number without echoing the match.

## Finding the run

1. The run is in the **ops** repository, not the one holding the PR:

   ```bash
   gh run list --repo Fabric-Pro/fabric --workflow oss-relay.yml
   ```

2. **Runs from different PRs interleave.** Match `EXPECTED_HEAD_SHA` in the run's
   env against your own head before reading any error — otherwise you will
   confidently diagnose someone else's failure. This is easy to do and hard to
   notice.

   ```bash
   gh run view <id> --repo Fabric-Pro/fabric --log \
     | grep -o "EXPECTED_HEAD_SHA: [0-9a-f]\{40\}" | head -1
   ```

3. ```bash
   gh run view <id> --repo Fabric-Pro/fabric --log-failed | grep '##\[error\]'
   ```

## Mapping the fingerprint back to a file

It is `sha256` of the **path**, first 12 hex characters — not of the content:

```bash
git diff --name-only origin/master...HEAD | while read -r f; do
  printf '%s  %s\n' "$(printf '%s' "$f" | shasum -a 256 | cut -c1-12)" "$f"
done | grep '^<fingerprint>'
```

## The finding is usually not yours

Only changed blobs are scanned, but **each is scanned whole**. The content that
rejects is therefore most often a line that has sat in a touched file for years
and is meeting the scan for the first time — not something the branch wrote.
Check the line's history before assuming authorship.

## The email rule specifically

Sanctioned, per `.github/scripts/oss-relay/scan-publication.mjs` in the ops repo:
`example.com`, `example.net`, `example.org`, `fabric.local`; the suffixes
`.example`, `.invalid`, `.test`; eight named public addresses; and bot noreply
addresses. Everything else rejects.

That includes `git@github.com` — an SSH URL scheme rather than a person, with no
identity in it, which any honest SSH-form fixture needs. A fixture cannot dodge
it by changing the host: the code under test asks `isGitHubRepoUrl`, so a
different host does not fix the test, it silently inverts it.

## How to fix a false positive

In the scanner's allowlist — `PATH_EMAIL_ALLOWLISTS`, as already done for
`pnpm-lock.yaml` — or by adding the value to the sanctioned set when it is a
scheme constant rather than an address.

**Not** by breaking the literal up in the source so the regex stops matching.
That is the "way around the check" the identifier rules forbid, it leaves the
next occurrence to be rediscovered from scratch, and it puts a workaround in
product code to satisfy a tooling gap.
