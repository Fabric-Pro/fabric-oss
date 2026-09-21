---
"fabric-app": patch
---

A setup-dependent action refreshes its explanation as soon as the setting behind it is saved, and its thin-context warning can now appear at all.

Three defects found in QA of dependency-aware capability gating on staging, all in the delivery of gates rather than in how they resolve.

**The gate went stale for the rest of the session after a scan configuration was saved.** Which scanners are enabled decides whether a scan needs a codebase at all, so saving can flip the gate either way, but the gate query lives in a provider mounted on the project layout and that save neither remounts it nor touches its cache. Turning a repository scanner on left Scan pressable with no explanation; turning it back off left the block in place over a capability that was available again. Switching project tabs did not clear it — only a full reload did. The save now refreshes the gates explicitly.

**The thin-context warning could never be seen.** It grounded a project on a description of 50 characters or more, while project creation refuses a brief of 50 characters or fewer — so every project the product can create cleared the bar by construction and the warning was unreachable in the UI. The two numbers were set by different changes for different purposes and happened to meet. The grounding bound is now its own named constant, deliberately a paragraph rather than a sentence, with a regression test that fails if it drifts back towards the creation floor. Documents and project context still ground a generation on their own, so a terse brief on a project that has real sources warns nobody.

**A warning could be dismissed permanently with no way back.** The banner carries dismissal, including "do not show again for this project", but the control that restores dismissed warnings was mounted only on the Security tab. The document generators that warn had no route back, which mattered the moment the warning above became reachable. It is now mounted beside the banner and scoped the same way, so restoring never undoes a dismissal made against another generator.

Also records why the settings repository-connection rule intentionally has no banner: its UI half is already served, more precisely, by the existing settings row, while the rule itself still answers coding agents and the public API. A QA pass read that silence as dead code and nearly deleted it.
