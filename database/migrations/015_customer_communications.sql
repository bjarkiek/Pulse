-- Customer communications: campaigns, per-recipient deliveries, explicit
-- contacts, global suppressions and the SendGrid event ledger (spec §5.2).
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID('dbo.CommunicationNumber','SO') IS NULL
  CREATE SEQUENCE dbo.CommunicationNumber AS bigint START WITH 1 INCREMENT BY 1;

IF OBJECT_ID('dbo.CommunicationContacts','U') IS NULL
BEGIN
  CREATE TABLE dbo.CommunicationContacts (
    id uniqueidentifier NOT NULL CONSTRAINT PK_CommunicationContacts PRIMARY KEY,
    organization_id nvarchar(32) NOT NULL CONSTRAINT FK_CommunicationContacts_Organizations REFERENCES dbo.Organizations(id),
    user_id uniqueidentifier NULL CONSTRAINT FK_CommunicationContacts_Users REFERENCES dbo.Users(id),
    email nvarchar(320) NOT NULL,
    display_name nvarchar(200) NOT NULL,
    locale nvarchar(12) NOT NULL CONSTRAINT DF_CommunicationContacts_Locale DEFAULT 'en',
    topics_json nvarchar(max) NOT NULL CONSTRAINT CK_CommunicationContacts_Topics CHECK (ISJSON(topics_json)=1),
    status nvarchar(32) NOT NULL CONSTRAINT DF_CommunicationContacts_Status DEFAULT 'Active'
      CONSTRAINT CK_CommunicationContacts_Status CHECK (status IN ('Active','Unsubscribed','Bounced')),
    source nvarchar(32) NOT NULL CONSTRAINT CK_CommunicationContacts_Source CHECK (source IN ('Admin','Company admin','Import','Webhook')),
    note nvarchar(500) NULL,
    created_by_user_id uniqueidentifier NOT NULL CONSTRAINT FK_CommunicationContacts_CreatedBy REFERENCES dbo.Users(id),
    created_at datetime2 NOT NULL CONSTRAINT DF_CommunicationContacts_CreatedAt DEFAULT SYSUTCDATETIME(),
    updated_at datetime2 NOT NULL CONSTRAINT DF_CommunicationContacts_UpdatedAt DEFAULT SYSUTCDATETIME(),
    deleted_at datetime2 NULL
  );
  CREATE UNIQUE INDEX UQ_CommunicationContacts_Org_Email ON dbo.CommunicationContacts(organization_id,email) WHERE deleted_at IS NULL;
  CREATE INDEX IX_CommunicationContacts_Email ON dbo.CommunicationContacts(email) WHERE deleted_at IS NULL;
END

IF OBJECT_ID('dbo.CommunicationSuppressions','U') IS NULL
BEGIN
  CREATE TABLE dbo.CommunicationSuppressions (
    email nvarchar(320) NOT NULL CONSTRAINT PK_CommunicationSuppressions PRIMARY KEY,
    reason nvarchar(32) NOT NULL CONSTRAINT CK_CommunicationSuppressions_Reason CHECK (reason IN ('Unsubscribed','Bounced','SpamReport','Manual')),
    source nvarchar(32) NOT NULL CONSTRAINT CK_CommunicationSuppressions_Source CHECK (source IN ('Webhook','Admin')),
    note nvarchar(500) NULL,
    created_by_user_id uniqueidentifier NULL CONSTRAINT FK_CommunicationSuppressions_CreatedBy REFERENCES dbo.Users(id),
    created_at datetime2 NOT NULL CONSTRAINT DF_CommunicationSuppressions_CreatedAt DEFAULT SYSUTCDATETIME()
  );
END

