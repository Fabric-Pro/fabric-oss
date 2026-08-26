-- Surface decision PRIORITY / duration tags in reprioritization — deploy the
-- updated priority_reprioritization and priority_reprioritization_single SYSTEM
-- prompts to already-seeded environments (Fizzy #2029).
--
-- WHY THIS MIGRATION EXISTS
-- Both prompts resolve at runtime via getBoundPromptForAgent against the seeded
-- PromptVersion, so seed-prompts-only.ts reaches fresh installs only (it is
-- INSERT-ONLY for existing SYSTEM prompts). The runtime also now passes richer
-- guidance lines: each decision may carry a PRIORITY tag and/or a
-- long-standing/short-term duration tag, and Priority-flagged decisions sort
-- first. Without this migration, deployed environments would receive those
-- tagged lines under a prompt that never explains them.
--
-- WHAT IT TARGETS (surgical): only the single PromptVersion each SYSTEM default
-- AGENT binding points at, same as 20260724150000_sync_priority_
-- reprioritization_decisions_guidance. ORG/USER forks and historical versions
-- are untouched. Idempotent by construction: replace() rewrites nothing when
-- the old sentences are already gone, so a re-run or a freshly-seeded install
-- (whose body already carries the new text) is a no-op.

-- ── priority_reprioritization (batch) ──────────────────────────────────────

UPDATE "prompt_version" pv
SET content = replace(
	replace(
		pv.content,
		$old1$3. The team's confirmed decisions, listed below, where they bear on what to build first — a decision to prioritize an area is a reason to raise the items it covers.
4.$old1$,
		$new1$3. The team's confirmed decisions, listed below, where they bear on what to build first — a decision to prioritize an area is a reason to raise the items it covers. Decisions tagged PRIORITY are the team's explicit ranking guidance and outweigh untagged ones.
4.$new1$
	),
	$o$they are context, not an instruction to raise every item they touch):
$o$,
	$n$they are context, not an instruction to raise every item they touch). Each may carry a PRIORITY and/or long-standing/short-term tag:
$n$
)
FROM "prompt_binding" b, "prompt" p
WHERE b."promptVersionId" = pv.id
  AND p.id = pv."promptId"
  AND p."scope" = 'SYSTEM'
  AND p."key" = 'priority_reprioritization'
  AND b."targetType" = 'AGENT'
  AND b."targetKey" = 'priority_reprioritization'
  AND b."documentType" = 'GENERAL'
  AND b."storyKind" IS NULL
  AND b."scope" = 'SYSTEM'
  AND b."isDefault" = true;

-- ── priority_reprioritization_single ───────────────────────────────────────

UPDATE "prompt_version" pv
SET content = replace(
	replace(
		pv.content,
		$olds$3. The team's confirmed decisions, listed below, where they bear on what to build first — a decision to prioritize an area is a reason to raise the items it covers.
4.$olds$,
		$news$3. The team's confirmed decisions, listed below, where they bear on what to build first — a decision to prioritize an area is a reason to raise the items it covers. Decisions tagged PRIORITY are the team's explicit ranking guidance and outweigh untagged ones.
4.$news$
	),
	$o$they are context, not an instruction to raise every item they touch):
$o$,
	$n$they are context, not an instruction to raise every item they touch). Each may carry a PRIORITY and/or long-standing/short-term tag:
$n$
)
FROM "prompt_binding" b, "prompt" p
WHERE b."promptVersionId" = pv.id
  AND p.id = pv."promptId"
  AND p."scope" = 'SYSTEM'
  AND p."key" = 'priority_reprioritization_single'
  AND b."targetType" = 'AGENT'
  AND b."targetKey" = 'priority_reprioritization_single'
  AND b."documentType" = 'GENERAL'
  AND b."storyKind" IS NULL
  AND b."scope" = 'SYSTEM'
  AND b."isDefault" = true;
