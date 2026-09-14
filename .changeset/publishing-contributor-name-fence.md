---
"fabric-app": patch
---

Stop sending display names of people who no longer have project access to the AI provider during publishing generation

`resolveContributorNames` (packages/temporal) resolved a topic's contributor
display names with an unscoped `db.user.findMany` over whatever ids
`effectiveContributorUserIds` yielded. Neither source of those ids prunes
itself when somebody leaves: the resolver derives them from the project's own
stories, documents and PR authors, so the next resolve puts a departed author
straight back, and the user override is checked only at write time. The result
was that offboarding revoked a person's access while their name kept leaving
the database on every subsequent generation for a topic they had once
contributed to — across all eight generators, since they share this helper.

The helper now takes `projectId` and filters to the people who still have
access before it reads a single user row. The predicate mirrors
`resolveProjectAccess`, which is the same ladder the suite's own runtime
re-check already asks through `checkPublishingGenerationActor`: the owner of a
personal project (who may hold no membership row at all), an accepted and
unexpired `ProjectMember` row, and otherwise membership of the project's host
organization. All three rungs, because the failure mode of getting this wrong
is asymmetric — a stale name is present and wrong, whereas a real author
dropped from the credits is invisible. A fence written as a bare
`ProjectMember` lookup passes every "the former member is gone" case and
silently deletes project owners and org-role colleagues from attribution
everywhere; that was written first and watched failing, and each rung now has
its own over-fence guard in `contributor-names.test.ts`.

At most three queries for a personal project and four for an organization one,
whatever the contributor count — never a per-user access check in a loop. The
empty-list short circuit still issues no query at all.

Two consequences worth stating. A contributor with no current project access is
now absent from the prompt rather than named in it, including an id the 1A
resolver reached through a linked GitHub account without the person ever being
a project member. And the write-time check in `updateTopicContributors` is
still security-critical — its comment cited this helper's unscoped read, but
the read that argument actually rests on is the display-side lookup in
`listPublishingTopics`, which is unchanged and still resolves names for stale
contributor ids. Both comments were re-pointed rather than left to rot.
