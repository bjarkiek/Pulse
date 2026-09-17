SET XACT_ABORT ON;
BEGIN TRANSACTION;

ALTER TABLE dbo.Users ADD tokens_valid_after datetime2 NULL;
ALTER TABLE dbo.Attachments ADD upload_etag nvarchar(128) NULL, scan_updated_at datetime2 NULL;

-- Legacy approvals cannot prove which bytes were scanned. Quarantine them.
EXEC(N'UPDATE dbo.Attachments SET scan_state=''Failed'',scan_updated_at=SYSUTCDATETIME() WHERE scan_state IN (''Clean'',''Scanning'')');

-- Invalidate old cache entries: they lack caller binding and a body digest.
DELETE FROM dbo.IdempotencyKeys;
ALTER TABLE dbo.IdempotencyKeys ADD user_id uniqueidentifier NOT NULL,
  request_hash char(64) NOT NULL;
ALTER TABLE dbo.IdempotencyKeys DROP CONSTRAINT PK_IdempotencyKeys;
ALTER TABLE dbo.IdempotencyKeys ADD CONSTRAINT PK_IdempotencyKeys
  PRIMARY KEY(organization_id,user_id,idempotency_key,operation);
CREATE INDEX IX_IdempotencyKeys_Expiry ON dbo.IdempotencyKeys(expires_at);

CREATE TABLE dbo.RateLimits (
  bucket char(64) NOT NULL PRIMARY KEY,
  count int NOT NULL,
  expires_at datetime2 NOT NULL
);
CREATE INDEX IX_RateLimits_Expiry ON dbo.RateLimits(expires_at);
CREATE INDEX IX_OtpCodes_Email_Created ON dbo.OtpCodes(email,created_at);
COMMIT TRANSACTION;
