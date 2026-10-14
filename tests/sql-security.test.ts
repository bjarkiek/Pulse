import { deliveryStatus, retryDeliveries } from "../lib/server/delivery-status";
import {
  createRequest,
  requestAttachmentBytes,
} from "../lib/server/request-repository";
import { addVersions, checkedMutation } from "../lib/server/versions";
import { setAttachmentState } from "../lib/server/request-repository";
import { createRequire } from "node:module";
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, atomicSql, getSqlPool } from "../lib/server/database";
import { issueOtpCode, verifyOtpCode } from "../lib/server/otp-login";
import { executeIdempotent } from "../lib/server/idempotency";
import { requireActiveAccount } from "../lib/server/active-account";
import {
  listNotificationPreferences,
  saveNotificationPreference,
} from "../lib/server/notification-preference-repository";
import type { PulseIdentity } from "../lib/domain";

// Explicit opt-in: use only a disposable database with migrations 001-014 applied.
const enabled = process.env.PULSE_SQL_TEST === "1";
const org = `test-${randomUUID().slice(0, 16)}`;
const identity: PulseIdentity = {
  id: randomUUID(),
  email: `${org}@example.test`,
  name: "SQL fixture",
  organizationId: org,
  role: "Customer contributor",
  isInternal: false,
  authMethod: "otp",
  sessionIssuedAt: Date.now(),
};
let pool: import("mssql").ConnectionPool;
before(async () => {
  if (!enabled) return;
  if (process.env.PULSE_SQL_NATIVE === "1") {
    const native = createRequire(import.meta.url)("mssql/msnodesqlv8");
    Object.assign(sql, {
      ConnectionPool: native.ConnectionPool,
      Transaction: native.Transaction,
      Request: native.Request,
    });
    pool = await new native.ConnectionPool({
      connectionString: process.env.PULSE_TEST_SQL_CONNECTION_STRING,
    }).connect();
  } else {
    pool = await new sql.ConnectionPool(
      process.env.PULSE_TEST_SQL_CONNECTION_STRING!,
    ).connect();
  }
  process.env.AZURE_SQL_SERVER = "isolated-test-fixture";
  globalThis.pulseSqlPool = Promise.resolve(pool);
  await pool
    .request()
    .input("org", org)
    .input("id", sql.UniqueIdentifier, identity.id)
    .input("email", identity.email).query(`
    INSERT dbo.Organizations(id,name,type) VALUES(@org,'SQL fixture','Customer');
    INSERT dbo.Users(id,email,display_name,auth_method) VALUES(@id,@email,'SQL fixture','OTP');
    INSERT dbo.Memberships(id,user_id,organization_id,role) VALUES(NEWID(),@id,@org,'Customer contributor');`);
});
after(async () => {
  if (!pool) return;
  await pool
    .request()
    .input("org", org)
    .input("id", sql.UniqueIdentifier, identity.id)
    .input("email", identity.email).query(`
    DELETE dbo.AuditEvents WHERE actor_user_id=@id;
    DELETE dbo.Notifications WHERE user_id=@id;
    DELETE dbo.NotificationPreferences WHERE user_id=@id;
    DELETE dbo.Attachments WHERE organization_id=@org;
    DELETE dbo.Requests WHERE organization_id=@org;
    DELETE dbo.IdempotencyKeys WHERE organization_id=@org;
    DELETE dbo.OtpCodes WHERE email=@email;
    DELETE dbo.Memberships WHERE user_id=@id;
    DELETE dbo.Users WHERE id=@id;
    DELETE dbo.Organizations WHERE id=@org;`);
  await pool.close();
  globalThis.pulseSqlPool = undefined;
});
const sqlTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !enabled }, fn);
sqlTest("SQL unit of work rolls back repository requests", async () => {
  await assert.rejects(
    atomicSql(async () => {
      await (
        await getSqlPool()
      )
        .request()
        .input("id", sql.UniqueIdentifier, identity.id)
        .query(
          "UPDATE dbo.Users SET display_name='should rollback' WHERE id=@id",
        );
      throw new Error("simulated crash");
    }),
    /simulated crash/,
  );
  const row = await pool
    .request()
    .input("id", sql.UniqueIdentifier, identity.id)
    .query("SELECT display_name name FROM dbo.Users WHERE id=@id");
  assert.equal(row.recordset[0].name, "SQL fixture");
});
sqlTest(
  "SQL idempotency binds body, reauthorizes replays and commits work atomically",
  async () => {
    const req = (body = { value: 1 }) =>
      new Request("https://pulse.test/api/v1/requests", {
        method: "POST",
        headers: { "idempotency-key": "sql-test-key" },
        body: JSON.stringify(body),
      });
    let calls = 0;
    const work = async () => {
      calls++;
      return { id: "result" };
    };
    assert.equal(
      (await executeIdempotent(req(), identity, "request.create", 201, work))
        .replayed,
      false,
    );
    assert.equal(
      (await executeIdempotent(req(), identity, "request.create", 201, work))
        .replayed,
      true,
    );
    assert.equal(calls, 1);
    await assert.rejects(
      executeIdempotent(
        req({ value: 2 }),
        identity,
        "request.create",
        201,
        work,
      ),
      /IDEMPOTENCY_CONFLICT/,
    );
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, identity.id)
      .query("UPDATE dbo.Users SET status='Disabled' WHERE id=@id");
    await assert.rejects(
      executeIdempotent(req(), identity, "request.create", 201, work),
      /FORBIDDEN/,
    );
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, identity.id)
      .query("UPDATE dbo.Users SET status='Active' WHERE id=@id");
    const crash = new Request(req(), {
      headers: { "idempotency-key": "sql-crash-key" },
    });
    await assert.rejects(
      executeIdempotent(crash, identity, "request.create", 201, async () => {
        await (
          await getSqlPool()
        )
          .request()
          .input("id", sql.UniqueIdentifier, identity.id)
          .query(
            "UPDATE dbo.Users SET display_name='uncommitted' WHERE id=@id",
          );
        throw new Error("crash before response");
      }),
      /crash before response/,
    );
    const row = await pool
      .request()
      .input("id", sql.UniqueIdentifier, identity.id)
      .query("SELECT display_name name FROM dbo.Users WHERE id=@id");
    assert.equal(row.recordset[0].name, "SQL fixture");
  },
);
sqlTest(
  "SQL OTP concurrent redemption succeeds once and issuance stays limited",
  async () => {
    const { code } = await issueOtpCode(identity.email);
    const verdicts = await Promise.all(
      Array.from({ length: 6 }, () => verifyOtpCode(identity.email, code)),
    );
    assert.equal(verdicts.filter((v) => v === "ok").length, 1);
    const issues = await Promise.allSettled(
      Array.from({ length: 5 }, () => issueOtpCode(identity.email)),
    );
    assert.equal(issues.filter((v) => v.status === "fulfilled").length, 2);
  },
);
sqlTest(
  "SQL session revocation rejects old sessions after reactivation",
  async () => {
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, identity.id)
      .query(
        "UPDATE dbo.Users SET tokens_valid_after=DATEADD(second,1,SYSUTCDATETIME()) WHERE id=@id",
      );
    await assert.rejects(requireActiveAccount(identity), /UNAUTHORIZED/);
  },
);

