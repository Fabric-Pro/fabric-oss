# CLAUDE.md

@AGENTS.md

Read and follow [AGENTS.md](AGENTS.md) as the canonical shared repository
guidance. Also read `CLAUDE.local.md` when it exists; it is intentionally
untracked and its private content must never be copied into public files.

Do not duplicate shared engineering policy here. Update `AGENTS.md`, its routed
canonical document, or deterministic enforcement instead. Keep this file as a
thin Claude Code compatibility shim so Claude and other coding agents operate
from the same source of truth.

## Claude Code integration

The checked-in hooks under [`.claude/hooks/`](.claude/hooks/) enforce selected
destructive-command, secret-path, SQL, public-identifier, and attribution
boundaries. Treat a hook refusal as a policy result: use the safe alternative
it reports rather than bypassing or weakening the hook.

Claude-specific tool availability does not broaden authorization. In
particular, do not restart Aspire resources, mutate GitHub, relay a PR, deploy,
or message external systems unless the user's requested workflow authorizes
that action. All shared validation, changeset, DCO, tenancy, and delivery rules
remain in `AGENTS.md`.
