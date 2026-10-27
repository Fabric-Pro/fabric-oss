import { db, Prisma } from "../client";
import type { UsageRange } from "./project-ai-usage";

/** The caller resolves this scope from the authorized project row. SQL also
 * verifies the project/org pair because the export's owner can bypass RLS. */
type DecisionReplayScope = { organizationId: string; projectId: string };
export interface DecisionReplayPeriod {
	changeOutcomes: {
		applied: number;
		alreadyOnRoadmap: number;
		notSelected: number;
		failed: number;
		inProgress: number;
		rejected: number;
		superseded: number;
		pending: number;
	};
	changeAcceptance: {
		accepted: number;
		decided: number;
		rate: number | null;
	};
	partlyApplied: number;
	acceptance: { accepted: number; decided: number; rate: number | null };
	medianReviewSeconds: number | null;
	keptAsApplied: { kept: number; mature: number; rate: number | null };
	outcomes: {
		applied: number;
		rejected: number;
		pending: number;
		other: number;
	};
}
export interface DecisionReplaySummary {
	changeCoverageStartedAt: Date | null;
	waiting: number;
	oldestWaitingAt: Date | null;
	current: DecisionReplayPeriod;
	previous: DecisionReplayPeriod | null;
}
export interface DecisionReplayReviewItem {
	id: string;
	summary: string;
	source: string;
	changeCount: number;
	createdAt: Date;
}
export interface DecisionReplayTimelineEvent {
	occurredAt: Date;
	eventType: string;
	fromState: string | null;
	toState: string | null;
	actorKind: string;
	actorName: string | null;
	subjectType: string;
	changeIndex: number | null;
	action: string | null;
	createdEntityType: string | null;
	offeredCount: number | null;
	selectedCount: number | null;
	offeredListComplete: boolean | null;
	notSelectedTitles: string[];
}

/** Each raw read starts with a validated project/org pair and both export
 * predicates. Do not substitute the request's active organization here. */
function scopedCtes({
	organizationId,
	projectId,
}: DecisionReplayScope): Prisma.Sql {
	return Prisma.sql`
  project_scope AS (
   SELECT id FROM project WHERE id = ${projectId} AND "organizationId" = ${organizationId}
  ), events AS (
   SELECT e.organization_id, e.project_id, e.id, e.occurred_at, e.subject_type, e.subject_id, e.event_type,
    e.from_state, e.to_state, e.actor_kind, e.actor_id, e.related_subject_id, e.payload
   FROM lakehouse_export.decision_event e JOIN project_scope p ON p.id = e.project_id
   WHERE e.organization_id = ${organizationId} AND e.project_id = ${projectId}
  ), proposals AS (
   SELECT b.id, b.summary, b.source, b."changeCount", b."createdAt", b.status
   FROM pending_backlog_proposal b JOIN project_scope p ON p.id = b."projectId"
   WHERE b."projectId" = ${projectId}
    AND (b."organizationId" = ${organizationId} OR b."organizationId" IS NULL)
  )`;
}

type PeriodRow = {
	change_outcomes: DecisionReplayPeriod["changeOutcomes"];
	partly_applied: number;
	coverage_at: Date | null;
	period: number;
	accepted: number;
	decided: number;
	median: number | null;
	kept: number;
	mature: number;
	applied: number;
	rejected: number;
	pending: number;
	other: number;
	waiting: number;
	oldest: Date | null;
};
function toPeriod(row: PeriodRow): DecisionReplayPeriod {
	const accepted =
		row.change_outcomes.applied +
		row.change_outcomes.failed +
		row.change_outcomes.inProgress;
	const decided =
		accepted +
		row.change_outcomes.notSelected +
		row.change_outcomes.rejected;
	return {
		changeOutcomes: row.change_outcomes,
		changeAcceptance: {
			accepted,
			decided,
			rate: decided ? accepted / decided : null,
		},
		partlyApplied: row.partly_applied,
		acceptance: {
			accepted: row.accepted,
			decided: row.decided,
			rate: row.decided ? row.accepted / row.decided : null,
		},
		medianReviewSeconds: row.median,
		keptAsApplied: {
			kept: row.kept,
			mature: row.mature,
			rate: row.mature ? row.kept / row.mature : null,
		},
		outcomes: {
			applied: row.applied,
			rejected: row.rejected,
			pending: row.pending,
			other: row.other,
		},
	};
}

