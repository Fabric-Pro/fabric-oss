---
"fabric-app": patch
---

Project-scoped API procedures, and the public coding-instructions API when used with a personal key, now answer "Project not found" to a signed-in user who has no membership in a project or its organization, instead of "Forbidden", so a request can no longer reveal whether a project id in another organization exists. Members whose role lacks a permission still receive the permission error.
