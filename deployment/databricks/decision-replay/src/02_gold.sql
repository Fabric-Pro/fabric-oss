-- Databricks notebook source
USE CATALOG IDENTIFIER(:catalog);

-- COMMAND ----------
USE SCHEMA IDENTIFIER(:schema);

-- COMMAND ----------
SET TIME ZONE 'UTC';

-- COMMAND ----------
-- Outcome rules: ../README.md#change-level-outcome-rules
CREATE OR REPLACE TABLE change_outcomes USING DELTA AS
WITH change_events AS (
 SELECT  e.*,
  CASE WHEN subject_type = 'backlog_proposal' THEN subject_id ELSE related_subject_id END AS proposal_id,
  get_json_object(payload, '$.source') AS source,
  TRY_CAST(get_json_object(payload, '$.changeCount') AS BIGINT) AS change_count,
  TRY_CAST(get_json_object(payload, '$.offeredListComplete') AS BOOLEAN) AS complete, get_json_object(payload, '$.reviewId') AS review_id,
  TRY_CAST(get_json_object(payload, '$.offeredIndex') AS INT) AS offered_index, TRY_CAST(get_json_object(payload, '$.changeIndex') AS INT) AS stored_index, TRY_CAST(get_json_object(payload, '$.selected') AS BOOLEAN) AS selected
 FROM decision_event_current e WHERE e.occurred_at < current_timestamp()
), coverage AS (
 SELECT organization_id, project_id, MIN(occurred_at) AS coverage_at FROM change_events
 WHERE event_type = 'proposal_reviewed' GROUP BY organization_id, project_id
), change_status_ranked AS (
 SELECT *, ROW_NUMBER() OVER (PARTITION BY organization_id, project_id, proposal_id ORDER BY occurred_at DESC, id DESC) AS rn
 FROM change_events WHERE subject_type = 'backlog_proposal' AND subject_id IS NOT NULL AND event_type IN ('proposed','status_changed')
), change_status AS (SELECT * FROM change_status_ranked WHERE rn = 1),
change_reviews_ranked AS (
 SELECT *, ROW_NUMBER() OVER (PARTITION BY organization_id, project_id, proposal_id ORDER BY occurred_at DESC, id DESC) AS rn
 FROM change_events WHERE event_type = 'proposal_reviewed' AND subject_id IS NOT NULL AND proposal_id IS NOT NULL
), change_reviews AS (SELECT * FROM change_reviews_ranked WHERE rn = 1),
change_entries_ranked AS (
 SELECT e.*, r.occurred_at AS review_at, r.id AS review_event_id,
  MAX(CASE WHEN e.selected = true THEN 1 ELSE 0 END) OVER (PARTITION BY e.organization_id, e.project_id, e.proposal_id, e.offered_index) AS ever_selected,
  MAX(CASE WHEN e.selected = true THEN r.occurred_at END) OVER (PARTITION BY e.organization_id, e.project_id, e.proposal_id, e.offered_index) AS selected_at,
  ROW_NUMBER() OVER (PARTITION BY e.organization_id, e.project_id, e.proposal_id, e.offered_index ORDER BY r.occurred_at DESC, r.id DESC, e.id DESC) AS entry_rn
 FROM change_events e JOIN change_reviews_ranked r ON e.organization_id=r.organization_id AND e.project_id=r.project_id AND r.proposal_id=e.proposal_id AND r.subject_id=e.review_id
 WHERE e.event_type='change_reviewed' AND e.offered_index IS NOT NULL
), change_entries AS (
 SELECT e.organization_id, e.project_id, e.proposal_id, e.offered_index, e.stored_index,
  CASE WHEN e.review_event_id = r.id THEN e.selected ELSE false END AS selected,
  e.ever_selected, e.selected_at
 FROM change_entries_ranked e JOIN change_reviews r ON e.organization_id=r.organization_id AND e.project_id=r.project_id AND r.proposal_id=e.proposal_id
 WHERE e.entry_rn=1 AND r.complete=true
 UNION ALL
 SELECT s.organization_id, s.project_id, s.proposal_id, idx AS offered_index, idx AS stored_index, false AS selected, 0 AS ever_selected, NULL AS selected_at
 FROM change_status s LEFT JOIN change_reviews r ON s.organization_id=r.organization_id AND s.project_id=r.project_id AND r.proposal_id=s.proposal_id
 LATERAL VIEW explode(sequence(0, CAST(s.change_count-1 AS INT))) expanded AS idx
 WHERE r.id IS NULL AND s.to_state IN ('REJECTED','BACKLOG') AND s.change_count > 0
), change_resolutions AS (
 SELECT organization_id, project_id, proposal_id, stored_index,
  MIN(CASE WHEN event_type='change_applied' THEN occurred_at END) AS applied_at,
  MIN(CASE WHEN event_type='change_deduplicated' THEN occurred_at END) AS deduplicated_at
 FROM change_events WHERE event_type IN ('change_applied','change_deduplicated') AND stored_index IS NOT NULL
 GROUP BY organization_id, project_id, proposal_id, stored_index
), classified_changes AS (
 SELECT e.organization_id, e.project_id, e.proposal_id, e.offered_index, e.stored_index,
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
 FROM change_entries e JOIN change_status s ON e.organization_id=s.organization_id AND e.project_id=s.project_id AND s.proposal_id=e.proposal_id
 JOIN coverage c ON e.organization_id=c.organization_id AND e.project_id=c.project_id
 LEFT JOIN change_reviews r ON e.organization_id=r.organization_id AND e.project_id=r.project_id AND r.proposal_id=e.proposal_id
 LEFT JOIN change_resolutions a ON e.organization_id=a.organization_id AND e.project_id=a.project_id AND a.proposal_id=e.proposal_id AND a.stored_index=e.stored_index
), change_outcomes AS (
 SELECT organization_id, project_id, proposal_id, offered_index, stored_index, outcome, decided_at, source
 FROM (
  SELECT classified_changes.*,
   CASE WHEN outcome IN ('rejected','superseded') OR (outcome='notSelected' AND source='ROADMAP_RECOMMENDATION') THEN status_at
    WHEN outcome IN ('applied','alreadyOnRoadmap') THEN selected_at
    ELSE review_at END AS decided_at
  FROM classified_changes
 ) timed_changes WHERE decided_at >= coverage_at
)
SELECT * FROM change_outcomes;

