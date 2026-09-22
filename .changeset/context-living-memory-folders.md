---
"fabric-app": patch
---

Files synced into a project's Context tab from a working tree now appear under Living Memory, grouped by folder, and the contexts list can be filtered by folder path.

Each folder is a collapsible section, ordered by path with the project root first; a file is labelled with its name and shows its full path underneath. Items added any other way keep their place in the list. The contexts list accepts an optional `sourcePathPrefix` (for example `docs/guides`, or an empty string for every synced file) and answers a path that could never name a folder in the project with a 400.
