---
"fabric-app": patch
---

Publishing Suite: make the Topic Item Page's edit controls work, and let the Decision Log fill its tab panel

Two defects found while QA-testing the Topic Item Page (Fizzy #1851) on staging.

**"Edit post types" did nothing.** The page mounts the same `TopicDetails` block
the Inbox row does, and that block only invokes the callbacks it is handed. The
Inbox row wires them to `PostTypesDialog` and `PublishTopicDialog`; the Item Page
passed `() => undefined` for both. The buttons therefore rendered enabled and
were inert — no dialog, no write, no error to explain the silence. Both are now
wired to the same procedures the row uses, with the same contract: the dialog
closes only *after* the write lands, so a failed save keeps the user's checkboxes
or typed URL instead of discarding them, and a failure raises the same toast
rather than passing silently.

The second control, "Edit/Add URL", was dead for the identical reason but was
never reported: `TopicDetails` renders it only for a `PUBLISHED` topic, and the
project under test had none. It is fixed here rather than left as a known-dead
button on a component this change already touches.

Both writes invalidate the topic query *and* the topic list, because the chips
they change are rendered by both surfaces and invalidating only one leaves the
other showing pre-edit values until it refetched on its own.

**The Decision Log floated in the middle of the page.** Its section carried
`mx-auto max-w-3xl`, inherited along with the structure when it was written to
mirror Feature Maturation's `DecisionLogPanel`. That sibling sits in a narrow
column, where the cap is right; this one is a tab panel whose siblings —
`TopicQuestionsPanel` and `PlanningAnalysisTab` — are plain `space-y-*` with no
cap at all. The carried-over rule pinned the log to 768px and centred it inside a
much wider panel, leaving a large empty gutter and visually detaching the list
from the tab bar above it and the Content Generation block below. The log now
fills its panel like every other tab.

Two other QA findings are deliberately *not* changed here. The Decision Log's
filter bar still does not render in the empty state — a documented decision, with
a test pinning it, on the grounds that a filter over nothing is not a control.
And the default Topic Planning & Analysis prompt's absence from the Prompt
Library is not a code defect: the prompt is defined in `seed-prompts-only.ts`,
no migration inserts prompts, and a deployed environment therefore needs that
seed re-run.