/** Rolling UTC periods [start,end), with an equal preceding period. `all`
 * has no preceding period. Waiting is live, independent of the range.
 * Acceptance uses the latest qualifying accepted/rejected event per period;
 * review latency uses the first human transition and excludes sidebar applies.
 * Kept cohorts use first APPLIED and the inclusive seven-day edit window. */
export async function getDecisionReplaySummary(
	input: DecisionReplayScope & { range: UsageRange },
): Promise<DecisionReplaySummary> {
	const now = new Date();
	const duration =
		(input.range === "7d" ? 7 : input.range === "90d" ? 90 : 30) *
		86400_000;
	const start =
		input.range === "all" ? null : new Date(now.getTime() - duration);
	const previousStart = start ? new Date(start.getTime() - duration) : null;
	const rows = await db.$queryRaw<PeriodRow[]>(Prisma.sql`
  WITH ${scopedCtes(input)}, periods AS (
   SELECT 0 AS period, ${start?.toISOString() ?? null}::timestamptz AS since, ${now.toISOString()}::timestamptz AS until
   UNION ALL SELECT 1, ${previousStart?.toISOString() ?? null}::timestamptz, ${start?.toISOString() ?? null}::timestamptz WHERE ${start?.toISOString() ?? null}::timestamptz IS NOT NULL
  ),
  change_events AS (
 SELECT p.period, e.*,
  CASE WHEN subject_type = 'backlog_proposal' THEN subject_id ELSE related_subject_id END AS proposal_id,
  payload->>'source' AS source,
  CAST(payload->>'changeCount' AS BIGINT) AS change_count,
  CAST(payload->>'offeredListComplete' AS BOOLEAN) AS complete, payload->>'reviewId' AS review_id,
  CAST(payload->>'offeredIndex' AS INT) AS offered_index, CAST(payload->>'changeIndex' AS INT) AS stored_index, CAST(payload->>'selected' AS BOOLEAN) AS selected
 FROM events e CROSS JOIN periods p WHERE e.occurred_at < p.until
), coverage AS (
 SELECT period, organization_id, project_id, MIN(occurred_at) AS coverage_at FROM change_events
 WHERE event_type = 'proposal_reviewed' GROUP BY period, organization_id, project_id
), change_status_ranked AS (
 SELECT *, ROW_NUMBER() OVER (PARTITION BY period, organization_id, project_id, proposal_id ORDER BY occurred_at DESC, id DESC) AS rn
 FROM change_events WHERE subject_type = 'backlog_proposal' AND subject_id IS NOT NULL AND event_type IN ('proposed','status_changed')
), change_status AS (SELECT * FROM change_status_ranked WHERE rn = 1),
change_reviews_ranked AS (
 SELECT *, ROW_NUMBER() OVER (PARTITION BY period, organization_id, project_id, proposal_id ORDER BY occurred_at DESC, id DESC) AS rn
 FROM change_events WHERE event_type = 'proposal_reviewed' AND subject_id IS NOT NULL AND proposal_id IS NOT NULL
), change_reviews AS (SELECT * FROM change_reviews_ranked WHERE rn = 1),
change_entries_ranked AS (
 SELECT e.*, r.occurred_at AS review_at, r.id AS review_event_id,
  MAX(CASE WHEN e.selected = true THEN 1 ELSE 0 END) OVER (PARTITION BY e.period, e.organization_id, e.project_id, e.proposal_id, e.offered_index) AS ever_selected,
  MAX(CASE WHEN e.selected = true THEN r.occurred_at END) OVER (PARTITION BY e.period, e.organization_id, e.project_id, e.proposal_id, e.offered_index) AS selected_at,
  ROW_NUMBER() OVER (PARTITION BY e.period, e.organization_id, e.project_id, e.proposal_id, e.offered_index ORDER BY r.occurred_at DESC, r.id DESC, e.id DESC) AS entry_rn
 FROM change_events e JOIN change_reviews_ranked r ON e.period=r.period AND e.organization_id=r.organization_id AND e.project_id=r.project_id AND r.proposal_id=e.proposal_id AND r.subject_id=e.review_id
 WHERE e.event_type='change_reviewed' AND e.offered_index IS NOT NULL
), change_entries AS (
 SELECT e.period, e.organization_id, e.project_id, e.proposal_id, e.offered_index, e.stored_index,
  CASE WHEN e.review_event_id = r.id THEN e.selected ELSE false END AS selected,
  e.ever_selected, e.selected_at
 FROM change_entries_ranked e JOIN change_reviews r ON e.period=r.period AND e.organization_id=r.organization_id AND e.project_id=r.project_id AND r.proposal_id=e.proposal_id
 WHERE e.entry_rn=1 AND r.complete=true
 UNION ALL
 SELECT s.period, s.organization_id, s.project_id, s.proposal_id, idx AS offered_index, idx AS stored_index, false AS selected, 0 AS ever_selected, NULL AS selected_at
 FROM change_status s LEFT JOIN change_reviews r ON s.period=r.period AND s.organization_id=r.organization_id AND s.project_id=r.project_id AND r.proposal_id=s.proposal_id
 CROSS JOIN LATERAL generate_series(0,s.change_count-1) AS expanded(idx)
 WHERE r.id IS NULL AND s.to_state IN ('REJECTED','BACKLOG') AND s.change_count > 0
), change_resolutions AS (
 SELECT period, organization_id, project_id, proposal_id, stored_index,
  MIN(CASE WHEN event_type='change_applied' THEN occurred_at END) AS applied_at,
  MIN(CASE WHEN event_type='change_deduplicated' THEN occurred_at END) AS deduplicated_at
 FROM change_events WHERE event_type IN ('change_applied','change_deduplicated') AND stored_index IS NOT NULL
 GROUP BY period, organization_id, project_id, proposal_id, stored_index
), classified_changes AS (
 SELECT e.period, e.organization_id, e.project_id, e.proposal_id, e.offered_index, e.stored_index,
  COALESCE(r.source,s.source) AS source,
  CASE
   WHEN a.applied_at IS NOT NULL THEN 'applied'
   WHEN a.deduplicated_at IS NOT NULL THEN 'alreadyOnRoadmap'
   WHEN (COALESCE(r.source,s.source) <> 'ROADMAP_RECOMMENDATION' AND e.selected=false AND r.id IS NOT NULL)
    OR (COALESCE(r.source,s.source)='ROADMAP_RECOMMENDATION' AND r.id IS NOT NULL AND e.ever_selected=0 AND s.to_state IN ('APPLIED','REJECTED','BACKLOG')) THEN 'notSelected'
   WHEN e.selected=true AND s.to_state='FAILED' THEN 'failed'
   WHEN e.selected=true AND s.to_state IN ('APPROVED','APPLYING') THEN 'inProgress'
   WHEN s.to_state IN ('REJECTED','BACKLOG') THEN 'rejected'
   WHEN s.to_state='SUPERSEDED' THEN 'superseded'
   ELSE 'pending' END AS outcome,
  COALESCE(e.selected_at,r.occurred_at,a.applied_at,a.deduplicated_at) AS selected_at,
  r.occurred_at AS review_at, s.occurred_at AS status_at,
  c.coverage_at
 FROM change_entries e JOIN change_status s ON e.period=s.period AND e.organization_id=s.organization_id AND e.project_id=s.project_id AND s.proposal_id=e.proposal_id
 JOIN coverage c ON e.period=c.period AND e.organization_id=c.organization_id AND e.project_id=c.project_id
 LEFT JOIN change_reviews r ON e.period=r.period AND e.organization_id=r.organization_id AND e.project_id=r.project_id AND r.proposal_id=e.proposal_id
 LEFT JOIN change_resolutions a ON e.period=a.period AND e.organization_id=a.organization_id AND e.project_id=a.project_id AND a.proposal_id=e.proposal_id AND a.stored_index=e.stored_index
), change_outcomes AS (
 SELECT period, organization_id, project_id, proposal_id, offered_index, stored_index, outcome, decided_at, source
 FROM (
  SELECT classified_changes.*,
   CASE WHEN outcome IN ('rejected','superseded') OR (outcome='notSelected' AND source='ROADMAP_RECOMMENDATION') THEN status_at
    WHEN outcome IN ('applied','alreadyOnRoadmap') THEN selected_at
    ELSE review_at END AS decided_at
  FROM classified_changes
 ) timed_changes WHERE decided_at >= coverage_at
), proposal_times AS (
   SELECT subject_id,
    MIN(occurred_at) FILTER (WHERE event_type = 'proposed') AS proposed_at,
    MIN(occurred_at) FILTER (WHERE event_type = 'status_changed' AND actor_kind = 'human') AS reviewed_at,
    MIN(occurred_at) FILTER (WHERE event_type = 'status_changed' AND to_state = 'APPLIED') AS applied_at,
    BOOL_OR(payload->>'source' = 'AI_UPDATE_SIDEBAR') AS sidebar
   FROM events WHERE subject_type = 'backlog_proposal' AND subject_id IS NOT NULL
    AND occurred_at < ${now.toISOString()}::timestamptz AND event_type IN ('proposed','status_changed')
   GROUP BY subject_id
  ), decisions AS (
   SELECT DISTINCT ON (p.period,e.subject_id) p.period,e.subject_id,
    (e.actor_kind = 'human' AND e.to_state IN ('APPROVED','APPLYING','APPLIED')) AS accepted
   FROM periods p JOIN events e ON (p.since IS NULL OR e.occurred_at >= p.since) AND e.occurred_at < p.until
   WHERE e.subject_type = 'backlog_proposal' AND e.subject_id IS NOT NULL AND e.event_type = 'status_changed'
    AND ((e.actor_kind = 'human' AND e.to_state IN ('APPROVED','APPLYING','APPLIED')) OR e.to_state IN ('REJECTED','BACKLOG'))
   ORDER BY p.period,e.subject_id,e.occurred_at DESC,e.id DESC
  ), mature AS (
   SELECT p.period,t.subject_id, NOT EXISTS (
    SELECT 1 FROM events e WHERE e.subject_type = 'story' AND e.event_type = 'story_edited'
     AND e.related_subject_id = t.subject_id AND e.occurred_at >= t.applied_at
     AND e.occurred_at <= t.applied_at + interval '168 hours'
   ) AS kept
   FROM periods p JOIN proposal_times t ON (p.since IS NULL OR t.applied_at >= p.since) AND t.applied_at < p.until
   WHERE t.applied_at <= ${new Date(now.getTime() - 7 * 86400_000).toISOString()}::timestamptz
  )
   -- Canonical rules: deployment/databricks/decision-replay/README.md#change-level-outcome-rules
  SELECT p.period,
   (SELECT MIN(coverage_at) FROM coverage WHERE period=p.period) AS coverage_at,
   (SELECT jsonb_build_object('applied',COUNT(*) FILTER (WHERE outcome='applied')::int,
'alreadyOnRoadmap',COUNT(*) FILTER (WHERE outcome='alreadyOnRoadmap')::int,
'notSelected',COUNT(*) FILTER (WHERE outcome='notSelected')::int,
'failed',COUNT(*) FILTER (WHERE outcome='failed')::int,
'inProgress',COUNT(*) FILTER (WHERE outcome='inProgress')::int,
'rejected',COUNT(*) FILTER (WHERE outcome='rejected')::int,
'superseded',COUNT(*) FILTER (WHERE outcome='superseded')::int,
'pending',COUNT(*) FILTER (WHERE outcome='pending')::int) FROM change_outcomes co WHERE co.period=p.period AND (p.since IS NULL OR co.decided_at >= p.since) AND co.decided_at < p.until) AS change_outcomes,
   (SELECT COUNT(*)::int FROM proposals live
    JOIN change_status s ON s.proposal_id=live.id AND s.period=p.period
    WHERE s.to_state='APPLIED' AND EXISTS (
     SELECT 1 FROM change_outcomes co WHERE co.period=p.period AND co.proposal_id=live.id AND co.outcome='notSelected'
    ) AND (p.since IS NULL OR live."createdAt" AT TIME ZONE 'UTC' >= p.since)
     AND live."createdAt" AT TIME ZONE 'UTC' < p.until) AS partly_applied,
   (SELECT COUNT(*)::int FROM decisions d WHERE d.period=p.period AND d.accepted) AS accepted,
   (SELECT COUNT(*)::int FROM decisions d WHERE d.period=p.period) AS decided,
   (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t.reviewed_at-t.proposed_at)))
    FROM proposal_times t WHERE (p.since IS NULL OR t.reviewed_at >= p.since) AND t.reviewed_at < p.until
     AND t.proposed_at IS NOT NULL AND t.reviewed_at >= t.proposed_at AND NOT COALESCE(t.sidebar,false)) AS median,
   (SELECT COUNT(*)::int FROM mature m WHERE m.period=p.period AND m.kept) AS kept,
   (SELECT COUNT(*)::int FROM mature m WHERE m.period=p.period) AS mature,
   COUNT(b.id) FILTER (WHERE b.status = 'APPLIED')::int AS applied,
   COUNT(b.id) FILTER (WHERE b.status IN ('REJECTED','BACKLOG'))::int AS rejected,
   COUNT(b.id) FILTER (WHERE b.status = 'PENDING')::int AS pending,
   COUNT(b.id) FILTER (WHERE b.status IN ('FAILED','SUPERSEDED','APPLYING','APPROVED'))::int AS other,
   (SELECT COUNT(*)::int FROM proposals WHERE status='PENDING') AS waiting,
   (SELECT MIN("createdAt") FROM proposals WHERE status='PENDING') AS oldest
  FROM periods p LEFT JOIN proposals b ON (p.since IS NULL OR b."createdAt" AT TIME ZONE 'UTC' >= p.since) AND b."createdAt" AT TIME ZONE 'UTC' < p.until
  GROUP BY p.period,p.since,p.until ORDER BY p.period
 `);
	return {
		changeCoverageStartedAt: rows[0].coverage_at,
		waiting: rows[0].waiting,
		oldestWaitingAt: rows[0].oldest,
		current: toPeriod(rows[0]),
		previous: rows[1] ? toPeriod(rows[1]) : null,
	};
}

