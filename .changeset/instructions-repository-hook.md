---
"fabric-app": patch
"@fabricorg/cli": minor
---

The `fabric instructions` session hook and `init` now work in a checkout of a project's instruction repository, reporting when the configured branch has newer published instructions instead of refusing.

In a checkout of the repository the hook only reports: it asks git a fixed set of read-only questions (which remote fetches from the repository, which branch is checked out, whether the published commit is in `HEAD`'s history) and prints one line on stdout, or nothing when the checkout is current. It never downloads, writes a lock, or changes the checkout. Outside any git checkout a repository-sourced project keeps the upload behaviour, and anywhere else the hook prints one line naming the kind of directory and writes nothing. `init` writes the hook in a checkout of the repository and refuses in a checkout of anything else. `doctor` checks the hook, and in a checkout of the repository compares commit ancestry instead of the lock. `check --format json` adds a `checkout` block. A command whose later server response names a different source or repository configuration than its first one now stops before writing anything. The published-instructions response now reads the project's source of truth and repository configuration in one read, so it never pairs an upload source with a repository, and a repository sync whose branch or connected repository changed publishes a new snapshot even when the files are identical, so the published snapshot names the branch it came from.
