---
"@fabricorg/cli": patch
"fabric-app": patch
---

A coding agent can now record a lesson from a session — a mistake the team should not repeat — as a proposed coding-instructions file with the new MCP tool `fabric_add_instruction_lesson`, and `fabric instructions init --lessons` installs a Claude Code Stop hook that asks the developer once per session whether there is one worth keeping.

The tool takes a project, a title, a body and the instruction files the lesson relates to, and writes `Lessons/<date>-<slug>.md` as an ordinary proposal through the same path as `fabric_propose_project_instruction_change`: a person approves it in the Coding Instructions tab and nothing changes for anyone else until they do. It needs the `instructions:write` scope, cannot publish, and is refused on a project whose instructions come from its repository. The Stop hook runs `fabric instructions lesson-prompt --hook`, which makes no network calls: it asks only once per session, only after the assistant has edited files, and tells the assistant to call the tool solely after the developer confirms a draft. Running `init` again without `--lessons` removes the hook; Codex does not get one yet.
