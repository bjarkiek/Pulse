SET XACT_ABORT ON;
BEGIN TRANSACTION;

CREATE TABLE dbo.CommentAttachments (
  comment_id uniqueidentifier NOT NULL REFERENCES dbo.Comments(id),
  attachment_id uniqueidentifier NOT NULL REFERENCES dbo.Attachments(id),
  CONSTRAINT PK_CommentAttachments PRIMARY KEY(comment_id,attachment_id)
);

COMMIT TRANSACTION;
