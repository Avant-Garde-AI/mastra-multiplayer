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
 * Everything mastra-multiplayer needs to persist. Implement this against your
 * own database to survive restarts and run more than one server instance.
 *
 * Mastra's own storage already owns messages and threads — this interface
 * covers only what Mastra does not model: the participant roster, live
 * presence, approval requests, and the audit ledger.
 */
export interface MultiplayerStore {
  createSession(session: SessionRecord): Promise<void>;
  getSession(id: SessionId): Promise<SessionRecord | null>;
  updateSession(
    id: SessionId,
    patch: Partial<Omit<SessionRecord, "id">>,
  ): Promise<void>;
  listSessions(): Promise<SessionRecord[]>;

  addParticipant(sessionId: SessionId, participant: Participant): Promise<void>;
  removeParticipant(sessionId: SessionId, participantId: ParticipantId): Promise<void>;
  getParticipant(
    sessionId: SessionId,
    participantId: ParticipantId,
  ): Promise<Participant | null>;
  listParticipants(sessionId: SessionId): Promise<Participant[]>;

  setPresence(sessionId: SessionId, presence: PresenceState): Promise<void>;
  listPresence(sessionId: SessionId): Promise<PresenceState[]>;
  clearPresence(sessionId: SessionId, participantId: ParticipantId): Promise<void>;

  saveApproval(request: ApprovalRequest): Promise<void>;
  getApproval(id: string): Promise<ApprovalRequest | null>;
  listApprovals(
    sessionId: SessionId,
    status?: ApprovalRequest["status"],
  ): Promise<ApprovalRequest[]>;

  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(sessionId: SessionId, limit?: number): Promise<AuditEntry[]>;
}

interface SessionBucket {
  session: SessionRecord;
  participants: Map<ParticipantId, Participant>;
  presence: Map<ParticipantId, PresenceState>;
  audit: AuditEntry[];
}

/**
 * Zero-dependency store for development, tests, and single-process demos.
 * Everything is lost on restart — do not ship it.
 */
export class InMemoryMultiplayerStore implements MultiplayerStore {
  private sessions = new Map<SessionId, SessionBucket>();
  private approvals = new Map<string, ApprovalRequest>();

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, {
      session: { ...session },
      participants: new Map(),
      presence: new Map(),
      audit: [],
    });
  }

  async getSession(id: SessionId): Promise<SessionRecord | null> {
    const bucket = this.sessions.get(id);
    return bucket ? { ...bucket.session } : null;
  }

  async updateSession(
    id: SessionId,
    patch: Partial<Omit<SessionRecord, "id">>,
  ): Promise<void> {
    const bucket = this.requireBucket(id);
    bucket.session = { ...bucket.session, ...patch, updatedAt: Date.now() };
  }

  async listSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()].map((bucket) => ({ ...bucket.session }));
  }

  async addParticipant(sessionId: SessionId, participant: Participant): Promise<void> {
    this.requireBucket(sessionId).participants.set(participant.id, { ...participant });
  }

  async removeParticipant(
    sessionId: SessionId,
    participantId: ParticipantId,
  ): Promise<void> {
    const bucket = this.requireBucket(sessionId);
    bucket.participants.delete(participantId);
    bucket.presence.delete(participantId);
  }

  async getParticipant(
    sessionId: SessionId,
    participantId: ParticipantId,
  ): Promise<Participant | null> {
    const found = this.requireBucket(sessionId).participants.get(participantId);
    return found ? { ...found } : null;
  }

  async listParticipants(sessionId: SessionId): Promise<Participant[]> {
    return [...this.requireBucket(sessionId).participants.values()].map((p) => ({ ...p }));
  }

  async setPresence(sessionId: SessionId, presence: PresenceState): Promise<void> {
    this.requireBucket(sessionId).presence.set(presence.participantId, { ...presence });
  }

  async listPresence(sessionId: SessionId): Promise<PresenceState[]> {
    return [...this.requireBucket(sessionId).presence.values()].map((p) => ({ ...p }));
  }

  async clearPresence(sessionId: SessionId, participantId: ParticipantId): Promise<void> {
    this.requireBucket(sessionId).presence.delete(participantId);
  }

  async saveApproval(request: ApprovalRequest): Promise<void> {
    this.approvals.set(request.id, structuredClone(request));
  }

  async getApproval(id: string): Promise<ApprovalRequest | null> {
    const found = this.approvals.get(id);
    return found ? structuredClone(found) : null;
  }

  async listApprovals(
    sessionId: SessionId,
    status?: ApprovalRequest["status"],
  ): Promise<ApprovalRequest[]> {
    return [...this.approvals.values()]
      .filter((r) => r.sessionId === sessionId && (!status || r.status === status))
      .map((r) => structuredClone(r));
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.requireBucket(entry.sessionId).audit.push({ ...entry });
  }

  async listAudit(sessionId: SessionId, limit = 100): Promise<AuditEntry[]> {
    const audit = this.requireBucket(sessionId).audit;
    return audit.slice(-limit).map((e) => ({ ...e }));
  }

  private requireBucket(sessionId: SessionId): SessionBucket {
    const bucket = this.sessions.get(sessionId);
    if (!bucket) throw new Error(`Unknown session: ${sessionId}`);
    return bucket;
  }
}
