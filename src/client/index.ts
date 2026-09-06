import type { MultiplayerEvent } from "../bus/events.js";
import type {
  ApprovalRequest,
  Participant,
  PresenceState,
  SessionId,
} from "../types.js";

export interface MultiplayerClientOptions {
  baseUrl?: string;
  basePath?: string;
  sessionId: SessionId;
  /** Extra headers on every request, e.g. an auth token. */
  headers?: Record<string, string>;
  /** Heartbeat interval. Should be well under the server's idle window. Default 10s. */
  heartbeatMs?: number;
  /** Reconnect backoff ceiling. Default 15s. */
  maxBackoffMs?: number;
}

export interface MultiplayerClientState {
  connected: boolean;
  participants: Participant[];
  presence: PresenceState[];
  approvals: ApprovalRequest[];
  messages: Array<{
    participantId: string | null;
    text: string;
    fromAgent: boolean;
    at: number;
  }>;
  /** Text accumulated from the run currently streaming, if any. */
  streaming: string | null;
  agentRunning: boolean;
}

type StateListener = (state: MultiplayerClientState) => void;

const initialState = (): MultiplayerClientState => ({
  connected: false,
  participants: [],
  presence: [],
  approvals: [],
  messages: [],
  streaming: null,
  agentRunning: false,
});

/**
 * Browser-side client for a shared session.
 *
 * Holds one SSE connection, reconnects with backoff from the last sequence it
 * saw, and reduces events into a state object you can render.
 */
export class MultiplayerClient {
  private state = initialState();
  private listeners = new Set<StateListener>();
  private source: EventSource | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private lastSeq = 0;

  private readonly baseUrl: string;
  private readonly basePath: string;
  private readonly heartbeatMs: number;
  private readonly maxBackoffMs: number;

  constructor(private readonly options: MultiplayerClientOptions) {
    this.baseUrl = options.baseUrl ?? "";
    this.basePath = options.basePath ?? "/multiplayer";
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 15_000;
  }

