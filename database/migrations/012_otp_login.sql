-- Email one-time-passcode sign-in (standalone login screen).
-- Codes are stored hashed (sha256 of email:code); a fresh issue invalidates the
-- previous active code (consumed_at), verification failures increment attempts,
-- and rows older than a day are swept opportunistically on issue.
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID('dbo.OtpCodes','U') IS NULL
BEGIN
    CREATE TABLE dbo.OtpCodes (
        id uniqueidentifier NOT NULL PRIMARY KEY,
        email nvarchar(320) NOT NULL,
        code_hash nvarchar(64) NOT NULL,
        attempts int NOT NULL DEFAULT 0,
        expires_at datetime2 NOT NULL,
        consumed_at datetime2 NULL,
        created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
    CREATE INDEX IX_OtpCodes_Email ON dbo.OtpCodes(email, created_at DESC);
END

COMMIT;
