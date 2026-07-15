import type { PulseIdentity } from "@/lib/domain";
import { requireInternalRole } from "./authorization";
import { getSqlPool, isAzureSqlConfigured, sql } from "./database";

export type TaxonomyValue = {
  id: string;
  kind:
    | "Product area"
    | "Request type"
    | "Tag"
    | "Strategic theme"
    | "Reason category";
  value: string;
  active: boolean;
  sortOrder: number;
};

const kinds = [
  "Product area",
  "Request type",
  "Tag",
  "Strategic theme",
  "Reason category",
];

declare global {
  var pulseMemoryTaxonomy: TaxonomyValue[] | undefined;
}

function values() {
  globalThis.pulseMemoryTaxonomy ||= [
    "Governance",
    "Distribution",
    "Administration",
    "Mobile",
  ].map((value, index) => ({
    id: crypto.randomUUID(),
    kind: "Product area" as const,
    value,
    active: true,
    sortOrder: index,
  }));
  return globalThis.pulseMemoryTaxonomy;
}

export async function listTaxonomy(identity: PulseIdentity) {
  await requireInternalRole(identity, ["System admin"]);
  if (!isAzureSqlConfigured()) return values();
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .query(
      "SELECT CAST(id AS nvarchar(36)) id,kind,value,active,sort_order sortOrder FROM dbo.TaxonomyValues ORDER BY kind,sort_order,value",
    );
  return result.recordset;
}

export async function saveTaxonomy(
  identity: PulseIdentity,
  input: TaxonomyValue,
) {
  await requireInternalRole(identity, ["System admin"]);
  if (
    !kinds.includes(input.kind) ||
    !input.value?.trim() ||
    input.value.length > 120 ||
    !Number.isInteger(input.sortOrder)
  )
    throw new Error("INVALID_TAXONOMY_VALUE");
  const id = /^[0-9a-f-]{36}$/i.test(input.id) ? input.id : crypto.randomUUID();
  const item = { ...input, id, value: input.value.trim() };
  if (!isAzureSqlConfigured()) {
    const index = values().findIndex((value) => value.id === id);
    if (index >= 0) values()[index] = item;
    else values().push(item);
    globalThis.pulseMemoryAudit ||= [];
    globalThis.pulseMemoryAudit.unshift({
      id: crypto.randomUUID(),
      actor: identity.name,
      action: "taxonomy.saved",
      entityType: "TaxonomyValue",
      entityId: id,
      after: item,
      correlationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    return item;
  }
  const pool = await getSqlPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    await new sql.Request(transaction)
      .input("id", sql.UniqueIdentifier, id)
      .input("kind", sql.NVarChar(40), item.kind)
      .input("value", sql.NVarChar(120), item.value)
      .input("active", sql.Bit, item.active)
      .input("sort", sql.Int, item.sortOrder)
      .input("actor", sql.UniqueIdentifier, identity.id).query(`
        MERGE dbo.TaxonomyValues target USING(SELECT @id id) source ON target.id=source.id
        WHEN MATCHED THEN UPDATE SET kind=@kind,value=@value,active=@active,sort_order=@sort,
          updated_by_user_id=@actor,updated_at=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT(id,kind,value,active,sort_order,updated_by_user_id)
          VALUES(@id,@kind,@value,@active,@sort,@actor);`);
    await new sql.Request(transaction)
      .input("auditId", sql.UniqueIdentifier, crypto.randomUUID())
      .input("actor", sql.UniqueIdentifier, identity.id)
      .input("entity", sql.UniqueIdentifier, id)
      .input("after", sql.NVarChar(sql.MAX), JSON.stringify(item))
      .input("correlation", sql.UniqueIdentifier, crypto.randomUUID())
      .query(
        "INSERT dbo.AuditEvents(id,actor_user_id,action,entity_type,entity_id,after_json,correlation_id) VALUES(@auditId,@actor,'taxonomy.saved','TaxonomyValue',@entity,@after,@correlation)",
      );
    await transaction.commit();
    return item;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
