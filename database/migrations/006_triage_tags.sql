SET XACT_ABORT ON;
BEGIN TRANSACTION;

CREATE TABLE dbo.RequestTags (
  request_id uniqueidentifier NOT NULL REFERENCES dbo.Requests(id),
  taxonomy_value_id uniqueidentifier NOT NULL REFERENCES dbo.TaxonomyValues(id),
  assigned_by_user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  active bit NOT NULL DEFAULT 1,
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_RequestTags PRIMARY KEY(request_id,taxonomy_value_id)
);

COMMIT TRANSACTION;
