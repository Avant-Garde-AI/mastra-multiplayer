/**
 * A durable `MultiplayerStore` on LibSQL / SQLite.
 *
 * LibSQL first because Mastra already leans on it, so a deployment that has
 * somewhere to put threads and messages usually has somewhere to put this too.
 *
 * `@libsql/client` is an optional peer dependency and is only imported by this
 * module — the core package stays dependency-free. The client is passed in
 * rather than constructed here, so connection lifetime, auth, and replication
 * stay the host application's business.
 *
 * ```ts
 * import { createClient } from "@libsql/client";
 * import { LibSQLMultiplayerStore } from "mastra-multiplayer/storage/libsql";
 *
 * const store = new LibSQLMultiplayerStore(createClient({ url: "file:./mp.db" }));
 * await store.migrate();
 * ```
 *
 * Correctness notes worth knowing before adapting this to another database:
 *
 * - **Presence is written here, and probably should not be in production.** A
 *   heartbeat per participant every ten seconds is a lot of writes for a table
 *   nothing durable depends on. Redis with a TTL is the better home; see
 *   docs/STORAGE.md.
 * - **Votes live inside the approval's JSON**, not a child table, because the
 *   gate reads and writes the request as one document. Normalizing them means
 *   `saveApproval` has to reconcile rather than replace.
 * - **`updateSession` must be able to clear a field.** A patch carrying
 *   `runningRunId: undefined` writes NULL; skipping undefined values would
 *   leave every session looking permanently busy.
 */
import type { MultiplayerStore } from "./index.js";
import type {
  ApprovalRequest,
  AuditEntry,
  Participant,
  ParticipantId,
  PresenceState,
  SessionId,
  SessionRecord,
} from "../types.js";

/**
 * The slice of `@libsql/client` used here, declared structurally so this file
 * compiles without the package installed — the same reason Mastra and Hono are
 * structural (docs/decisions/0004).
 */
export type LibSQLValue = string | number | bigint | boolean | null | Uint8Array;