  getState(): MultiplayerClientState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /**
   * Loads the roster, presence, and open approvals for a session that already
   * exists.
   *
   * The replay buffer only covers a network blip. Someone opening a session
   * that has been running for an hour has no events to replay and would
   * otherwise render an empty room. The snapshot carries the sequence it is
   * consistent with, so the stream picks up from exactly there.
   */
  async hydrate(): Promise<void> {
    const url = `${this.baseUrl}${this.basePath}/sessions/${this.options.sessionId}/state`;
    const response = await fetch(url, {
      credentials: "include",
      headers: { ...this.options.headers },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }
    const snapshot = (await response.json()) as {
      participants: Participant[];
      presence: PresenceState[];
      approvals: ApprovalRequest[];
      seq: number;
    };

    // Only adopt the snapshot's sequence when no stream is open. If one is,
    // its replay frames may still be in flight below `snapshot.seq`, and
    // jumping the cursor forward would silently drop them.
    if (!this.source) {
      this.lastSeq = Math.max(this.lastSeq, snapshot.seq ?? 0);
    }
    this.patch({
      participants: snapshot.participants ?? [],
      presence: snapshot.presence ?? [],
      approvals: snapshot.approvals ?? [],
    });
  }

  connect(): void {
    if (this.source) return;
    this.openStream();
    this.startHeartbeat();
  }

  disconnect(): void {
    this.source?.close();
    this.source = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.patch({ connected: false });
  }

  async join(): Promise<void> {
    await this.post("/join", {});
  }

  /**
   * Join, load the current state, then open the stream — in that order.
   *
   * Order matters. Hydrating first means the stream opens from the snapshot's
   * sequence and replays only what came after it. Connecting first leaves a
   * window where replayed events and the snapshot race.
   */
  async start(): Promise<void> {
    await this.join();
    await this.hydrate();
    this.connect();
  }

  async send(text: string, addressedToAgent = true): Promise<void> {
    await this.post("/messages", { text, addressedToAgent });
  }

  async setTyping(typing: boolean): Promise<void> {
    await this.post("/presence", { status: typing ? "typing" : "active" });
  }

  async interrupt(): Promise<void> {
    await this.post("/interrupt", {});
  }

  async vote(
    approvalId: string,
    decision: "approve" | "deny",
    reason?: string,
  ): Promise<void> {
    await this.request(
      `${this.baseUrl}${this.basePath}/approvals/${approvalId}/vote`,
      { decision, reason },
    );
  }

  /* ------------------------------------------------------------------ */

  private openStream(): void {
    const url = `${this.baseUrl}${this.basePath}/sessions/${this.options.sessionId}/stream?lastSeq=${this.lastSeq}`;
    const source = new EventSource(url, { withCredentials: true });
    this.source = source;

    source.onopen = () => {
      this.attempt = 0;
      this.patch({ connected: true });
    };

    source.onmessage = (message) => this.handleRaw(message.data);

    // Named events arrive on their own listeners, not onmessage.
    const types: MultiplayerEvent["type"][] = [
      "participant.joined",
      "participant.left",
      "presence.updated",
      "message",
      "agent.delta",
      "agent.run.started",
      "agent.run.finished",
      "agent.run.interrupted",
      "approval.requested",
      "approval.updated",
      "approval.resolved",
    ];
    for (const type of types) {
      source.addEventListener(type, (event) =>
        this.handleRaw((event as MessageEvent).data),
      );
    }

    source.onerror = () => {
      source.close();
      this.source = null;
      this.patch({ connected: false });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(this.maxBackoffMs, 500 * 2 ** this.attempt++);
    const jitter = Math.random() * 250;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openStream();
    }, delay + jitter);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.post("/presence", { status: "active" }).catch(() => {
        /* offline; the stream reconnect will recover */
      });
    }, this.heartbeatMs);
  }

  private handleRaw(data: string): void {
    let event: MultiplayerEvent;
    try {
      event = JSON.parse(data) as MultiplayerEvent;
    } catch {
      return;
    }
    if (event.seq <= this.lastSeq) return; // duplicate after reconnect
    this.lastSeq = event.seq;
    this.reduce(event);
  }

  private reduce(event: MultiplayerEvent): void {
    switch (event.type) {
      case "participant.joined":
        this.patch({
          participants: [
            ...this.state.participants.filter((p) => p.id !== event.participant.id),
            event.participant,
          ],
        });
        break;

      case "participant.left":
        this.patch({
          participants: this.state.participants.filter(
            (p) => p.id !== event.participantId,
          ),
        });
        break;

      case "presence.updated":
        this.patch({ presence: event.presence });
        break;

      case "message":
        this.patch({
          messages: [
            ...this.state.messages,
            {
              participantId: event.participantId,
              text: event.text,
              fromAgent: event.fromAgent,
              at: event.at,
            },
          ],
          streaming: event.fromAgent ? null : this.state.streaming,
        });
        break;

      case "agent.delta":
        this.patch({ streaming: (this.state.streaming ?? "") + event.delta });
        break;

      case "agent.run.started":
        this.patch({ agentRunning: true, streaming: "" });
        break;

      case "agent.run.finished":
      case "agent.run.interrupted":
        this.patch({ agentRunning: false, streaming: null });
        break;

      case "approval.requested":
      case "approval.updated":
        this.patch({
          approvals: [
            ...this.state.approvals.filter((a) => a.id !== event.request.id),
            event.request,
          ],
        });
        break;

      case "approval.resolved":
        this.patch({
          approvals: this.state.approvals.filter((a) => a.id !== event.request.id),
        });
        break;
    }
  }

  private patch(partial: Partial<MultiplayerClientState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }

  private post(suffix: string, body: unknown): Promise<Response> {
    return this.request(
      `${this.baseUrl}${this.basePath}/sessions/${this.options.sessionId}${suffix}`,
      body,
    );
  }

  private async request(url: string, body: unknown): Promise<Response> {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...this.options.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }
    return response;
  }
}