export async function listDecisionReplayNeedsReview(
	input: DecisionReplayScope & { limit?: number },
): Promise<{ items: DecisionReplayReviewItem[]; total: number }> {
	const limit = Math.min(Math.max(Math.trunc(input.limit ?? 5), 1), 100);
	const [result] = await db.$queryRaw<
		{
			total: number;
			items: Array<
				Omit<DecisionReplayReviewItem, "createdAt"> & {
					createdAt: string;
				}
			>;
		}[]
	>(Prisma.sql`
  WITH ${scopedCtes(input)}, waiting AS (
   SELECT id,summary,source,"changeCount","createdAt" FROM proposals WHERE status='PENDING'
  ), limited AS (SELECT id,summary,source,"changeCount","createdAt" AT TIME ZONE 'UTC' AS "createdAt" FROM waiting ORDER BY "createdAt",id LIMIT ${limit})
  SELECT (SELECT COUNT(*)::int FROM waiting) AS total,
   COALESCE((SELECT jsonb_agg(to_jsonb(limited) ORDER BY "createdAt",id) FROM limited),'[]'::jsonb) AS items
 `);
	return {
		total: result.total,
		items: result.items.map((item) => ({
			...item,
			createdAt: new Date(item.createdAt),
		})),
	};
}

/** Actor ids and raw payloads stay in SQL; names require current org membership. */
export async function getDecisionReplayProposalTimeline(
	input: DecisionReplayScope & { proposalId: string },
): Promise<{ events: DecisionReplayTimelineEvent[]; truncated: boolean }> {
	const events = await db.$queryRaw<DecisionReplayTimelineEvent[]>(Prisma.sql`
  WITH ${scopedCtes(input)}, timeline AS (
   SELECT * FROM events e
   WHERE e.event_type <> 'change_reviewed'
    AND ((e.subject_type='backlog_proposal' AND e.subject_id=${input.proposalId}) OR e.related_subject_id=${input.proposalId})
   ORDER BY e.occurred_at DESC,e.id DESC LIMIT 201
  )
  SELECT e.occurred_at AS "occurredAt",e.event_type AS "eventType",e.from_state AS "fromState",e.to_state AS "toState",
   e.actor_kind AS "actorKind",u.name AS "actorName",e.subject_type AS "subjectType",
   (e.payload->>'changeIndex')::int AS "changeIndex",e.payload->>'action' AS action,e.payload->>'createdEntityType' AS "createdEntityType",
   (e.payload->>'offeredCount')::int AS "offeredCount",(e.payload->>'selectedCount')::int AS "selectedCount",
   (e.payload->>'offeredListComplete')::boolean AS "offeredListComplete",
   COALESCE(titles.items, '[]'::jsonb) AS "notSelectedTitles"
  FROM timeline e LEFT JOIN member m ON m."userId"=e.actor_id AND m."organizationId"=${input.organizationId}
  LEFT JOIN "user" u ON u.id=m."userId"
  LEFT JOIN LATERAL (
   SELECT jsonb_agg(title ORDER BY "offeredIndex") AS items FROM (
    SELECT content.title, entry."offeredIndex"
    FROM public.pending_backlog_proposal_review_entry entry
    JOIN public.pending_backlog_proposal_review review ON review.id=entry."reviewId" AND review."proposalId"=entry."proposalId"
    JOIN proposals b ON b.id=review."proposalId"
    JOIN public.pending_backlog_proposal stored ON stored.id=b.id
    CROSS JOIN LATERAL (
     SELECT COALESCE(
      CASE WHEN jsonb_typeof(entry.change #> '{title,to}')='string' THEN entry.change #>> '{title,to}' END,
      CASE WHEN jsonb_typeof(entry.change->'title')='string' THEN entry.change->>'title' END,
      CASE WHEN jsonb_typeof(stored.proposal->'changes'->entry."changeIndex" #> '{title,to}')='string'
       THEN stored.proposal->'changes'->entry."changeIndex" #>> '{title,to}' END
     ) AS title
    ) content
    WHERE e.event_type='proposal_reviewed' AND review.id=e.subject_id
     AND b.id=${input.proposalId} AND entry.selected=false
     AND content.title IS NOT NULL
    ORDER BY entry."offeredIndex" LIMIT 20
   ) omitted
  ) titles ON true
  ORDER BY e.occurred_at DESC,e.id DESC
 `);
	return {
		events: events.slice(0, 200).reverse(),
		truncated: events.length > 200,
	};
}
