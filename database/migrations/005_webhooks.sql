SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- Guarded so a retried deploy (after a transient failure in a later GO batch of
-- this file) does not fail on "object already exists". Batch 1 is atomic, so a
-- single existence check covers all objects created here.
IF OBJECT_ID('dbo.WebhookSubscriptions','U') IS NULL
BEGIN

CREATE TABLE dbo.WebhookSubscriptions (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  url nvarchar(2000) NOT NULL,
  events_json nvarchar(max) NOT NULL CHECK (ISJSON(events_json)=1),
  active bit NOT NULL DEFAULT 1,
  created_by_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  deleted_at datetime2 NULL
);

CREATE TABLE dbo.WebhookDeliveries (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  subscription_id uniqueidentifier NOT NULL REFERENCES dbo.WebhookSubscriptions(id),
  audit_event_id uniqueidentifier NOT NULL REFERENCES dbo.AuditEvents(id),
  event_type nvarchar(100) NOT NULL,
  payload_json nvarchar(max) NOT NULL CHECK (ISJSON(payload_json)=1),
  state nvarchar(32) NOT NULL DEFAULT 'Queued',
  attempt_count int NOT NULL DEFAULT 0,
  next_attempt_at datetime2 NULL,
  last_status int NULL,
  last_error_code nvarchar(100) NULL,
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  delivered_at datetime2 NULL,
  CONSTRAINT UQ_WebhookDeliveries_Event UNIQUE(subscription_id,audit_event_id)
);
CREATE INDEX IX_WebhookDeliveries_Work
  ON dbo.WebhookDeliveries(state,next_attempt_at,created_at)
  INCLUDE(subscription_id,event_type,attempt_count);

END

COMMIT TRANSACTION;
GO

CREATE OR ALTER TRIGGER dbo.TR_AuditEvents_WebhookOutbox ON dbo.AuditEvents
AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  INSERT dbo.WebhookDeliveries(id,subscription_id,audit_event_id,event_type,payload_json)
  SELECT NEWID(),s.id,i.id,i.action,
    (SELECT CONVERT(nvarchar(36),i.id) eventId,i.action eventType,i.entity_type entityType,
      CONVERT(nvarchar(36),i.entity_id) entityId,CONVERT(nvarchar(33),i.created_at,127) occurredAt
      FOR JSON PATH,WITHOUT_ARRAY_WRAPPER)
  FROM inserted i
  JOIN dbo.WebhookSubscriptions s ON s.active=1 AND s.deleted_at IS NULL
  WHERE EXISTS(SELECT 1 FROM OPENJSON(s.events_json) event WHERE event.[value]=i.action);
END;
GO
