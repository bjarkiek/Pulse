import type { PulseIdentity } from "@/lib/domain";
import { atomicSql, getSqlPool, isContentSqlActive, sql } from "./database";
import { requireMembership, requirePublishRole } from "./authorization";

export type VersionedEntity = "Requests" | "Ideas" | "Releases" | "Communications";
const memoryVersions = new Map<string, number>();
const memoryLocks = new Set<string>();
export async function addVersions<T extends { id: string }>(
  entity: VersionedEntity,
  items: T[],
): Promise<(T & { version: string })[]> {
  if (!isContentSqlActive())
    return items.map((item) =>
      Object.assign(item, {
        version: String(memoryVersions.get(`${entity}:${item.id}`) || 1),
      }),
    );
  if (!items.length) return [];
  const result = await (
    await getSqlPool()
  )
    .request()
    .input("ids", sql.NVarChar(sql.MAX), JSON.stringify(items.map((i) => i.id)))
    .query(
      `SELECT public_id id,CONVERT(varchar(18),row_version,1) version FROM dbo.${entity} WHERE public_id IN (SELECT value FROM OPENJSON(@ids))`,
    );
  const versions = new Map<string, string>(
    result.recordset.map((r) => [r.id, r.version]),
  );
  return items.map((item) => ({
    ...item,
    version: versions.get(item.id) || "missing",
  }));
}
/** Check the caller's observed version while holding the same lock as the write. */
export async function checkedMutation<T>(
  identity: PulseIdentity,
  entity: VersionedEntity,
  id: string,
  expected: unknown,
  work: () => Promise<T>,
): Promise<T> {
  // The driver binds the id as NVarChar(32): a longer one belongs to no row and must not reach it, so it is refused before anything is asked.
  if (id.length > 32) throw new Error("NOT_FOUND");
  await requireMembership(identity);
  if (entity !== "Requests") await requirePublishRole(identity);
  else await (await import("./request-repository")).getRequest(identity, id);
  if (typeof expected !== "string" || !expected)
    throw new Error("PRECONDITION_REQUIRED");
  const version = expected.replace(/^"|"$/g, "");
  if (!isContentSqlActive()) {
    const key = `${entity}:${id}`;
    if (
      memoryLocks.has(key) ||
      version !== String(memoryVersions.get(key) || 1)
    )
      throw new Error("PRECONDITION_FAILED");
    memoryLocks.add(key);
    try {
      const result = await work();
      memoryVersions.set(key, (memoryVersions.get(key) || 1) + 1);
      if (result && typeof result === "object")
        Object.assign(result, { version: String(memoryVersions.get(key)) });
      return result;
    } finally {
      memoryLocks.delete(key);
    }
  }
  return atomicSql(async () => {
    const result = await (
      await getSqlPool()
    )
      .request()
      .input("id", sql.NVarChar(32), id)
      .input("org", sql.NVarChar(32), identity.organizationId)
      .query(
        `SELECT CONVERT(varchar(18),row_version,1) version FROM dbo.${entity} WITH (UPDLOCK,HOLDLOCK) WHERE public_id=@id ${entity === "Requests" ? "AND organization_id=@org AND deleted_at IS NULL" : ""}`,
      );
    if (!result.recordset.length) throw new Error("NOT_FOUND");
    if (result.recordset[0].version !== version)
      throw new Error("PRECONDITION_FAILED");
    const value = await work();
    if (value && typeof value === "object") {
      const [updated] = await addVersions(entity, [{ id }]);
      Object.assign(value, { version: updated.version });
    }
    return value;
  });
}