sqlTest(
  "SQL version checks serialize edits and reject a stale observation",
  async () => {
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, identity.id)
      .query("UPDATE dbo.Users SET tokens_valid_after=NULL WHERE id=@id");
    const id = `DCI-${Date.now()}`;
    await pool
      .request()
      .input("id", id)
      .input("org", org)
      .input("user", sql.UniqueIdentifier, identity.id)
      .query(
        "INSERT dbo.Requests(id,public_id,organization_id,created_by_user_id,title,problem) VALUES(NEWID(),@id,@org,@user,'Version fixture','Fixture')",
      );
    const [observed] = await addVersions("Requests", [{ id }]);
    // A client sends the version back in If-Match, so it has to be text a header can carry: 0x and sixteen hexadecimal digits.
    assert.match(observed.version, /^0x[0-9A-F]{16}$/);
    const edit = () =>
      checkedMutation(identity, "Requests", id, observed.version, async () => {
        await (
          await getSqlPool()
        )
          .request()
          .input("id", id)
          .query("UPDATE dbo.Requests SET title='Updated' WHERE public_id=@id");
      });
    const results = await Promise.allSettled([edit(), edit()]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.match(
      String(
        (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
          .reason,
      ),
      /PRECONDITION_FAILED/,
    );
  },
);
sqlTest(
  "SQL the first save of a notification preference is audited without a before-image, and the next one carries it",
  async () => {
    // The audit columns take JSON objects only (ISJSON), and the text "null" is not one: with no earlier choice there is no before-image.
    const eventType = "communication.service-notices";
    const first = await saveNotificationPreference(identity, eventType, "Off");
    assert.equal(first.cadence, "Off");
    const second = await saveNotificationPreference(
      identity,
      eventType,
      "Immediate",
    );
    assert.equal(second.cadence, "Immediate");
    const audit = await pool
      .request()
      .input("id", sql.UniqueIdentifier, identity.id)
      .query(
        "SELECT before_json before,after_json after FROM dbo.AuditEvents WHERE actor_user_id=@id AND action='notification.preference.updated'",
      );
    assert.equal(audit.recordset.length, 2);
    const created = audit.recordset.find((row) => row.before === null);
    const changed = audit.recordset.find((row) => row.before !== null);
    assert.deepEqual(JSON.parse(created.after), { eventType, cadence: "Off" });
    assert.deepEqual(JSON.parse(changed.before), { cadence: "Off" });
    assert.deepEqual(JSON.parse(changed.after), {
      eventType,
      cadence: "Immediate",
    });
    const stored = (await listNotificationPreferences(identity)).find(
      (preference) => preference.eventType === eventType,
    );
    assert.equal(stored?.cadence, "Immediate");
  },
);
sqlTest(
  "SQL scanner rejects stale verdicts and terminal-state reversal",
  async () => {
    const id = randomUUID();
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .input("org", org)
      .input("user", sql.UniqueIdentifier, identity.id).query(`
  INSERT dbo.Attachments(id,request_id,organization_id,uploaded_by_user_id,storage_key,file_name,content_type,size_bytes,scan_state,visibility)
  SELECT TOP(1) @id,id,@org,@user,CONVERT(nvarchar(36),@id),'fixture.pdf','application/pdf',10,'Pending upload','Organization' FROM dbo.Requests WHERE organization_id=@org;
 `);
    await setAttachmentState(id, "Scanning", '"original"');
    await assert.rejects(
      setAttachmentState(id, "Clean", '"replacement"'),
      /ATTACHMENT_VERSION_CONFLICT/,
    );
    await setAttachmentState(id, "Clean", '"original"');
    await setAttachmentState(id, "Clean", '"original"');
    await assert.rejects(
      setAttachmentState(id, "Scanning", '"replacement"'),
      /ATTACHMENT_VERSION_CONFLICT/,
    );
    const row = await pool
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .query(
        "SELECT scan_state state,upload_etag etag FROM dbo.Attachments WHERE id=@id",
      );
    assert.equal(row.recordset[0].state, "Clean");
    assert.equal(row.recordset[0].etag, '"original"');
  },
);

sqlTest(
  "SQL real request creation rolls back with its replay result",
  async () => {
    const title = "Transaction rollback fixture";
    const body = {
      title,
      problem: "Fixture",
      area: "Distribution",
      impact: "High",
      visibility: "Organization" as const,
    };
    await assert.rejects(
      executeIdempotent(
        new Request("https://pulse.test/api/v1/requests", {
          method: "POST",
          headers: { "idempotency-key": "full-business-rollback" },
          body: JSON.stringify(body),
        }),
        identity,
        "request.create",
        201,
        async () => {
          await createRequest(identity, body);
          throw new Error("after business write");
        },
      ),
      /after business write/,
    );
    const rows = await pool
      .request()
      .input("org", org)
      .input("title", title)
      .query(
        "SELECT COUNT(*) count FROM dbo.Requests WHERE organization_id=@org AND title=@title",
      );
    assert.equal(rows.recordset[0].count, 0);
  },
);
sqlTest(
  "SQL concurrent attachment reservations cannot exceed the request quota",
  async () => {
    const rows = await pool
      .request()
      .input("org", org)
      .query(
        "SELECT TOP(1) public_id id FROM dbo.Requests WHERE organization_id=@org",
      );
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        requestAttachmentBytes(identity, rows.recordset[0].id, {
          fileName: `quota-${i}.pdf`,
          contentType: "application/pdf",
          sizeBytes: 25 * 1024 * 1024,
        }),
      ),
    );
    // The earlier scanner fixture consumes ten bytes, leaving room for three full files.
    assert.equal(
      outcomes.filter((o) => o.status === "fulfilled").length,
      3,
      JSON.stringify(
        outcomes
          .filter((o) => o.status === "rejected")
          .map((o) => String((o as PromiseRejectedResult).reason)),
      ),
    );
    const total = await pool
      .request()
      .input("org", org)
      .query(
        "SELECT SUM(size_bytes) bytes FROM dbo.Attachments WHERE organization_id=@org AND deleted_at IS NULL",
      );
    assert.ok(Number(total.recordset[0].bytes) <= 100 * 1024 * 1024);
  },
);

