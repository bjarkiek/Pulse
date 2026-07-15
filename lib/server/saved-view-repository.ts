import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "./authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";

export type SavedView = {
  id: string;
  name: string;
  scope: "Private" | "Internal shared";
  resourceType: "Requests" | "Ideas" | "Roadmap";
  query: Record<string, string | string[]>;
  ownerId: string;
};

declare global {
  var pulseMemorySavedViews: SavedView[] | undefined;
}

function views() {
  globalThis.pulseMemorySavedViews ||= [];
  return globalThis.pulseMemorySavedViews;
}

export async function listSavedViews(identity: PulseIdentity) {
  await requireInternalRole(identity);
  if (!isAzureSqlConfigured())
    return views().filter(
      (view) =>
        view.ownerId === identity.id || view.scope === "Internal shared",
    );
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .query(
      "SELECT CAST(id AS nvarchar(36)) id,name,scope,resource_type resourceType,query_json queryJson,CAST(owner_user_id AS nvarchar(36)) ownerId FROM dbo.SavedViews WHERE deleted_at IS NULL AND (owner_user_id=@userId OR scope='Internal shared') ORDER BY name",
    );
  return result.recordset.map((view) => ({
    ...view,
    query: JSON.parse(view.queryJson),
    queryJson: undefined,
  }));
}

export async function createSavedView(
  identity: PulseIdentity,
  input: Omit<SavedView, "id" | "ownerId">,
) {
  await requireInternalRole(identity);
  if (
    !input.name?.trim() ||
    input.name.length > 120 ||
    !["Private", "Internal shared"].includes(input.scope) ||
    !["Requests", "Ideas", "Roadmap"].includes(input.resourceType) ||
    !input.query ||
    Array.isArray(input.query)
  )
    throw new Error("INVALID_SAVED_VIEW");
  if (input.scope === "Internal shared")
    await requireInternalRole(identity, ["System admin"]);
  const item: SavedView = {
    ...input,
    id: crypto.randomUUID(),
    ownerId: identity.id,
    name: input.name.trim(),
  };
  if (!isAzureSqlConfigured()) {
    views().push(item);
    return item;
  }
  const pool = await getSqlPool();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, item.id)
    .input("owner", sql.UniqueIdentifier, identity.id)
    .input("name", sql.NVarChar(120), item.name)
    .input("scope", sql.NVarChar(32), item.scope)
    .input("resource", sql.NVarChar(32), item.resourceType)
    .input("query", sql.NVarChar(sql.MAX), JSON.stringify(item.query))
    .query(
      "INSERT dbo.SavedViews(id,owner_user_id,name,scope,resource_type,query_json) VALUES(@id,@owner,@name,@scope,@resource,@query)",
    );
  return item;
}

export async function deleteSavedView(identity: PulseIdentity, id: string) {
  const role = await requireInternalRole(identity);
  if (!isAzureSqlConfigured()) {
    const index = views().findIndex(
      (view) =>
        view.id === id &&
        (view.ownerId === identity.id || role === "System admin"),
    );
    if (index < 0) throw new Error("NOT_FOUND");
    views().splice(index, 1);
    return;
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .input("userId", sql.UniqueIdentifier, identity.id)
    .input("admin", sql.Bit, role === "System admin")
    .query(
      "UPDATE dbo.SavedViews SET deleted_at=SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id=@id AND deleted_at IS NULL AND (owner_user_id=@userId OR @admin=1)",
    );
  if (!result.recordset.length) throw new Error("NOT_FOUND");
}
