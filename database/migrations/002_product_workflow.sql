SET XACT_ABORT ON;
BEGIN TRANSACTION;

ALTER TABLE dbo.Ideas ADD
  published_status_note nvarchar(max) NULL,
  decision_rationale nvarchar(max) NULL,
  decision_reason nvarchar(100) NULL,
  delivery_reference nvarchar(1000) NULL,
  delivery_exception bit NOT NULL CONSTRAINT DF_Ideas_DeliveryException DEFAULT 0,
  published_at datetime2 NULL;

ALTER TABLE dbo.Notifications ADD read_at datetime2 NULL;

CREATE TABLE dbo.IdeaAliases (
  alias_public_id nvarchar(32) NOT NULL PRIMARY KEY,
  surviving_idea_id uniqueidentifier NOT NULL REFERENCES dbo.Ideas(id),
  merged_by_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  merged_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
);

CREATE TABLE dbo.RoadmapPlacements (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  idea_id uniqueidentifier NOT NULL REFERENCES dbo.Ideas(id),
  horizon nvarchar(20) NOT NULL CHECK (horizon IN ('Now','Next','Later','Released')),
  target_quarter nvarchar(20) NULL,
  confidence int NULL CHECK (confidence IS NULL OR confidence IN (50,80,100)),
  published bit NOT NULL DEFAULT 0,
  active bit NOT NULL DEFAULT 1,
  changed_by_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  ended_at datetime2 NULL
);
CREATE UNIQUE INDEX UQ_RoadmapPlacements_Active ON dbo.RoadmapPlacements(idea_id) WHERE active=1;

CREATE TABLE dbo.Releases (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  public_id nvarchar(32) NOT NULL UNIQUE,
  title nvarchar(200) NOT NULL,
  release_date date NOT NULL,
  summary nvarchar(max) NOT NULL,
  availability nvarchar(100) NOT NULL,
  documentation_url nvarchar(1000) NULL,
  rollout_notes nvarchar(max) NULL,
  published bit NOT NULL DEFAULT 0,
  published_at datetime2 NULL,
  created_by_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  deleted_at datetime2 NULL
);
CREATE SEQUENCE dbo.ReleaseNumber AS bigint START WITH 1 INCREMENT BY 1;

CREATE TABLE dbo.ReleaseIdeas (
  release_id uniqueidentifier NOT NULL REFERENCES dbo.Releases(id),
  idea_id uniqueidentifier NOT NULL REFERENCES dbo.Ideas(id),
  CONSTRAINT PK_ReleaseIdeas PRIMARY KEY(release_id,idea_id)
);

CREATE TABLE dbo.ExternalLinks (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  idea_id uniqueidentifier NOT NULL REFERENCES dbo.Ideas(id),
  label nvarchar(100) NOT NULL,
  url nvarchar(2000) NOT NULL,
  created_by_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  deleted_at datetime2 NULL
);

CREATE TABLE dbo.Settings (
  setting_key nvarchar(100) NOT NULL PRIMARY KEY,
  value_json nvarchar(max) NOT NULL CHECK (ISJSON(value_json)=1),
  version int NOT NULL DEFAULT 1,
  updated_by_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
);

COMMIT TRANSACTION;
