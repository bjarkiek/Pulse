SET XACT_ABORT ON;
BEGIN TRANSACTION;

CREATE TABLE dbo.RequestDrafts (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  organization_id nvarchar(32) NOT NULL REFERENCES dbo.Organizations(id),
  title nvarchar(140) NULL,
  problem nvarchar(max) NULL,
  product_area nvarchar(100) NULL,
  impact nvarchar(32) NULL,
  visibility nvarchar(32) NOT NULL DEFAULT 'Organization'
    CHECK (visibility IN ('Private','Organization')),
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_RequestDrafts_User_Organization UNIQUE(user_id, organization_id)
);

CREATE TABLE dbo.SavedViews (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  owner_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  name nvarchar(120) NOT NULL,
  scope nvarchar(32) NOT NULL CHECK (scope IN ('Private','Internal shared')),
  resource_type nvarchar(32) NOT NULL,
  query_json nvarchar(max) NOT NULL CHECK (ISJSON(query_json)=1),
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  deleted_at datetime2 NULL
);

CREATE TABLE dbo.TaxonomyValues (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  kind nvarchar(40) NOT NULL CHECK (kind IN ('Product area','Request type','Tag','Strategic theme','Reason category')),
  value nvarchar(120) NOT NULL,
  active bit NOT NULL DEFAULT 1,
  sort_order int NOT NULL DEFAULT 0,
  updated_by_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_TaxonomyValues_Kind_Value UNIQUE(kind,value)
);

CREATE TABLE dbo.CommentRevisions (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  comment_id uniqueidentifier NOT NULL REFERENCES dbo.Comments(id),
  revision_number int NOT NULL,
  body nvarchar(max) NOT NULL,
  changed_by_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_CommentRevisions UNIQUE(comment_id, revision_number)
);

ALTER TABLE dbo.Comments ADD
  deleted_by_user_id uniqueidentifier NULL REFERENCES dbo.Users(id),
  deletion_reason nvarchar(500) NULL;

CREATE TABLE dbo.NotificationPreferences (
  user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  organization_id nvarchar(32) NOT NULL REFERENCES dbo.Organizations(id),
  event_type nvarchar(100) NOT NULL,
  cadence nvarchar(32) NOT NULL CHECK (cadence IN ('Immediate','Daily','Weekly','Off')),
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_NotificationPreferences PRIMARY KEY(user_id, organization_id, event_type)
);

ALTER TABLE dbo.Notifications ADD
  attempt_count int NOT NULL CONSTRAINT DF_Notifications_AttemptCount DEFAULT 0,
  next_attempt_at datetime2 NULL,
  last_error_code nvarchar(100) NULL;

ALTER TABLE dbo.Requests ADD
  triage_due_at datetime2 NULL,
  first_response_at datetime2 NULL,
  triaged_at datetime2 NULL,
  support_reference nvarchar(1000) NULL,
  closure_explanation nvarchar(max) NULL;

ALTER TABLE dbo.Organizations ADD
  allowed_auth_methods nvarchar(100) NOT NULL
    CONSTRAINT DF_Organizations_AllowedAuth DEFAULT N'["OTP","Entra ID"]'
    CHECK (ISJSON(allowed_auth_methods)=1);

CREATE INDEX IX_Notifications_Delivery
  ON dbo.Notifications(state,next_attempt_at,created_at)
  INCLUDE(channel,event_type,attempt_count);

COMMIT TRANSACTION;
