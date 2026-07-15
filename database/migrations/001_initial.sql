SET XACT_ABORT ON;
BEGIN TRANSACTION;

CREATE SEQUENCE dbo.RequestNumber AS bigint START WITH 1043 INCREMENT BY 1;
CREATE SEQUENCE dbo.IdeaNumber AS bigint START WITH 318 INCREMENT BY 1;

CREATE TABLE dbo.Organizations (
  id nvarchar(32) NOT NULL PRIMARY KEY,
  name nvarchar(200) NOT NULL,
  type nvarchar(32) NOT NULL CHECK (type IN ('Customer','Partner','Internal')),
  status nvarchar(32) NOT NULL DEFAULT 'Active',
  verified_domain nvarchar(255) NULL,
  locale nvarchar(12) NOT NULL DEFAULT 'en',
  is_test bit NOT NULL DEFAULT 0,
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE TABLE dbo.Users (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  email nvarchar(320) NOT NULL,
  display_name nvarchar(200) NOT NULL,
  status nvarchar(32) NOT NULL DEFAULT 'Active',
  auth_method nvarchar(32) NOT NULL,
  locale nvarchar(12) NOT NULL DEFAULT 'en',
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_Users_Email UNIQUE(email)
);

CREATE TABLE dbo.Memberships (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  organization_id nvarchar(32) NOT NULL REFERENCES dbo.Organizations(id),
  role nvarchar(64) NOT NULL,
  status nvarchar(32) NOT NULL DEFAULT 'Active',
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_Memberships_User_Organization UNIQUE(user_id, organization_id)
);

CREATE TABLE dbo.Requests (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  public_id nvarchar(32) NOT NULL UNIQUE,
  organization_id nvarchar(32) NOT NULL REFERENCES dbo.Organizations(id),
  created_by_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  owner_user_id uniqueidentifier NULL REFERENCES dbo.Users(id),
  title nvarchar(140) NOT NULL,
  problem nvarchar(max) NOT NULL,
  product_area nvarchar(100) NULL,
  request_type nvarchar(100) NULL,
  impact nvarchar(32) NULL,
  affected_users int NULL,
  workaround nvarchar(max) NULL,
  desired_timing nvarchar(200) NULL,
  status nvarchar(40) NOT NULL DEFAULT 'Submitted',
  visibility nvarchar(32) NOT NULL DEFAULT 'Organization' CHECK (visibility IN ('Private','Organization')),
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  withdrawn_at datetime2 NULL,
  deleted_at datetime2 NULL,
  row_version rowversion
);
CREATE INDEX IX_Requests_Organization_Status ON dbo.Requests(organization_id,status,updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE dbo.RequestRevisions (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  request_id uniqueidentifier NOT NULL REFERENCES dbo.Requests(id),
  revision_number int NOT NULL,
  title nvarchar(140) NOT NULL,
  problem nvarchar(max) NOT NULL,
  changed_by_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_RequestRevisions UNIQUE(request_id,revision_number)
);

CREATE TABLE dbo.Ideas (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  public_id nvarchar(32) NOT NULL UNIQUE,
  internal_title nvarchar(200) NOT NULL,
  internal_description nvarchar(max) NOT NULL,
  published_title nvarchar(200) NULL,
  published_description nvarchar(max) NULL,
  product_area nvarchar(100) NULL,
  status nvarchar(40) NOT NULL DEFAULT 'Discovery',
  published_status nvarchar(40) NULL,
  roadmap_horizon nvarchar(20) NULL,
  owner_user_id uniqueidentifier NULL REFERENCES dbo.Users(id),
  publish_state nvarchar(32) NOT NULL DEFAULT 'Internal',
  release_notes nvarchar(max) NULL,
  availability nvarchar(100) NULL,
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  deleted_at datetime2 NULL,
  row_version rowversion
);
CREATE INDEX IX_Ideas_Published ON dbo.Ideas(publish_state,status,updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE dbo.RequestIdeaLinks (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  request_id uniqueidentifier NOT NULL REFERENCES dbo.Requests(id),
  idea_id uniqueidentifier NOT NULL REFERENCES dbo.Ideas(id),
  link_type nvarchar(32) NOT NULL DEFAULT 'Supports',
  active bit NOT NULL DEFAULT 1,
  reason nvarchar(1000) NULL,
  created_by_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE UNIQUE INDEX UQ_RequestIdeaLinks_Active ON dbo.RequestIdeaLinks(request_id,idea_id) WHERE active=1;

CREATE TABLE dbo.OrganizationInterests (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  organization_id nvarchar(32) NOT NULL REFERENCES dbo.Organizations(id),
  idea_id uniqueidentifier NOT NULL REFERENCES dbo.Ideas(id),
  importance nvarchar(32) NULL,
  context nvarchar(max) NULL,
  active bit NOT NULL DEFAULT 1,
  updated_by_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_OrganizationInterests UNIQUE(organization_id,idea_id)
);

CREATE TABLE dbo.Follows (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  organization_id nvarchar(32) NOT NULL REFERENCES dbo.Organizations(id),
  idea_id uniqueidentifier NOT NULL REFERENCES dbo.Ideas(id),
  preference nvarchar(32) NOT NULL DEFAULT 'Immediate',
  active bit NOT NULL DEFAULT 1,
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_Follows UNIQUE(user_id,organization_id,idea_id)
);

CREATE TABLE dbo.Comments (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  parent_type nvarchar(32) NOT NULL,
  parent_id uniqueidentifier NOT NULL,
  organization_id nvarchar(32) NULL REFERENCES dbo.Organizations(id),
  author_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  visibility nvarchar(32) NOT NULL CHECK (visibility IN ('Customer','Internal')),
  body nvarchar(max) NOT NULL,
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  edited_at datetime2 NULL,
  deleted_at datetime2 NULL
);

CREATE TABLE dbo.Attachments (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  request_id uniqueidentifier NOT NULL REFERENCES dbo.Requests(id),
  organization_id nvarchar(32) NOT NULL REFERENCES dbo.Organizations(id),
  uploaded_by_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  storage_key nvarchar(1024) NOT NULL UNIQUE,
  file_name nvarchar(255) NOT NULL,
  content_type nvarchar(255) NOT NULL,
  size_bytes bigint NOT NULL,
  scan_state nvarchar(32) NOT NULL DEFAULT 'Pending upload',
  visibility nvarchar(32) NOT NULL,
  content_hash varbinary(32) NULL,
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  deleted_at datetime2 NULL
);
CREATE INDEX IX_Attachments_Request ON dbo.Attachments(request_id,created_at) WHERE deleted_at IS NULL;

CREATE TABLE dbo.ScoreSnapshots (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  idea_id uniqueidentifier NOT NULL REFERENCES dbo.Ideas(id),
  formula_version int NOT NULL,
  inputs_json nvarchar(max) NOT NULL CHECK (ISJSON(inputs_json)=1),
  score decimal(12,4) NOT NULL,
  actor_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE TABLE dbo.Notifications (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  organization_id nvarchar(32) NOT NULL REFERENCES dbo.Organizations(id),
  event_type nvarchar(100) NOT NULL,
  channel nvarchar(32) NOT NULL,
  template nvarchar(100) NOT NULL,
  state nvarchar(32) NOT NULL DEFAULT 'Queued',
  deduplication_key nvarchar(255) NOT NULL,
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  delivered_at datetime2 NULL,
  CONSTRAINT UQ_Notifications_Dedup UNIQUE(user_id,channel,deduplication_key)
);

CREATE TABLE dbo.AuditEvents (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  actor_user_id uniqueidentifier NULL REFERENCES dbo.Users(id),
  organization_id nvarchar(32) NULL REFERENCES dbo.Organizations(id),
  action nvarchar(100) NOT NULL,
  entity_type nvarchar(100) NOT NULL,
  entity_id uniqueidentifier NULL,
  before_json nvarchar(max) NULL CHECK (before_json IS NULL OR ISJSON(before_json)=1),
  after_json nvarchar(max) NULL CHECK (after_json IS NULL OR ISJSON(after_json)=1),
  correlation_id uniqueidentifier NOT NULL,
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_AuditEvents_Entity ON dbo.AuditEvents(entity_type,entity_id,created_at DESC);

CREATE TABLE dbo.IdempotencyKeys (
  organization_id nvarchar(32) NOT NULL REFERENCES dbo.Organizations(id),
  idempotency_key nvarchar(100) NOT NULL,
  operation nvarchar(100) NOT NULL,
  response_status int NULL,
  response_json nvarchar(max) NULL,
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  expires_at datetime2 NOT NULL,
  CONSTRAINT PK_IdempotencyKeys PRIMARY KEY(organization_id,idempotency_key,operation)
);

COMMIT TRANSACTION;
