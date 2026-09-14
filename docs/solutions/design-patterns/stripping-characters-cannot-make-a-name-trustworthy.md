---
title: "Stripping characters cannot make a name trustworthy"
date: 2026-09-11
category: design-patterns
module: api temporal web
problem_type: design
component: notifications
severity: medium
applies_when:
  - "User-supplied text is interpolated into an email subject, a push title, or a sender line"
  - "A helper sanitizes a display name and the result is described as safe"
  - "Choosing between filtering a value and moving it to a different field"
  - "Reviewing a fan-out whose actor holds only a read-level permission"
tags: [notifications, email, phishing, impersonation, sanitization, trust-boundaries, adversarial-review]
related_components: [notification-service, notification-delivery, cli-connection-nudge]
audience: engineers putting user-controlled text into an outbound message
owner: platform team
---

# Stripping characters cannot make a name trustworthy

## Context

Fizzy #2457 added a fan-out that lets one person ask up to fifty teammates to
connect a coding tool. Its notification title interpolated the asker's display
name:

```ts
const title = `${actorName} asked you to connect a coding tool to Fabric`;
```

An in-house security review found the obvious half of that and it was fixed
properly. `clampActorName` bounded the name to 48 characters, stripped C0/C1
controls (CR and LF above all, since the title becomes an email subject and a
subject is a header), stripped zero-width and bidi-formatting characters, and
collapsed whitespace runs. It was documented in about twenty lines explaining
each class of character and what it could do to a subject line. It had five
tests. A separate fix required the actor to hold organization membership, so a
project guest could no longer originate one of these at all.

An independent adversarial gate then asked a question none of that answered:

> Organization membership does not make the interpolated display name
> trustworthy. Every member can update their own name. A member can rename
> themselves to a trusted internal function and make Fabric send up to 50
> subjects that appear to originate from that function.

No control character is involved. No bidi trick. `Fabric Security` passes every
filter in `clampActorName` unchanged, because it is an entirely ordinary string.
The clamp was solving a real problem and a different one.

## The distinction

There are two separate things that can go wrong when user text reaches an
outbound message, and they take opposite fixes.

**The text can break out of its slot.** A newline in a header, a bidi override
that reorders the clause after it, a run of spaces that pushes the honest half
of the sentence past what a mail client renders. This is a *character* problem
and filtering is the correct answer. `clampActorName` does this correctly.

**The text can be read as an identity rather than as content.** An email subject
is read in an inbox list, outside anything that says who sent it. A string there
does not read as "something a colleague typed"; it reads as *who this is from*.
This is a *position* problem, and no filter can fix it, because the attacker's
payload is a legal value of the field. The only fix is to take the user's text
out of that position.

The first problem makes the clamp look like a complete defence. It is the more
technical of the two, it has a satisfying list of Unicode ranges, and once it is
written it is easy to believe the field is handled.

## Guidance

**Before filtering user text, ask whether the field is read as content or as
identity. Filter content. Relocate identity.**

The repair here moved the whole subject line off user input:

```ts
// Static, server-authored, no interpolation at all.
const CLI_CONNECTION_REQUESTED_TITLE =
    "A teammate asked you to connect a coding tool to Fabric";

// The name is not dropped, it is relocated — to the snippet, which the
// recipient reads in the app, or in a mail body that has already said
// where it came from.
snippet: `${clampActorName(args.actorName)} asked about ${projectName}. ...`
```

Attribution survives everywhere it was useful: the in-app notification row shows
title and snippet together, and the email body renders both, HTML-escaped. What
is gone is the one surface where the name was doing work it was never entitled
to do.

Three rules:

1. **Identify the identity-shaped fields on the path.** Subject lines, push
   notification titles, sender names, SMS previews, anything rendered before the
   reader has confirmed the source. On this path, `subject: notification.title`
   in the delivery activity is what made `title` identity-shaped — a fact three
   files away from where the title was written.
2. **Prefer a static string over a well-filtered one.** A subject with no
   variables cannot be attacked. Losing "who" from the inbox preview is a real
   but small cost; the reader opens the message and finds out.
3. **Keep the filter anyway.** The clamp still runs on the relocated name. The
   snippet is one line, a newline still splits it, and stripping at the point of
   assembly rather than the point of rendering is what keeps the guarantee if
   the string is later reused somewhere stricter.

## Why This Matters

The permission fix and the character fix were both real, both correct, and
together they created a strong impression that the field had been dealt with.
The comment above `clampActorName` was long, specific, and true. Its
thoroughness is precisely what made the remaining gap hard to see: a reader
arriving at twenty lines of Unicode reasoning concludes the author thought hard
about this field, and stops asking whether they thought about the right thing.

This is the same failure mode as
[a comment that overclaims a guarantee](../conventions/a-comment-that-overclaims-a-guarantee-disables-vigilance.md),
arriving through a different door. There the explanation named the wrong
mechanism; here the *defence* addressed the wrong axis, and the explanation
described it accurately. An accurate description of an incomplete defence reads
exactly like an accurate description of a complete one.

It also matters which fan-out this was. The same file has roughly fifteen older
helpers that interpolate a raw display name into a title, and they are a
pre-existing class this change did not introduce. What singled this one out is
its reach: the actor needs only a read-level permission, and picks fifty
recipients by hand. **Amplification plus a low permission bar is what turns a
shared shape into the instance worth fixing first.**

## When to Apply

- **Any `subject:`, push title, or sender field built with a template literal.**
  If a variable appears there, ask who controls it and what they could name
  themselves.
- **When a sanitizer's tests are all hostile inputs.** Five tests full of
  `\r\n`, `‮` and 500-character names prove the filter works and prove
  nothing about the ordinary string that does the damage. Add the boring case:
  a plausible, entirely legal name that should not be believed.
- **When a permission fix lands on a messaging surface.** Requiring membership
  bounds *who* can send. It says nothing about what they may claim to be.
- **When the fan-out is hand-addressed.** A notification anchored to an object
  the recipient already has access to is self-limiting. One where the sender
  types a recipient list is not.
