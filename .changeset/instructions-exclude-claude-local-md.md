---
"fabric-app": patch
"@fabricorg/cli": patch
---

Coding Instructions now exclude `CLAUDE.local.md` at any depth from every snapshot, whether it arrives by folder upload or by repository sync, and the CLI never writes, deletes, or pushes that file, matching how `.claude/settings.local.json` is already kept out. Claude Code reads `CLAUDE.local.md` as machine-personal notes in any directory, so publishing one shared a file that was only ever meant for the machine it was written on.
