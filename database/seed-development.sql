SET NOCOUNT ON;
DECLARE @UserId uniqueidentifier='11111111-1111-4111-8111-111111111111';
IF NOT EXISTS (SELECT 1 FROM dbo.Organizations WHERE id='ORG-001')
  INSERT dbo.Organizations(id,name,type,verified_domain) VALUES('ORG-001','Origo','Customer','origo.is');
IF NOT EXISTS (SELECT 1 FROM dbo.Organizations WHERE id='ORG-INTERNAL')
  INSERT dbo.Organizations(id,name,type,verified_domain) VALUES('ORG-INTERNAL','DataCentral','Internal','datacentral.is');
IF NOT EXISTS (SELECT 1 FROM dbo.Users WHERE id=@UserId)
  INSERT dbo.Users(id,email,display_name,status,auth_method) VALUES(@UserId,'bjarki@uidata.com',N'Bjarki Kristjánsson','Active','Entra ID');
IF NOT EXISTS (SELECT 1 FROM dbo.Memberships WHERE user_id=@UserId AND organization_id='ORG-001')
  INSERT dbo.Memberships(id,user_id,organization_id,role,status) VALUES(NEWID(),@UserId,'ORG-001','Company admin','Active');
IF NOT EXISTS (SELECT 1 FROM dbo.Memberships WHERE user_id=@UserId AND organization_id='ORG-INTERNAL')
  INSERT dbo.Memberships(id,user_id,organization_id,role,status) VALUES(NEWID(),@UserId,'ORG-INTERNAL','System admin','Active');
