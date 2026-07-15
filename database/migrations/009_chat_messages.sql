SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- Per-user assistant conversation history, shared between the web chat panel
-- and Slack (keyed by user only, not organization, so a conversation follows
-- the user across org switches and channels).
CREATE TABLE dbo.ChatMessages (
  id uniqueidentifier NOT NULL CONSTRAINT PK_ChatMessages PRIMARY KEY,
  user_id uniqueidentifier NOT NULL
    CONSTRAINT FK_ChatMessages_Users REFERENCES dbo.Users(id),
  role nvarchar(16) NOT NULL
    CONSTRAINT CK_ChatMessages_Role CHECK (role IN ('user','assistant')),
  content nvarchar(max) NOT NULL,
  created_at datetime2(3) NOT NULL
    CONSTRAINT DF_ChatMessages_CreatedAt DEFAULT SYSUTCDATETIME()
);

CREATE INDEX IX_ChatMessages_User_Created
  ON dbo.ChatMessages (user_id, created_at DESC);

COMMIT TRANSACTION;
