---
"fabric-app": patch
---

Make the whole Inbox card open its topic, and let the age and role reason be seen

The row's summary column had grown to four consecutive lines of grey text — angle, pitch, role reason, then age and staleness — and the two that answer "why am I looking at this, and is it still worth it" were the two at the bottom (Fizzy #1851).

**The age moved into the action column**, beside the status, mute and snooze controls it belongs with, and out of a stack it was competing in. It is hidden below the `sm:` breakpoint, where that cluster wraps under the title anyway.

**"Matches your role" became a pill.** A new `variant` on `TopicRankReason` rather than a replacement, so the topic page's mount and the flag-off row's snapshotted markup stay byte-identical.

**The staleness badge escalates in four steps rather than two.** A 12-day row and a 29-day row wore the same pill; they now run subtle amber, amber, orange, red. The bands stop at 25 rather than 30 on purpose — a topic archives out of the list at 30, so red is the last state seen before it disappears rather than one it rests in. Colour is never the only carrier: the number and the word beside it say the same thing.

**The whole card opens the topic.** Only the title was clickable before. Everything interactive inside the row keeps its own behaviour, and three gestures are deliberately left alone: a modified or middle click belongs to the title anchor so "open in new tab" still works, and a click that ends a text selection belongs to whoever was copying the pitch. The row is not made focusable — the title is already a real anchor carrying the keyboard and screen-reader path, and a second tab stop to the same destination would be worse for a keyboard user, not better.
