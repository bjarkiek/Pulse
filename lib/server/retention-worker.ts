import { deleteBlob, isBlobStorageConfigured } from "./blob-storage";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";
import { getRuntimeSettings } from "./settings-repository";

export async function processRetentionBatch(limit = 50) {
  if (!isAzureSqlConfigured())
    return { attachmentsDeleted: 0, recordsDeleted: 0, skipped: true };
  if (!isBlobStorageConfigured())
    throw new Error("AZURE_STORAGE_NOT_CONFIGURED");
  const settings = await getRuntimeSettings();
  const cutoff = new Date(Date.now() - settings.retentionDays * 86_400_000);
  const batchSize = Math.min(Math.max(limit, 1), 250);
  const pool = await getSqlPool();
  const attachments = await pool
    .request()
    .input("cutoff", sql.DateTime2, cutoff)
    .input("limit", sql.Int, batchSize).query(`
      SELECT TOP (@limit) CAST(a.id AS nvarchar(36)) id,a.storage_key storageKey
      FROM dbo.Attachments a
      JOIN dbo.Requests r ON r.id=a.request_id
      WHERE (a.deleted_at IS NOT NULL AND a.deleted_at<@cutoff)
        OR (r.deleted_at IS NOT NULL AND r.deleted_at<@cutoff)
      ORDER BY COALESCE(a.deleted_at,r.deleted_at);`);

  let attachmentsDeleted = 0;
  for (const attachment of attachments.recordset) {
    await deleteBlob(attachment.storageKey);
    const deleted = await pool
      .request()
      .input("id", sql.UniqueIdentifier, attachment.id)
      .input("cutoff", sql.DateTime2, cutoff).query(`
        DELETE FROM dbo.CommentAttachments WHERE attachment_id=@id;
        DELETE a OUTPUT DELETED.id
        FROM dbo.Attachments a JOIN dbo.Requests r ON r.id=a.request_id
        WHERE a.id=@id AND ((a.deleted_at IS NOT NULL AND a.deleted_at<@cutoff)
          OR (r.deleted_at IS NOT NULL AND r.deleted_at<@cutoff));`);
    attachmentsDeleted += deleted.recordset.length;
  }

  const cleanup = await pool
    .request()
    .input("cutoff", sql.DateTime2, cutoff)
    .input("limit", sql.Int, batchSize).query(`
      DECLARE @deleted int=0;

      DELETE ca FROM dbo.CommentAttachments ca JOIN dbo.Comments c ON c.id=ca.comment_id
        WHERE c.deleted_at IS NOT NULL AND c.deleted_at<@cutoff;
      DELETE TOP (@limit) cr FROM dbo.CommentRevisions cr
        JOIN dbo.Comments c ON c.id=cr.comment_id
        WHERE c.deleted_at IS NOT NULL AND c.deleted_at<@cutoff;
      SET @deleted+=@@ROWCOUNT;
      DELETE TOP (@limit) FROM dbo.Comments WHERE deleted_at IS NOT NULL AND deleted_at<@cutoff;
      SET @deleted+=@@ROWCOUNT;
      DELETE TOP (@limit) FROM dbo.SavedViews WHERE deleted_at IS NOT NULL AND deleted_at<@cutoff;
      SET @deleted+=@@ROWCOUNT;

      DECLARE @requests TABLE(id uniqueidentifier PRIMARY KEY,organization_id nvarchar(32));
      INSERT @requests SELECT TOP (@limit) id,organization_id FROM dbo.Requests r
        WHERE deleted_at IS NOT NULL AND deleted_at<@cutoff
          AND NOT EXISTS(SELECT 1 FROM dbo.Attachments a WHERE a.request_id=r.id);
      DELETE cr FROM dbo.CommentRevisions cr JOIN dbo.Comments c ON c.id=cr.comment_id
        JOIN @requests r ON c.parent_type='Request' AND c.parent_id=r.id;
      DELETE ca FROM dbo.CommentAttachments ca JOIN dbo.Comments c ON c.id=ca.comment_id
        JOIN @requests r ON c.parent_type='Request' AND c.parent_id=r.id;
      DELETE c FROM dbo.Comments c JOIN @requests r ON c.parent_type='Request' AND c.parent_id=r.id;
      DELETE rt FROM dbo.RequestTags rt JOIN @requests r ON r.id=rt.request_id;
      DELETE l FROM dbo.RequestIdeaLinks l JOIN @requests r ON r.id=l.request_id;
      UPDATE oi SET active=CASE WHEN EXISTS(
        SELECT 1 FROM dbo.RequestIdeaLinks l JOIN dbo.Requests r ON r.id=l.request_id
        WHERE l.idea_id=oi.idea_id AND l.active=1 AND r.organization_id=oi.organization_id AND r.deleted_at IS NULL
      ) THEN 1 ELSE 0 END,updated_at=SYSUTCDATETIME()
      FROM dbo.OrganizationInterests oi
      WHERE EXISTS(SELECT 1 FROM @requests r WHERE r.organization_id=oi.organization_id);
      DELETE rr FROM dbo.RequestRevisions rr JOIN @requests r ON r.id=rr.request_id;
      DELETE r FROM dbo.Requests r JOIN @requests d ON d.id=r.id;
      SET @deleted+=@@ROWCOUNT;

      DECLARE @ideas TABLE(id uniqueidentifier PRIMARY KEY);
      INSERT @ideas SELECT TOP (@limit) id FROM dbo.Ideas
        WHERE deleted_at IS NOT NULL AND deleted_at<@cutoff;
      DELETE cr FROM dbo.CommentRevisions cr JOIN dbo.Comments c ON c.id=cr.comment_id
        JOIN @ideas i ON c.parent_type='Idea' AND c.parent_id=i.id;
      DELETE ca FROM dbo.CommentAttachments ca JOIN dbo.Comments c ON c.id=ca.comment_id
        JOIN @ideas i ON c.parent_type='Idea' AND c.parent_id=i.id;
      DELETE c FROM dbo.Comments c JOIN @ideas i ON c.parent_type='Idea' AND c.parent_id=i.id;
      DELETE a FROM dbo.IdeaAliases a JOIN @ideas i ON i.id=a.surviving_idea_id;
      DELETE l FROM dbo.RequestIdeaLinks l JOIN @ideas i ON i.id=l.idea_id;
      DELETE oi FROM dbo.OrganizationInterests oi JOIN @ideas i ON i.id=oi.idea_id;
      DELETE f FROM dbo.Follows f JOIN @ideas i ON i.id=f.idea_id;
      DELETE s FROM dbo.ScoreSnapshots s JOIN @ideas i ON i.id=s.idea_id;
      DELETE rp FROM dbo.RoadmapPlacements rp JOIN @ideas i ON i.id=rp.idea_id;
      DELETE ri FROM dbo.ReleaseIdeas ri JOIN @ideas i ON i.id=ri.idea_id;
      DELETE el FROM dbo.ExternalLinks el JOIN @ideas i ON i.id=el.idea_id;
      DELETE i FROM dbo.Ideas i JOIN @ideas d ON d.id=i.id;
      SET @deleted+=@@ROWCOUNT;

      SELECT @deleted recordsDeleted;`);
  return {
    attachmentsDeleted,
    recordsDeleted: Number(cleanup.recordset[0]?.recordsDeleted || 0),
    skipped: false,
  };
}
