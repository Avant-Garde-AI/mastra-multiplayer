/**
 * Minimal consumer of the headless hook. No styling on purpose — the package
 * gives you state, you bring the design system.
 */
// @ts-nocheck
import { useState } from "react";
import { useMultiplayerSession } from "mastra-multiplayer/client/react";

export function SessionView({ sessionId }: { sessionId: string }) {
  const [draft, setDraft] = useState("");
  const {
    connected,
    participants,
    presence,
    messages,
    streaming,
    agentRunning,
    approvals,
    send,
    setTyping,
    interrupt,
    vote,
  } = useMultiplayerSession({ sessionId });

  const nameFor = (id: string | null) =>
    id ? (participants.find((p) => p.id === id)?.displayName ?? id) : "Agent";

  const typing = presence
    .filter((p) => p.status === "typing")
    .map((p) => nameFor(p.participantId));

  return (
    <div>
      <header>
        <span>{connected ? "Connected" : "Reconnecting…"}</span>
        <span>{participants.length} here</span>
      </header>

      <ol>
        {messages.map((m, i) => (
          <li key={i}>
            <strong>{nameFor(m.participantId)}</strong> {m.text}
          </li>
        ))}
        {streaming !== null && (
          <li>
            <strong>Agent</strong> {streaming}
          </li>
        )}
      </ol>

      {typing.length > 0 && <p>{typing.join(", ")} typing…</p>}

      {approvals.map((approval) => (
        <div key={approval.id}>
          <p>{approval.summary}</p>
          <p>
            {approval.votes.filter((v) => v.decision === "approve").length} approved ·
            requested by {nameFor(approval.requestedBy)}
          </p>
          <button onClick={() => vote(approval.id, "approve")}>Approve</button>
          <button onClick={() => vote(approval.id, "deny")}>Deny</button>
        </div>
      ))}

      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          void setTyping(e.target.value.length > 0);
        }}
      />
      <button
        onClick={() => {
          void send(draft);
          setDraft("");
          void setTyping(false);
        }}
      >
        Send
      </button>
      {agentRunning && <button onClick={() => void interrupt()}>Stop</button>}
    </div>
  );
}
