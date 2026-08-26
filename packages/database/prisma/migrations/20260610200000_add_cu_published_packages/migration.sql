-- Cross-repo "System map": capture each repo's own published-package
-- identities so the detector can find a precise DEPENDS_ON (another repo
-- depending on one of these genuinely consumes this repo's code).
ALTER TABLE "code_understanding_analysis" ADD COLUMN     "publishedPackages" JSONB;