-- COMMAND ----------
CREATE OR REPLACE TABLE suggestion_journey USING DELTA AS
WITH outcome_totals AS (
 SELECT organization_id,project_id,proposal_id,COUNT(*) AS offered,
  SUM(CASE WHEN outcome IN ('applied','alreadyOnRoadmap','failed','inProgress') THEN 1 ELSE 0 END) AS selected,
  SUM(CASE WHEN outcome='notSelected' THEN 1 ELSE 0 END) AS not_selected
 FROM change_outcomes GROUP BY organization_id,project_id,proposal_id
), proposal_events AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY organization_id, project_id, subject_id ORDER BY occurred_at DESC, id DESC
  ) AS status_rank
  FROM decision_event_current
  WHERE subject_type = 'backlog_proposal' AND subject_id IS NOT NULL
    AND project_id IS NOT NULL AND event_type IN ('proposed', 'status_changed')
), proposals AS (
  SELECT organization_id, project_id, subject_id AS proposal_id,
    MIN(CASE WHEN event_type = 'proposed' THEN occurred_at END) AS proposed_at,
    MIN(CASE WHEN event_type = 'status_changed' AND actor_kind = 'human' THEN occurred_at END) AS first_human_review_at,
    MAX(CASE WHEN status_rank = 1 THEN to_state END) AS final_status,
    MIN(CASE WHEN to_state = 'APPLIED' THEN occurred_at END) AS applied_at,
    MAX(CASE WHEN status_rank = 1 THEN TRY_CAST(get_json_object(payload, '$.changeCount') AS BIGINT) END) AS change_count
  FROM proposal_events
  GROUP BY organization_id, project_id, subject_id
), applications AS (
  SELECT organization_id, project_id, related_subject_id AS proposal_id,
    COUNT(DISTINCT get_json_object(payload, '$.changeIndex')) AS changes_applied_count,
    COUNT(DISTINCT CASE WHEN get_json_object(payload, '$.action') = 'create'
      THEN get_json_object(payload, '$.createdEntityId') END) AS created_entity_count
  FROM decision_event_current
  WHERE event_type = 'change_applied' AND subject_type = 'backlog_proposal_application'
  GROUP BY organization_id, project_id, related_subject_id
), created_stories AS (
  SELECT organization_id, project_id, related_subject_id AS proposal_id,
    get_json_object(payload, '$.createdEntityId') AS story_id, MIN(occurred_at) AS created_at
  FROM decision_event_current
  WHERE event_type = 'change_applied' AND subject_type = 'backlog_proposal_application'
    AND get_json_object(payload, '$.action') = 'create'
    AND get_json_object(payload, '$.createdEntityType') = 'story'
    AND get_json_object(payload, '$.createdEntityId') IS NOT NULL
  GROUP BY organization_id, project_id, related_subject_id, get_json_object(payload, '$.createdEntityId')
), edits AS (
  SELECT s.organization_id, s.project_id, s.proposal_id,
    COUNT(DISTINCT e.subject_id) AS ai_stories_edited_count,
    MIN(e.occurred_at) AS first_edit_at,
    COUNT(DISTINCT CASE WHEN e.occurred_at >= p.applied_at
      AND e.occurred_at <= timestampadd(DAY, 7, p.applied_at) THEN e.subject_id END) AS ai_stories_edited_within_7d_count
  FROM created_stories s
  JOIN proposals p ON p.organization_id = s.organization_id AND p.project_id = s.project_id AND p.proposal_id = s.proposal_id
  JOIN decision_event_current e ON e.organization_id = s.organization_id AND e.project_id = s.project_id
    AND e.related_subject_id = s.proposal_id AND e.subject_id = s.story_id
    AND e.subject_type = 'story' AND e.event_type = 'story_edited' AND e.occurred_at > s.created_at
  GROUP BY s.organization_id, s.project_id, s.proposal_id
)
SELECT p.*,
  COALESCE(o.offered,0) AS offered, COALESCE(o.selected,0) AS selected,
  COALESCE(o.not_selected,0) AS not_selected,
  CASE WHEN p.final_status='APPLIED' AND COALESCE(o.not_selected,0)>0 THEN true ELSE false END AS partly_applied,
  CASE p.final_status
    WHEN 'PENDING' THEN 'Pending'
    WHEN 'APPROVED' THEN 'Approved'
    WHEN 'APPLYING' THEN 'Applying'
    WHEN 'APPLIED' THEN 'Applied'
    WHEN 'REJECTED' THEN 'Rejected'
    WHEN 'BACKLOG' THEN 'Rejected'
    WHEN 'FAILED' THEN 'Failed'
    WHEN 'SUPERSEDED' THEN 'Superseded'
    ELSE 'Unknown' END AS final_outcome,
  COALESCE(a.changes_applied_count, 0) AS changes_applied_count,
  COALESCE(a.created_entity_count, 0) AS created_entity_count,
  COALESCE(e.ai_stories_edited_count, 0) AS ai_stories_edited_count, e.first_edit_at,
  COALESCE(e.ai_stories_edited_within_7d_count, 0) AS ai_stories_edited_within_7d_count,
  CASE WHEN p.first_human_review_at >= p.proposed_at
    THEN timestampdiff(SECOND, p.proposed_at, p.first_human_review_at) END AS review_latency_seconds
