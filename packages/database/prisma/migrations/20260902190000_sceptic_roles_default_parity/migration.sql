-- ScepticRolesDefaultParity
-- The column default disagreed with the default an unconfigured project reads.
--
-- `QA_SETTINGS_DEFAULTS.scepticRoles` is ["ux"] — the one persona the coverage
-- split deliberately leaves on — but this column defaulted to []. A project
-- with no saved row reads the constant, so the page shows UX Skeptic enabled;
-- the first time that project saves ANY setting the upsert takes its create
-- branch, Prisma fills the omitted column from this default, and UX Skeptic is
-- silently dropped. Observed on staging while verifying Fizzy #2186.
--
-- Only the DEFAULT changes. Existing rows are left exactly as they are: a
-- project that has genuinely chosen an empty set keeps it, and this must not
-- re-enable a persona anyone switched off. New rows now agree with what the
-- screen promised before the first save.

ALTER TABLE "project_qa_settings" ALTER COLUMN "scepticRoles" SET DEFAULT ARRAY['ux']::TEXT[];
