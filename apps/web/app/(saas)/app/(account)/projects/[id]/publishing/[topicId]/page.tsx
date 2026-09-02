/**
 * Topic Item Page (personal / account context) — Fizzy #1851, Phase 2A-1.
 *
 * Refuses unconditionally. Per ADR-018 ("An organization is the only tenant
 * context", `docs/adr/018-organization-is-the-only-tenant-context.md`),
 * Publishing Suite — a feature introduced after that ADR — must not route
 * into the personal arm, and code that finds itself there is a bug in
 * whatever failed to resolve an organization. This route only ever resolves
 * a project fetched with `organizationId: null` (it is the personal route
 * tree), so any project it would serve is, by construction, one with no
 * organization — exactly the tenant the API's own
 * `assertPublishingSuiteFeatureEnabled` (see
 * `packages/api/modules/projects/lib/publishing-suite-feature.ts`) refuses
 * outright, NOT_FOUND, without even consulting the flag. This page mirrors
 * that refusal at the route level rather than fetching a project and flag
 * state it could never legitimately use — there is no organization-scoped
 * answer to fall through to.
 *
 * The route file itself is NOT removed here: it was added on master while
 * this branch was in flight, and master owns it. Only its behavior changes,
 * from gating on the deleted env-only reader (`isPublishingSuiteEnabled`) to
 * refusing outright, consistent with the API gate.
 */

import { notFound } from "next/navigation";

type Props = {
	params: Promise<{ id: string; topicId: string }>;
};

export default async function PersonalPublishingTopicPage(_props: Props) {
	notFound();
}
