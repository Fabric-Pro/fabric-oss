# AI Copy Tone Standards

## Overview

All AI-generated or AI-assisted UI text must follow these tone guidelines to maintain a consistent, trustworthy user experience.

## When to Apply

- AI suggestion text (e.g., kanban card suggestions, document improvements)
- Confirmation prompts for AI-generated changes
- AI status messages and progress indicators
- AI error or fallback messages

## Principles

1. **Calm, advisory, non-authoritative** -- suggest, don't command
2. **Never claim** "best", "optimal", or "required"
3. **Never auto-apply** AI changes; user must explicitly accept
4. **Always allow dismissal** -- every suggestion has a clear close/dismiss option
5. **Neutral, supportive language** -- avoid hype or pressure

## Examples

| Bad | Good |
|-----|------|
| "This is the best structure for your document" | "Here's a suggested structure you might consider" |
| "You should reorganize these tasks" | "These tasks could be grouped differently" |
| "Optimizing your workflow..." (auto-applied) | "Suggested changes are ready for your review" |
| "Required: Update your prompt" | "You may want to update this prompt" |

## Reference Implementation

Kanban AI copy constants: `apps/web/modules/saas/projects/lib/kanban-ai-copy.ts`
