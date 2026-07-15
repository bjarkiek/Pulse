SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- OAuth clients registered via MCP Dynamic Client Registration (RFC 7591).
-- Public clients only (PKCE, no secret) — identity always comes from the user's sign-in.
CREATE TABLE dbo.McpClients (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  client_id nvarchar(64) NOT NULL,
  client_name nvarchar(200) NOT NULL,
  redirect_uris_json nvarchar(max) NOT NULL CHECK (ISJSON(redirect_uris_json) = 1),
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_McpClients_ClientId UNIQUE(client_id)
);

-- Refresh tokens: only SHA-256 hashes stored; rotated (revoked_at set) atomically on every use.
CREATE TABLE dbo.McpRefreshTokens (
  id uniqueidentifier NOT NULL PRIMARY KEY,
  token_hash nvarchar(64) NOT NULL,
  user_id uniqueidentifier NOT NULL REFERENCES dbo.Users(id),
  client_id nvarchar(64) NOT NULL,
  created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  expires_at datetime2 NOT NULL,
  revoked_at datetime2 NULL,
  CONSTRAINT UQ_McpRefreshTokens_TokenHash UNIQUE(token_hash)
);
CREATE INDEX IX_McpRefreshTokens_User ON dbo.McpRefreshTokens(user_id, revoked_at);

COMMIT TRANSACTION;
