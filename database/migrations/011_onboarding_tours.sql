SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- Driver.js onboarding tour kit (DataCentralEmbedOnboardingTours.md §5.2).
-- Progress rows: no row = never started; Dismissed = closed before the last step.
-- Per-tour admin settings are seeded lazily from the code catalog on first read;
-- the master switch lives in dbo.Settings under setting_key='onboarding'
-- (default ON when the row is absent). Guarded for retry-safety like 008.
IF OBJECT_ID('dbo.TourProgress') IS NULL
BEGIN
  CREATE TABLE dbo.TourProgress (
    id uniqueidentifier NOT NULL PRIMARY KEY,
    user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
    tour_key nvarchar(64) NOT NULL,
    version int NOT NULL,
    status nvarchar(16) NOT NULL CHECK (status IN ('InProgress','Completed','Dismissed')),
    last_step_index int NOT NULL DEFAULT 0,
    step_count int NOT NULL,
    source nvarchar(16) NOT NULL,          -- 'standalone' | 'embed'
    started_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
    completed_at datetime2 NULL,
    updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_TourProgress_UserTour UNIQUE (user_id, tour_key)
  );
END

IF OBJECT_ID('dbo.TourSettings') IS NULL
BEGIN
  CREATE TABLE dbo.TourSettings (
    tour_key nvarchar(64) NOT NULL PRIMARY KEY,
    enabled bit NOT NULL DEFAULT 1,
    audience nvarchar(32) NOT NULL,        -- 'All' | 'Customers' | 'Internal' | 'SystemAdmins'
    auto_start bit NOT NULL DEFAULT 0,
    updated_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
END

-- Per-user "hide tours forever" opt-out; NULL = tours visible. Set from the
-- help menu, cleared only by a System admin from the onboarding settings grid.
IF COL_LENGTH('dbo.Users','tours_hidden_at') IS NULL
ALTER TABLE dbo.Users ADD tours_hidden_at datetime2 NULL;

COMMIT TRANSACTION;
