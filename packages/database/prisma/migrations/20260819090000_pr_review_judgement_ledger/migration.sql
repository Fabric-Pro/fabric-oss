-- Make the feature's accuracy figure mean what it is called (card 1642).
--
-- The success criterion is a FALSE-POSITIVE rate under 20%. What shipped was a
-- DISMISSAL rate, which the docs called the false-positive rate anyway. They are
-- different measurements: "not worth acting on" also covers a correct finding
-- somebody chose not to fix, one that is out of scope, and one already covered
-- elsewhere. None of those is the lens being wrong.
ALTER TABLE "pull_request_review_finding" ADD COLUMN "dismissalReason" TEXT;

-- The second half: the number reset whenever anyone re-ran a lens.
--
-- Re-running REPLACES that lens's findings for the review, deliberately, and the
-- judgements went with them. The architecture lens costs nothing to re-run, so
-- the published figure could be erased by a free button. A judgement is
-- therefore recorded apart from the finding row it was given on, keyed by a
-- fingerprint of the OBSERVATION so re-judging the same one updates a row rather
-- than counting twice.
CREATE TABLE "pr_review_judgement" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "lens" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dismissalReason" TEXT,
    "judgedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pr_review_judgement_pkey" PRIMARY KEY ("id")
);

-- One verdict per observation per lens per project: re-judging updates it.
CREATE UNIQUE INDEX "pr_review_judgement_projectId_lens_fingerprint_key"
    ON "pr_review_judgement"("projectId", "lens", "fingerprint");
CREATE INDEX "pr_review_judgement_projectId_lens_idx"
    ON "pr_review_judgement"("projectId", "lens");
CREATE INDEX "pr_review_judgement_userId_idx"
    ON "pr_review_judgement"("userId");
CREATE INDEX "pr_review_judgement_organizationId_idx"
    ON "pr_review_judgement"("organizationId");

ALTER TABLE "pr_review_judgement"
    ADD CONSTRAINT "pr_review_judgement_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pr_review_judgement"
    ADD CONSTRAINT "pr_review_judgement_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pr_review_judgement"
    ADD CONSTRAINT "pr_review_judgement_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry over the judgements that already exist, so the figure does not start
-- from zero on deployments that have been using the feature. Findings whose
-- lens was re-run are already gone; this recovers everything still standing.
INSERT INTO "pr_review_judgement" (
    "id", "projectId", "organizationId", "userId", "lens", "fingerprint",
    "status", "dismissalReason", "judgedById", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    f."projectId",
    f."organizationId",
    f."userId",
    f."lens",
    -- md5, matching `prReviewFindingFingerprint` in the query layer. Core
    -- Postgres, so no extension is needed on either the managed database or a
    -- developer's local one — and this is a dedupe key inside one project and
    -- lens, never a security boundary, so collision resistance is not the
    -- property being bought. chr(31) is the unit separator: it cannot occur in
    -- a path or a title, and unlike NUL it is storable in Postgres text.
    md5(f."lens" || chr(31) || coalesce(f."filePath", '') || chr(31) || f."title"),
    f."status",
    NULL,
    NULL,
    f."createdAt",
    f."updatedAt"
FROM "pull_request_review_finding" f
WHERE f."status" IN ('ACCEPTED', 'DISMISSED')
-- Newest first, because the conflict clause keeps whichever row arrives first.
-- Where the same observation was judged more than once historically with
-- different verdicts, this keeps the LATEST — matching what the running app does
-- on a re-judgement, rather than whichever row an unordered scan happened to
-- reach first.
ORDER BY f."updatedAt" DESC, f."id" ASC
ON CONFLICT ("projectId", "lens", "fingerprint") DO NOTHING;