IF OBJECT_ID('dbo.Communications','U') IS NULL
BEGIN
  CREATE TABLE dbo.Communications (
    id uniqueidentifier NOT NULL CONSTRAINT PK_Communications PRIMARY KEY,
    public_id nvarchar(32) NOT NULL CONSTRAINT UQ_Communications_PublicId UNIQUE,
    template_key nvarchar(40) NOT NULL,
    topic nvarchar(40) NOT NULL,
    title nvarchar(200) NOT NULL,
    content_json nvarchar(max) NOT NULL CONSTRAINT CK_Communications_Content CHECK (ISJSON(content_json)=1),
    audience_json nvarchar(max) NOT NULL CONSTRAINT CK_Communications_Audience CHECK (ISJSON(audience_json)=1),
    status nvarchar(32) NOT NULL CONSTRAINT DF_Communications_Status DEFAULT 'Draft'
      CONSTRAINT CK_Communications_Status CHECK (status IN ('Draft','Scheduled','Sending','Sent','Cancelled')),
    scheduled_at datetime2 NULL,
    started_at datetime2 NULL,
    completed_at datetime2 NULL,
    cancelled_at datetime2 NULL,
    recipient_count int NOT NULL CONSTRAINT DF_Communications_RecipientCount DEFAULT 0,
    release_public_id nvarchar(32) NULL,
    created_by_user_id uniqueidentifier NOT NULL CONSTRAINT FK_Communications_CreatedBy REFERENCES dbo.Users(id),
    updated_by_user_id uniqueidentifier NULL CONSTRAINT FK_Communications_UpdatedBy REFERENCES dbo.Users(id),
    sent_by_user_id uniqueidentifier NULL CONSTRAINT FK_Communications_SentBy REFERENCES dbo.Users(id),
    created_at datetime2 NOT NULL CONSTRAINT DF_Communications_CreatedAt DEFAULT SYSUTCDATETIME(),
    updated_at datetime2 NOT NULL CONSTRAINT DF_Communications_UpdatedAt DEFAULT SYSUTCDATETIME(),
    deleted_at datetime2 NULL,
    row_version rowversion
  );
  CREATE INDEX IX_Communications_Status ON dbo.Communications(status,scheduled_at) WHERE deleted_at IS NULL;
END

IF OBJECT_ID('dbo.CommunicationDeliveries','U') IS NULL
BEGIN
  CREATE TABLE dbo.CommunicationDeliveries (
    id uniqueidentifier NOT NULL CONSTRAINT PK_CommunicationDeliveries PRIMARY KEY,
    communication_id uniqueidentifier NOT NULL CONSTRAINT FK_CommunicationDeliveries_Communications REFERENCES dbo.Communications(id),
    organization_id nvarchar(32) NULL CONSTRAINT FK_CommunicationDeliveries_Organizations REFERENCES dbo.Organizations(id),
    email nvarchar(320) NOT NULL,
    display_name nvarchar(200) NULL,
    locale nvarchar(12) NOT NULL,
    source nvarchar(16) NOT NULL CONSTRAINT CK_CommunicationDeliveries_Source CHECK (source IN ('Member','Contact','Test')),
    user_id uniqueidentifier NULL,
    contact_id uniqueidentifier NULL,
    state nvarchar(32) NOT NULL CONSTRAINT DF_CommunicationDeliveries_State DEFAULT 'Queued'
      CONSTRAINT CK_CommunicationDeliveries_State CHECK (state IN ('Queued','Processing','Retry','Accepted','Delivered','Deferred','Bounced','Dropped','Dead letter','Suppressed','Cancelled')),
    suppressed_reason nvarchar(40) NULL,
    attempt_count int NOT NULL CONSTRAINT DF_CommunicationDeliveries_Attempts DEFAULT 0,
    next_attempt_at datetime2 NULL,
    provider_message_id nvarchar(200) NULL,
    last_event nvarchar(32) NULL,
    last_event_at datetime2 NULL,
    opened_at datetime2 NULL,
    clicked_at datetime2 NULL,
    last_error_code nvarchar(100) NULL,
    created_at datetime2 NOT NULL CONSTRAINT DF_CommunicationDeliveries_CreatedAt DEFAULT SYSUTCDATETIME(),
    accepted_at datetime2 NULL,
    CONSTRAINT UQ_CommunicationDeliveries_Recipient UNIQUE(communication_id,email,source)
  );
  CREATE INDEX IX_CommunicationDeliveries_Work ON dbo.CommunicationDeliveries(state,next_attempt_at,created_at)
    INCLUDE(communication_id,locale,attempt_count,source);
  CREATE INDEX IX_CommunicationDeliveries_Accepted ON dbo.CommunicationDeliveries(accepted_at) WHERE accepted_at IS NOT NULL;
END

IF OBJECT_ID('dbo.CommunicationEvents','U') IS NULL
BEGIN
  CREATE TABLE dbo.CommunicationEvents (
    sg_event_id nvarchar(100) NOT NULL CONSTRAINT PK_CommunicationEvents PRIMARY KEY,
    delivery_id uniqueidentifier NULL CONSTRAINT FK_CommunicationEvents_Deliveries REFERENCES dbo.CommunicationDeliveries(id),
    event nvarchar(32) NOT NULL,
    email nvarchar(320) NOT NULL,
    occurred_at datetime2 NOT NULL,
    reason nvarchar(500) NULL,
    payload_json nvarchar(max) NULL CONSTRAINT CK_CommunicationEvents_Payload CHECK (payload_json IS NULL OR ISJSON(payload_json)=1),
    received_at datetime2 NOT NULL CONSTRAINT DF_CommunicationEvents_ReceivedAt DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_CommunicationEvents_Received ON dbo.CommunicationEvents(received_at);
END

COMMIT TRANSACTION;
