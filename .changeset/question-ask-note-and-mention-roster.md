---
"fabric-app": patch
---

Show the sentence an asker typed in the question notification and on the question itself, and stop a second `@` mention un-naming the first

Three defects reported against question routing (Fizzy #1751), one client-side and two on the ask path.

**Mentions lost everyone but the last name.** `assignableMembers` is a server SEARCH RESULT — every keystroke after an `@` replaces it with just that token's matches — and `SummaryQuestionsPanel` resolved mentions against it. So `@Ann and @Bob` resolved to Bob alone (the roster had narrowed to the `@Bob` query), while a bare `@` — an unfiltered search returning everybody — named all three and read as "Ask 3 people". Both the id resolution and the name lookup behind `formatAskNames` had it. The panel now accumulates every member the search has returned and resolves against that union; the picker and the `@` popover keep the filtered list, because narrowing is what they are for.

**The ask never reached the notification.** `fanOut.questionAssigned` hardcoded the question summary as the snippet and the procedure never passed the note, so a recipient got "X is asking you about <feature>" with no idea what was asked. The note is now the snippet, falling back to the question summary when the assignment carries none.

**And it never reached the page the notification links to.** The note was stored as a Decision Log reply and `renderThread` renders only `thread.root`, so the deep link landed on a bare assignment — the ask itself was only visible one tab over. Open questions now render their turns (author + time + body); answers can't appear there, since answering flips the root out of `OPEN`.

Two smaller consequences of the same defect: an ask carrying a note now notifies everyone the question is waiting on, not only the people that call ADDED — asking again someone already assigned produced an empty `added` and reached nobody — and the notification's dedupe key folds in the note's turn id, so a second ask is a second notice rather than one the unread-only dedupe swallows. A bare re-save with no note is still silent, so toggling avatars in the picker never spams the room.

`appendDecisionLogReply` gained `authorName`, captured at write time as answer turns already do, so the rendered note is attributed.
