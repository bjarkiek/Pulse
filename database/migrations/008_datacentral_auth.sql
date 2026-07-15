SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- DataCentral embed + Entra OIDC identity linkage. The GUID PK is untouched;
-- sessions carry Users.id as sub, so every repository keeps working unchanged.
ALTER TABLE dbo.Users ADD
  external_subject nvarchar(128) NULL,   -- Entra oid (lowercase GUID string), 'dc:{userId}', or 'pending:{email}'
  entra_tenant_id nvarchar(64) NULL,
  last_login_at datetime2 NULL,
  last_login_method nvarchar(32) NULL;   -- 'entra' | 'dc-hmac' | 'dc-graph'

COMMIT TRANSACTION;
GO

-- NOTE: the index and backfill below are intentionally OUTSIDE the transaction,
-- in separate GO batches. T-SQL requires a batch boundary before a statement can
-- reference a column added earlier in the same batch — a single-transaction
-- migration here fails to compile. This is the deliberate exception to the repo's
-- "wrap the whole migration in one transaction" convention; do not "fix" it.
CREATE UNIQUE NONCLUSTERED INDEX UX_Users_ExternalSubject
  ON dbo.Users(external_subject)
  WHERE external_subject IS NOT NULL;
GO

-- Backfill: the legacy Easy Auth convention was Users.id == Entra object id.
UPDATE dbo.Users
SET external_subject = LOWER(CONVERT(nvarchar(36), id))
WHERE auth_method = 'Entra ID' AND external_subject IS NULL;
GO
