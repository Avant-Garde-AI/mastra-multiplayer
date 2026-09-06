import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import {
  MultiplayerClient,
  type MultiplayerClientOptions,
  type MultiplayerClientState,
} from "./index.js";

export interface UseMultiplayerSession extends MultiplayerClientState {
  send: (text: string, addressedToAgent?: boolean) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  interrupt: () => Promise<void>;
  vote: (
    approvalId: string,
    decision: "approve" | "deny",
    reason?: string,
  ) => Promise<void>;
  client: MultiplayerClient;
}

/**
 * Headless hook — no markup, no styles. It gives you the roster, presence,
 * pending approvals, and the streaming reply; you decide how they look.
 */
export function useMultiplayerSession(
  options: MultiplayerClientOptions,
): UseMultiplayerSession {
  const clientRef = useRef<MultiplayerClient | null>(null);
  if (!clientRef.current) clientRef.current = new MultiplayerClient(options);
  const client = clientRef.current;

  useEffect(() => {
    void client.start();
    return () => client.disconnect();
  }, [client]);

  const subscribe = useCallback(
    (onChange: () => void) => client.subscribe(() => onChange()),
    [client],
  );
  const getSnapshot = useCallback(() => client.getState(), [client]);

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const send = useCallback(
    (text: string, addressedToAgent = true) => client.send(text, addressedToAgent),
    [client],
  );
  const setTyping = useCallback((typing: boolean) => client.setTyping(typing), [client]);
  const interrupt = useCallback(() => client.interrupt(), [client]);
  const vote = useCallback(
    (approvalId: string, decision: "approve" | "deny", reason?: string) =>
      client.vote(approvalId, decision, reason),
    [client],
  );

  return useMemo(
    () => ({ ...state, send, setTyping, interrupt, vote, client }),
    [state, send, setTyping, interrupt, vote, client],
  );
}