export interface LibSQLLikeClient {
  execute(
    statement: string | { sql: string; args?: LibSQLValue[] },
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS multiplayer_sessions (
     id           TEXT PRIMARY KEY,
     thread_id    TEXT NOT NULL,
     agent_id     TEXT NOT NULL,
     title        TEXT,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL,
     running_run_id TEXT,
     metadata     TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS multiplayer_participants (
     session_id   TEXT NOT NULL,
     id           TEXT NOT NULL,
     display_name TEXT NOT NULL,
     role         TEXT NOT NULL,
     surface      TEXT NOT NULL,
     resource_id  TEXT,
     email        TEXT,
     avatar_url   TEXT,
     metadata     TEXT,
     PRIMARY KEY (session_id, id),
     FOREIGN KEY (session_id) REFERENCES multiplayer_sessions(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS multiplayer_presence (
     session_id     TEXT NOT NULL,
     participant_id TEXT NOT NULL,
     status         TEXT NOT NULL,
     last_seen_at   INTEGER NOT NULL,
     cursor         TEXT,
     PRIMARY KEY (session_id, participant_id),
     FOREIGN KEY (session_id) REFERENCES multiplayer_sessions(id) ON DELETE CASCADE
   )`,
  // The whole request is one document: the gate reads it, appends a vote, and
  // writes it back. Columns exist only for what is queried or filtered on.
  `CREATE TABLE IF NOT EXISTS multiplayer_approvals (
     id         TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     status     TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     document   TEXT NOT NULL,
     FOREIGN KEY (session_id) REFERENCES multiplayer_sessions(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS multiplayer_approvals_session
     ON multiplayer_approvals (session_id, status)`,
  // Append-only. Nothing in the interface updates or deletes an entry, and
  // nothing should — this is what answers "who approved the $4,000 refund".
  `CREATE TABLE IF NOT EXISTS multiplayer_audit (
     id         TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     action     TEXT NOT NULL,
     actor_id   TEXT,
     at         INTEGER NOT NULL,
     seq        INTEGER NOT NULL,
     detail     TEXT,
     FOREIGN KEY (session_id) REFERENCES multiplayer_sessions(id) ON DELETE CASCADE
   )`,
  // Ordered by (at, seq): timestamps collide at millisecond resolution, and a
  // ledger that reorders entries recorded in the same millisecond is not a
  // ledger.
  `CREATE INDEX IF NOT EXISTS multiplayer_audit_session
     ON multiplayer_audit (session_id, at, seq)`,
];

const json = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

const parse = <T,>(value: unknown): T | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const num = (value: unknown): number =>
  typeof value === "bigint" ? Number(value) : Number(value);

/** Drops keys whose value is undefined, so `{...record, ...maybe}` stays clean. */
function defined<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}

export class LibSQLMultiplayerStore implements MultiplayerStore {
  /**
   * Monotonic tiebreaker for audit entries recorded in the same millisecond.
   * Process-local, which is enough: it only orders entries that already share
   * a timestamp, and any total order among those is as true as another.
   */
  private auditSeq = 0;

  constructor(private readonly client: LibSQLLikeClient) {}

  /** Creates the tables if they do not exist. Safe to call on every boot. */
  async migrate(): Promise<void> {
    await this.client.execute("PRAGMA foreign_keys = ON");
    for (const statement of SCHEMA) await this.client.execute(statement);
  }

  /* ---------------------------------------------------------------- */
  /* Sessions                                                          */
  /* ---------------------------------------------------------------- */

  async createSession(session: SessionRecord): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO multiplayer_sessions
              (id, thread_id, agent_id, title, created_at, updated_at, running_run_id, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        session.id,
        session.threadId,
        session.agentId,
        session.title ?? null,
        session.createdAt,
        session.updatedAt,
        session.runningRunId ?? null,
        json(session.metadata),
      ],
    });
  }

  async getSession(id: SessionId): Promise<SessionRecord | null> {
    const { rows } = await this.client.execute({
      sql: `SELECT * FROM multiplayer_sessions WHERE id = ?`,
      args: [id],
    });
    const row = rows[0];
    return row ? this.toSession(row) : null;
  }

  async updateSession(
    id: SessionId,
    patch: Partial<Omit<SessionRecord, "id">>,
  ): Promise<void> {
    const columns: Record<keyof Omit<SessionRecord, "id">, string> = {
      threadId: "thread_id",
      agentId: "agent_id",
      title: "title",
      createdAt: "created_at",
      updatedAt: "updated_at",
      runningRunId: "running_run_id",
      metadata: "metadata",
    };

    const assignments: string[] = [];
    const args: LibSQLValue[] = [];

    // `Object.keys`, not a truthiness check: a patch that carries
    // `runningRunId: undefined` is *clearing* the field, and must write NULL.
    for (const key of Object.keys(patch) as Array<keyof typeof columns>) {
      if (key === "updatedAt") continue; // set below, unconditionally
      const value = patch[key];
      assignments.push(`${columns[key]} = ?`);
      args.push(key === "metadata" ? json(value) : ((value as LibSQLValue) ?? null));
    }

    assignments.push("updated_at = ?");
    args.push(patch.updatedAt ?? Date.now());
    args.push(id);

    await this.client.execute({
      sql: `UPDATE multiplayer_sessions SET ${assignments.join(", ")} WHERE id = ?`,
      args,
    });
  }

  async listSessions(): Promise<SessionRecord[]> {
    const { rows } = await this.client.execute(
      `SELECT * FROM multiplayer_sessions ORDER BY created_at`,
    );
    return rows.map((row) => this.toSession(row));
  }

  /* ---------------------------------------------------------------- */
  /* Participants                                                      */
  /* ---------------------------------------------------------------- */

  async addParticipant(sessionId: SessionId, participant: Participant): Promise<void> {
    await this.assertSession(sessionId);
    await this.client.execute({
      // Upsert: rejoining updates the display name and role rather than
      // duplicating the roster entry or failing.
      sql: `INSERT INTO multiplayer_participants
              (session_id, id, display_name, role, surface, resource_id, email, avatar_url, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (session_id, id) DO UPDATE SET
              display_name = excluded.display_name,
              role         = excluded.role,
              surface      = excluded.surface,
              resource_id  = excluded.resource_id,
              email        = excluded.email,
              avatar_url   = excluded.avatar_url,
              metadata     = excluded.metadata`,
      args: [
        sessionId,
        participant.id,
        participant.displayName,
        participant.role,
        participant.surface,
        participant.resourceId ?? null,
        participant.email ?? null,
        participant.avatarUrl ?? null,
        json(participant.metadata),
      ],
    });
  }

  async removeParticipant(
    sessionId: SessionId,
    participantId: ParticipantId,
  ): Promise<void> {
    await this.client.execute({
      sql: `DELETE FROM multiplayer_participants WHERE session_id = ? AND id = ?`,
      args: [sessionId, participantId],
    });
    // Leaving the roster clears presence too.
    await this.clearPresence(sessionId, participantId);
  }

  async getParticipant(
    sessionId: SessionId,
    participantId: ParticipantId,
  ): Promise<Participant | null> {
    const { rows } = await this.client.execute({
      sql: `SELECT * FROM multiplayer_participants WHERE session_id = ? AND id = ?`,
      args: [sessionId, participantId],
    });
    const row = rows[0];
    return row ? this.toParticipant(row) : null;
  }

  async listParticipants(sessionId: SessionId): Promise<Participant[]> {
    const { rows } = await this.client.execute({
      sql: `SELECT * FROM multiplayer_participants WHERE session_id = ? ORDER BY id`,
      args: [sessionId],
    });
    return rows.map((row) => this.toParticipant(row));
  }

  /* ---------------------------------------------------------------- */
  /* Presence                                                          */
  /* ---------------------------------------------------------------- */

  async setPresence(sessionId: SessionId, presence: PresenceState): Promise<void> {
    await this.assertSession(sessionId);
    await this.client.execute({
      sql: `INSERT INTO multiplayer_presence
              (session_id, participant_id, status, last_seen_at, cursor)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (session_id, participant_id) DO UPDATE SET
              status       = excluded.status,
              last_seen_at = excluded.last_seen_at,
              cursor       = excluded.cursor`,
      args: [
        sessionId,
        presence.participantId,
        presence.status,
        presence.lastSeenAt,
        json(presence.cursor),
      ],
    });
  }

  async listPresence(sessionId: SessionId): Promise<PresenceState[]> {
    const { rows } = await this.client.execute({
      sql: `SELECT * FROM multiplayer_presence WHERE session_id = ? ORDER BY participant_id`,
      args: [sessionId],
    });
    return rows.map((row) =>
      defined({
        participantId: String(row.participant_id),
        status: String(row.status) as PresenceState["status"],
        lastSeenAt: num(row.last_seen_at),
        cursor: parse<unknown>(row.cursor),
      }) as PresenceState,
    );
  }

  async clearPresence(sessionId: SessionId, participantId: ParticipantId): Promise<void> {
    await this.client.execute({
      sql: `DELETE FROM multiplayer_presence WHERE session_id = ? AND participant_id = ?`,
      args: [sessionId, participantId],
    });
  }

  /* ---------------------------------------------------------------- */
  /* Approvals                                                         */
  /* ---------------------------------------------------------------- */

  async saveApproval(request: ApprovalRequest): Promise<void> {
    await this.assertSession(request.sessionId);
    await this.client.execute({
      sql: `INSERT INTO multiplayer_approvals (id, session_id, status, created_at, document)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
              status   = excluded.status,
              document = excluded.document`,
      args: [
        request.id,
        request.sessionId,
        request.status,
        request.createdAt,
        JSON.stringify(request),
      ],
    });
  }

  async getApproval(id: string): Promise<ApprovalRequest | null> {
    const { rows } = await this.client.execute({
      sql: `SELECT document FROM multiplayer_approvals WHERE id = ?`,
      args: [id],
    });
    const row = rows[0];
    return row ? (parse<ApprovalRequest>(row.document) ?? null) : null;
  }

  async listApprovals(
    sessionId: SessionId,
    status?: ApprovalRequest["status"],
  ): Promise<ApprovalRequest[]> {
    const { rows } = status
      ? await this.client.execute({
          sql: `SELECT document FROM multiplayer_approvals
                WHERE session_id = ? AND status = ? ORDER BY created_at, id`,
          args: [sessionId, status],
        })
      : await this.client.execute({
          sql: `SELECT document FROM multiplayer_approvals
                WHERE session_id = ? ORDER BY created_at, id`,
          args: [sessionId],
        });

    return rows
      .map((row) => parse<ApprovalRequest>(row.document))
      .filter((request): request is ApprovalRequest => request !== undefined);
  }

  /* ---------------------------------------------------------------- */
  /* Audit                                                             */
  /* ---------------------------------------------------------------- */

  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.assertSession(entry.sessionId);
    await this.client.execute({
      sql: `INSERT INTO multiplayer_audit (id, session_id, action, actor_id, at, seq, detail)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        entry.id,
        entry.sessionId,
        entry.action,
        entry.actorId,
        entry.at,
        this.auditSeq++,
        json(entry.detail),
      ],
    });
  }

  async listAudit(sessionId: SessionId, limit = 100): Promise<AuditEntry[]> {
    // The newest `limit` entries, returned oldest-first. `ORDER BY at ASC
    // LIMIT n` would return the *oldest* — the opposite — and both look
    // plausible in a response body, which is what makes it easy to miss.
    const { rows } = await this.client.execute({
      sql: `SELECT * FROM (
              SELECT * FROM multiplayer_audit
              WHERE session_id = ?
              ORDER BY at DESC, seq DESC
              LIMIT ?
            ) ORDER BY at ASC, seq ASC`,
      args: [sessionId, limit],
    });

    return rows.map((row) =>
      defined({
        id: String(row.id),
        sessionId: String(row.session_id),
        action: String(row.action) as AuditEntry["action"],
        actorId: row.actor_id === null ? null : String(row.actor_id),
        at: num(row.at),
        detail: parse<Record<string, unknown>>(row.detail),
      }) as AuditEntry,
    );
  }

  /* ---------------------------------------------------------------- */

  /**
   * Writes against a session that does not exist are a caller bug, and
   * surfacing them beats silently dropping the write. Reads stay tolerant —
   * the default authorization rule asks about whatever session id a request
   * named, including ones that do not exist.
   */
  private async assertSession(sessionId: SessionId): Promise<void> {
    const { rows } = await this.client.execute({
      sql: `SELECT 1 FROM multiplayer_sessions WHERE id = ?`,
      args: [sessionId],
    });
    if (rows.length === 0) throw new Error(`Unknown session: ${sessionId}`);
  }

  private toSession(row: Record<string, unknown>): SessionRecord {
    return defined({
      id: String(row.id),
      threadId: String(row.thread_id),
      agentId: String(row.agent_id),
      title: text(row.title),
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
      runningRunId: text(row.running_run_id),
      metadata: parse<Record<string, unknown>>(row.metadata),
    }) as SessionRecord;
  }

  private toParticipant(row: Record<string, unknown>): Participant {
    return defined({
      id: String(row.id),
      displayName: String(row.display_name),
      role: String(row.role) as Participant["role"],
      surface: String(row.surface) as Participant["surface"],
      resourceId: text(row.resource_id),
      email: text(row.email),
      avatarUrl: text(row.avatar_url),
      metadata: parse<Record<string, unknown>>(row.metadata),
    }) as Participant;
  }
}
