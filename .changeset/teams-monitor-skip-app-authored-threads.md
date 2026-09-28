---
"fabric-app": patch
---

Teams channel and chat monitors no longer run an AI backlog analysis on conversation threads posted only by apps, bots, or connectors, so a channel that only ever receives automated messages stops generating and paying for per-thread AI calls that were never going to produce anything.

The skip only applies when every message currently visible in a thread is positively known to be app-authored; a thread containing any human or not-yet-attributed message, or whose reply list Microsoft Graph has not fully returned yet, is still analyzed as before.
