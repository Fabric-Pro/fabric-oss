# Markdown Validation Roadmap

This document tracks the markdown validation pipeline
(`src/core/document-patches.ts:validateMarkdownStructure`) and the planned
follow-up to adopt community-maintained remark-lint plugins.

**Current state (Option 2 landed):** the validator is backed by an mdast
AST built via `unified` + `remark-parse` + `remark-gfm`. The previous
chain of regex-based detectors (`findBoldWrappingNoWord`, `findBoldEndOfLineMarker`,
…) was deleted in favor of structural rules: any `**` that fails to form
an emphasis span lands in a text-node value and gets caught once by the
`unrendered_bold` rule, regardless of which specific pattern caused the
failure (no-word content, internal whitespace, end-of-line markers,
cross-paragraph spans, unbalanced parity).

**Defect taxonomy** (collapsed from 12 codes to 8):

| Code | What it catches |
|---|---|
| `unrendered_bold` | Any `**` in a text node — bold did not parse for any reason |
| `unbalanced_inline_code` | Backtick in a text node — inline code did not pair |
| `unclosed_code_fence` | Source-level odd count of ``` boundary lines |
| `stray_closing_bracket` | `)`, `]`, or `}` on its own line |
| `orphan_list_marker` | List item with no body content |
| `leading_mid_sentence_punct` | Paragraph or list item starting with `;`, `,`, `:`, `?`, or `!` |
| `bold_followed_by_word` | Properly-rendered emphasis followed immediately by capitalized text in same parent |
| `mixed_list_markers` | Multiple unordered items each containing a nested ordered sub-list with start > 1 (the parse result of `- 2. text` / `- 3. text`) |

---

## TODO — Option 3: adopt remark-lint plugins for additional coverage

**Goal:** integrate community-maintained remark-lint plugins for checks
that are well-defined elsewhere, instead of building our own AST visitors
for them.

**Estimated effort:** ~2-3 days.

**Plugins to adopt:**
- `remark-lint-no-emphasis-as-heading` — flags `**Heading**` used as a
  section header (a defect we've seen in stage transitions, not currently
  caught).
- `remark-lint-emphasis-marker` — enforces consistent `*` / `_` markers
  (low priority; not actually a brokenness defect, more of a style
  consistency concern).
- `remark-lint-heading-increment` — flags h1 → h3 level skips.
- `remark-lint-no-duplicate-headings-in-section` — duplicate-heading
  detection. We already have a custom `detect_duplicate_heading` for
  the `replace_section` mistake pattern in `validatePatchContent`;
  keep that for the patch-specific case but consider also running
  this plugin on the post-apply document for general-purpose
  duplicate-heading hygiene.

**Implementation sketch:**
1. Add deps: `remark-lint`, `remark-lint-no-emphasis-as-heading`,
   `remark-lint-heading-increment`, `remark-lint-no-duplicate-headings-in-section`.
2. Compose the existing processor in `getMarkdownProcessor()` with the
   lint plugins via `.use()`.
3. After parse, the processor exposes `file.messages` (vfile messages)
   for any rule violations. Map these to `MarkdownStructureDefect` shape
   alongside the AST visitor results.
4. Decide for each plugin: blocking (return as defect) vs advisory
   (log only). Stylistic plugins (`emphasis-marker`) are advisory;
   structural ones (`no-emphasis-as-heading`) are blocking.

**Risk:** vfile message format and remark-lint rule outputs may not map
cleanly to our existing `MarkdownStructureDefect` shape. The mapping
layer needs care to preserve line numbers and useful detail strings
that the model can act on in retries.

---

## TODO — Diagnostic logging for "validator caught it but model never
fixed it" cases

**Goal:** when the agent retry loop exhausts MAX_RETRIES against the
same defect code, log enough context (last patch attempt, defect
detail, number of consecutive same-code failures) to diagnose whether
the corrective hint is too vague or the model is genuinely stuck.

**Estimated effort:** ~½ day.

This is independent of Option 3 — addresses the meta-question of
whether the validators are useful in their current form, not whether
to add more.

---

## References

- [remarkjs/remark](https://github.com/remarkjs/remark) — AST-based
  markdown processor.
- [remarkjs/remark-lint](https://github.com/remarkjs/remark-lint) —
  plugin catalog (~70 rules).
- [unifiedjs.com](https://unifiedjs.com) — the `unified` ecosystem.
