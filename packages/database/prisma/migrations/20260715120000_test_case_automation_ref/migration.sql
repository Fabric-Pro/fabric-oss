-- Link a test case to the automated test that covers it: the identifier the
-- team links by ("automationRef" — a test()/.describe name or fully qualified
-- test id), the spec file it lives in, and an optional CI/report deep link.
--
-- All three are nullable: existing rows keep their current automationStatus and
-- simply carry no link. "automationRef" is the field the automation coverage
-- stat keys on — automationStatus alone is a settable intent, so a case only
-- counts as automated once it actually carries a ref.
ALTER TABLE "test_case" ADD COLUMN "automationRef" TEXT;
ALTER TABLE "test_case" ADD COLUMN "automationFilePath" TEXT;
ALTER TABLE "test_case" ADD COLUMN "automationExternalUrl" TEXT;
