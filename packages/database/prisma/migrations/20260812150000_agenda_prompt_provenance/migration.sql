-- Records which prompt produced a generated agenda (#2178 follow-up).
--
-- Additive and nullable: every agenda generated before the prompt became
-- editable keeps NULL, and the UI omits the provenance line for those rather
-- than claiming the default prompt was used for a run it never measured.
ALTER TABLE "project_meeting_agenda" ADD COLUMN "promptProvenance" JSONB;
