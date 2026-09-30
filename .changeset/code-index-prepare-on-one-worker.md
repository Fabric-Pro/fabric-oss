---
"fabric-app": patch
---

Repository code indexing no longer fails, or stays stuck as "indexing", when a different worker picks up the job between cloning a repository and scanning it.

Cloning, secret scanning and the file walk now run as one step on the worker that holds the clone. Any failure that ends an indexing run now marks the index as failed instead of leaving it in progress.
