SET XACT_ABORT ON;
BEGIN TRANSACTION;

ALTER TABLE dbo.RequestDrafts ADD
  request_type nvarchar(100) NULL,
  affected_users int NULL,
  workaround nvarchar(max) NULL,
  desired_timing nvarchar(200) NULL,
  linked_idea_public_id nvarchar(32) NULL;

COMMIT TRANSACTION;
