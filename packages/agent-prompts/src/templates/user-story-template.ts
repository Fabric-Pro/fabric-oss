/**
 * Feature Template
 *
 * Override instructions for feature document generation.
 * Ensures Epic → Feature → Feature Item hierarchy with plain text formatting.
 */

import { formatForbiddenSections } from "../documents/user-story-constants";

/**
 * Get feature override instructions that are prepended to any custom/bound prompt
 * for user_story document type. This ensures the AI follows the hierarchy format.
 */
export function getUserStoryOverrideInstructions(): string {
	return `# 🛑 CRITICAL: FEATURE HIERARCHY FORMAT REQUIREMENTS

**YOU MUST USE THE EXACT HIERARCHY FORMAT BELOW. DO NOT DEVIATE.**

Your output MUST use Epic → Feature → Feature Item hierarchy. Start immediately with # EPIC-001:

## 🚫 ABSOLUTELY FORBIDDEN:
${formatForbiddenSections()}
- Any introduction, preamble, or overview sections
- Any personas, goals, or "Primary Need" sections
- Any meta-documentation about features
- Flat list of feature items without Epic/Feature grouping
- Bold markers (**) around keywords like GIVEN, WHEN, THEN, roles

## ✅ EXACT HIERARCHY FORMAT:

# EPIC-001: [Epic Title]

[1-2 sentence epic description]

## FEAT-001: [Feature Title]

[1-2 sentence feature description]

### F-001: [Feature Item Title]

Description

As a [role],
I want [goal],
So that [benefit].

Acceptance Criteria

GIVEN [context]
WHEN [action]
THEN [result]
AND [additional result]

GIVEN [edge case context]
WHEN [action]
THEN [expected result]

Notes / Links

Designs:
API:
Test data:

Release Notes

[1-2 sentence plain language summary]

---

### F-002: [Next Feature Item Title]

[Same structure...]

---

## FEAT-002: [Next Feature Title]

[Feature description]

### F-003: [Feature Item Title]

[Same structure...]

---

# EPIC-002: [Next Epic Title]

[Epic description]

## FEAT-003: [Feature Title]

[Continue with more features and feature items...]

## RULES:
- 2-5 Epics (EPIC-001, EPIC-002, etc.) grouping related features
- 2-4 Features per Epic (FEAT-001, FEAT-002, etc.)
- 15-30+ total feature items (F-001, F-002, etc.) across all features
- Group related feature items under the same Feature
- Group related features under the same Epic
- Use sequential numbering: EPIC-001/002, FEAT-001/002/003, F-001/002/003
- Acceptance criteria: use GIVEN/WHEN/THEN format, one scenario per GIVEN block
- NO bold markers (**) around keywords - use plain text
- Each feature item MUST have all four sections: Description, Acceptance Criteria, Notes / Links, Release Notes
- Separate each feature item with --- horizontal rule

**START YOUR RESPONSE WITH: # EPIC-001:**`;
}