sqlTest(
  "SQL delivery retry requires an administrator and only requeues dead letters",
  async () => {
    await assert.rejects(deliveryStatus(identity), /FORBIDDEN/);
    await assert.rejects(
      retryDeliveries(identity, "Email", randomUUID()),
      /FORBIDDEN/,
    );
    await pool
      .request()
      .input("org", org)
      .input("user", sql.UniqueIdentifier, identity.id).query(`
    UPDATE dbo.Organizations SET type='Internal' WHERE id=@org;
    UPDATE dbo.Memberships SET role='System admin' WHERE user_id=@user;
    INSERT dbo.Notifications(id,user_id,organization_id,event_type,channel,template,state,deduplication_key,attempt_count)
    VALUES(NEWID(),@user,@org,'test','Email','fixture','Dead letter','dead',5),(NEWID(),@user,@org,'test','Email','fixture','Delivered','sent',1);
  `);
    try {
      const before = await deliveryStatus(identity);
      assert.ok(
        before.some(
          (r) =>
            r.channel === "Email" && r.state === "Dead letter" && r.count >= 1,
        ),
      );
      const result = await retryDeliveries(identity, "Email", randomUUID());
      assert.equal(result.requeued, 1);
      const rows = (
        await pool
          .request()
          .input("user", sql.UniqueIdentifier, identity.id)
          .query(
            "SELECT state,attempt_count attempts,deduplication_key keyName FROM dbo.Notifications WHERE user_id=@user",
          )
      ).recordset;
      assert.equal(rows.find((r) => r.keyName === "dead").state, "Retry");
      assert.equal(rows.find((r) => r.keyName === "dead").attempts, 0);
      assert.equal(rows.find((r) => r.keyName === "sent").state, "Delivered");
    } finally {
      await pool
        .request()
        .input("org", org)
        .input("user", sql.UniqueIdentifier, identity.id)
        .query(
          "UPDATE dbo.Organizations SET type='Customer' WHERE id=@org; UPDATE dbo.Memberships SET role='Customer contributor' WHERE user_id=@user;",
        );
    }
  },
);