FROM proposals p
LEFT JOIN outcome_totals o ON o.organization_id=p.organization_id AND o.project_id=p.project_id AND o.proposal_id=p.proposal_id
LEFT JOIN applications a ON a.organization_id = p.organization_id AND a.project_id = p.project_id AND a.proposal_id = p.proposal_id
LEFT JOIN edits e ON e.organization_id = p.organization_id AND e.project_id = p.project_id AND e.proposal_id = p.proposal_id;

-- COMMAND ----------
-- Event-day counts are distinct proposals per metric, not current-state counts
-- or a creation cohort funnel. Re-entries count once per project/day/metric.
-- approved means accepted by a person (approved or applied): human transitions
-- into APPROVED, APPLYING or APPLIED. System completion is counted by applied.
-- rejected includes BACKLOG, the app's recoverable "Move to Rejected", and
-- permanent REJECTED, regardless of actor. Later acceptance counts on its day.
CREATE OR REPLACE TABLE project_decision_daily USING DELTA AS
WITH proposal_event_days AS (
  SELECT organization_id, project_id, CAST(occurred_at AS DATE) AS decision_day,
    COUNT(DISTINCT CASE WHEN event_type = 'proposed' THEN subject_id END) AS proposed,
    COUNT(DISTINCT CASE WHEN event_type = 'status_changed' AND actor_kind = 'human'
      AND to_state IN ('APPROVED', 'APPLYING', 'APPLIED') THEN subject_id END) AS approved,
    COUNT(DISTINCT CASE WHEN event_type = 'status_changed' AND to_state IN ('REJECTED', 'BACKLOG') THEN subject_id END) AS rejected,
    COUNT(DISTINCT CASE WHEN event_type = 'status_changed' AND to_state = 'APPLIED' THEN subject_id END) AS applied,
    COUNT(DISTINCT CASE WHEN event_type = 'status_changed' AND to_state = 'FAILED' THEN subject_id END) AS failed,
    COUNT(DISTINCT CASE WHEN event_type = 'status_changed' AND to_state = 'SUPERSEDED' THEN subject_id END) AS superseded
  FROM decision_event_current
  WHERE subject_type = 'backlog_proposal' AND project_id IS NOT NULL
    AND event_type IN ('proposed', 'status_changed')
  GROUP BY organization_id, project_id, CAST(occurred_at AS DATE)
), reviews AS (
  SELECT organization_id, project_id, CAST(first_human_review_at AS DATE) AS decision_day,
    percentile_approx(review_latency_seconds, 0.5) AS median_review_latency_seconds
  FROM suggestion_journey WHERE first_human_review_at IS NOT NULL
  GROUP BY organization_id, project_id, CAST(first_human_review_at AS DATE)
), applied_cohorts AS (
  SELECT organization_id, project_id, CAST(applied_at AS DATE) AS decision_day,
    COUNT(*) AS applied_cohort_count,
    SUM(CASE WHEN timestampadd(DAY, 7, applied_at) <= current_timestamp() THEN 1 ELSE 0 END) AS mature_applied_count,
    SUM(CASE WHEN timestampadd(DAY, 7, applied_at) <= current_timestamp()
      AND ai_stories_edited_within_7d_count > 0 THEN 1 ELSE 0 END) AS mature_edited_within_7d_count
  FROM suggestion_journey WHERE applied_at IS NOT NULL
  GROUP BY organization_id, project_id, CAST(applied_at AS DATE)
), change_days AS (
 SELECT organization_id, project_id, CAST(decided_at AS DATE) AS decision_day,
  SUM(CASE WHEN outcome='applied' THEN 1 ELSE 0 END) AS change_applied,
  SUM(CASE WHEN outcome='alreadyOnRoadmap' THEN 1 ELSE 0 END) AS change_already_on_roadmap,
  SUM(CASE WHEN outcome='notSelected' THEN 1 ELSE 0 END) AS change_not_selected,
  SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) AS change_failed,
  SUM(CASE WHEN outcome='inProgress' THEN 1 ELSE 0 END) AS change_in_progress,
  SUM(CASE WHEN outcome='rejected' THEN 1 ELSE 0 END) AS change_rejected,
  SUM(CASE WHEN outcome='superseded' THEN 1 ELSE 0 END) AS change_superseded,
  SUM(CASE WHEN outcome='pending' THEN 1 ELSE 0 END) AS change_pending,
  SUM(CASE WHEN outcome IN ('applied','failed','inProgress') THEN 1 ELSE 0 END) AS change_accepted,
  SUM(CASE WHEN outcome IN ('applied','failed','inProgress','notSelected','rejected') THEN 1 ELSE 0 END) AS change_decided
 FROM change_outcomes GROUP BY organization_id,project_id,CAST(decided_at AS DATE)
), days AS (
 SELECT organization_id,project_id,decision_day FROM proposal_event_days
 UNION SELECT organization_id,project_id,decision_day FROM change_days
), event_days AS (
 SELECT days.*, COALESCE(p.proposed,0) AS proposed, COALESCE(p.approved,0) AS approved, COALESCE(p.rejected,0) AS rejected, COALESCE(p.applied,0) AS applied, COALESCE(p.failed,0) AS failed, COALESCE(p.superseded,0) AS superseded
 FROM days LEFT JOIN proposal_event_days p ON p.organization_id=days.organization_id AND p.project_id=days.project_id AND p.decision_day=days.decision_day
)
SELECT d.*, COALESCE(ch.change_applied,0) AS change_applied, COALESCE(ch.change_already_on_roadmap,0) AS change_already_on_roadmap, COALESCE(ch.change_not_selected,0) AS change_not_selected, COALESCE(ch.change_failed,0) AS change_failed, COALESCE(ch.change_in_progress,0) AS change_in_progress, COALESCE(ch.change_rejected,0) AS change_rejected, COALESCE(ch.change_superseded,0) AS change_superseded, COALESCE(ch.change_pending,0) AS change_pending, COALESCE(ch.change_accepted,0) AS change_accepted, COALESCE(ch.change_decided,0) AS change_decided, r.median_review_latency_seconds,
  COALESCE(c.applied_cohort_count, 0) AS applied_cohort_count,
  COALESCE(c.mature_applied_count, 0) AS mature_applied_count,
  COALESCE(c.mature_edited_within_7d_count, 0) AS mature_edited_within_7d_count,
  CASE WHEN c.mature_applied_count > 0
    THEN c.mature_edited_within_7d_count * 1.0 / c.mature_applied_count END AS share_applied_edited_within_7d
