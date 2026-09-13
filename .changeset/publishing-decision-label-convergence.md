---
"fabric-app": patch
---

Name an unresolved approval the same way on the topic page and in every drafting prompt

* the generation tab and the drafting prompts now compute an approval's name with one shared function, so a subject that is blank or only whitespace no longer shows as an empty bullet on the tab where the prompt names the approval's kind;
* a settled decision whose kind was never classified is now named "An unclassified decision" rather than "Other" in the decisions block of every content type's prompt, and a subject spanning several lines is folded onto one there;
* the topic assistant is no longer handed a blank entry in the topic's open questions; the page names a question without a subject by its text and hands the assistant each question on one line.
