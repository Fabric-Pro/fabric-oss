---
"fabric-app": patch
---

Case study, newsletter blurb, stakeholder email and webinar script drafts now show the model the question a project member answered, and any questions merged into it, beside each settled approval, and tell it that an answer approves what those questions asked and what the answer itself names, not more; an answer started before a newer planning analysis refreshed the question is no longer recorded, and the page asks for it again.

The answer endpoint accepts an optional `expectedAnalysisVersion` and returns `question_changed` when a newer analysis has refreshed the question since, even with unchanged wording; a caller that omits it is not checked. A migration adds two columns to `publishing_topic_decision_entry` (`foldedQuestions`, `foldedQuestionsVersion`), and operators get a warning log line when a settled approval is shown cut or without its question.