FROM event_days d
LEFT JOIN change_days ch ON ch.organization_id=d.organization_id AND ch.project_id=d.project_id AND ch.decision_day=d.decision_day
LEFT JOIN reviews r ON r.organization_id = d.organization_id AND r.project_id = d.project_id AND r.decision_day = d.decision_day
LEFT JOIN applied_cohorts c ON c.organization_id = d.organization_id AND c.project_id = d.project_id AND c.decision_day = d.decision_day;

-- COMMAND ----------
CREATE OR REPLACE TABLE needs_review USING DELTA AS
SELECT organization_id, project_id, proposal_id, proposed_at, change_count,
  timestampdiff(SECOND, proposed_at, current_timestamp()) AS age_seconds,
  ROW_NUMBER() OVER (PARTITION BY organization_id, project_id
    ORDER BY proposed_at ASC NULLS LAST, change_count DESC NULLS LAST, proposal_id) AS review_rank,
  -- Databricks two-argument rtrim takes the trim characters first; use ANSI trim.
  concat(trim(TRAILING '/' FROM :fabric_base_url), '/app/projects/', project_id,
    '?tab=stories&proposal=', proposal_id) AS proposal_url
FROM suggestion_journey WHERE final_status = 'PENDING';

-- COMMAND ----------
-- Duplicate capture does not export feature/model/prompt metadata. Preserve NULL
-- rather than attributing detection to a made-up model. One current outcome/link.
CREATE OR REPLACE TABLE duplicate_outcomes USING DELTA AS
WITH links AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY organization_id, project_id, subject_id ORDER BY occurred_at DESC, id DESC
  ) AS outcome_rank
  FROM decision_event_current
  WHERE subject_type = 'story_duplicate_link' AND subject_id IS NOT NULL AND project_id IS NOT NULL
    AND event_type IN ('duplicate_detected', 'duplicate_dismissed', 'duplicate_resolved', 'duplicate_status_changed')
)
SELECT organization_id, project_id, feature_key, model, prompt_version_id,
  to_state AS outcome, COUNT(*) AS link_count
FROM links WHERE outcome_rank = 1
GROUP BY organization_id, project_id, feature_key, model, prompt_version_id, to_state;

-- COMMAND ----------
-- Ratings have no stable rating-row id in the export. Count transitions, including
-- re-ratings and clears, rather than claiming this is the current vote balance.
CREATE OR REPLACE TABLE rating_outcomes USING DELTA AS
SELECT organization_id, project_id, feature_key, model, prompt_version_id,
  event_type, COALESCE(to_state, 'CLEARED') AS outcome, COUNT(*) AS event_count
FROM decision_event_current
WHERE project_id IS NOT NULL AND event_type IN ('rated', 're_rated', 'rating_cleared')
GROUP BY organization_id, project_id, feature_key, model, prompt_version_id, event_type, COALESCE(to_state, 'CLEARED');
