import type { PulseIdentity } from "@/lib/domain";
import { getSqlPool, isAzureSqlConfigured, sql } from "../database";
import { users } from "../admin-repository";

export type ChatMessageRecord = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type ChatUserRecord = {
  id: string;
  email: string;
  name: string;
  status: string;
};

declare global {
  var pulseMemoryChatMessages: Map<string, ChatMessageRecord[]> | undefined;
}

function chatMessages() {
  globalThis.pulseMemoryChatMessages ||= new Map();
  return globalThis.pulseMemoryChatMessages;
}

export async function appendChatMessage(
  identity: PulseIdentity,
  role: "user" | "assistant",
  content: string,
): Promise<ChatMessageRecord> {
  const record: ChatMessageRecord = {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
  if (!isAzureSqlConfigured()) {
    const list = chatMessages().get(identity.id) || [];
    list.push(record);
    chatMessages().set(identity.id, list);
    return record;
  }
  const pool = await getSqlPool();
  await pool
    .request()
    .input("id", sql.UniqueIdentifier, record.id)
    .input("userId", sql.UniqueIdentifier, identity.id)
    .input("role", sql.NVarChar(16), role)
    .input("content", sql.NVarChar(sql.MAX), content)
    .query(
      "INSERT INTO dbo.ChatMessages (id, user_id, role, content) VALUES (@id, @userId, @role, @content)",
    );
  return record;
}

export async function getChatHistory(
  identity: PulseIdentity,
  take = 30,
): Promise<ChatMessageRecord[]> {
  if (!isAzureSqlConfigured()) {
    const list = chatMessages().get(identity.id) || [];
    return list.slice(Math.max(0, list.length - take));
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .input("take", sql.Int, take)
    .query(
      "SELECT TOP (@take) id, role, content, created_at AS createdAt FROM dbo.ChatMessages WHERE user_id = @userId ORDER BY created_at DESC, id DESC",
    );
  return result.recordset.reverse();
}

export async function clearChatHistory(identity: PulseIdentity): Promise<void> {
  if (!isAzureSqlConfigured()) {
    chatMessages().delete(identity.id);
    return;
  }
  const pool = await getSqlPool();
  await pool
    .request()
    .input("userId", sql.UniqueIdentifier, identity.id)
    .query("DELETE FROM dbo.ChatMessages WHERE user_id = @userId");
}

export async function getUserByEmail(
  email: string,
): Promise<ChatUserRecord | null> {
  if (!isAzureSqlConfigured()) {
    const found = users().find(
      (value) => value.email.toLowerCase() === email.toLowerCase(),
    );
    return found
      ? { id: found.id, email: found.email, name: found.name, status: found.status }
      : null;
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("email", sql.NVarChar(320), email)
    .query(
      "SELECT id, email, display_name AS name, status FROM dbo.Users WHERE email = @email",
    );
  return result.recordset[0] || null;
}

export async function getUserById(
  id: string,
): Promise<ChatUserRecord | null> {
  if (!isAzureSqlConfigured()) {
    const found = users().find((value) => value.id === id);
    return found
      ? { id: found.id, email: found.email, name: found.name, status: found.status }
      : null;
  }
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .query(
      "SELECT id, email, display_name AS name, status FROM dbo.Users WHERE id = @id",
    );
  return result.recordset[0] || null;
}
