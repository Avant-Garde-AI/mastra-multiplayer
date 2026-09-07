/**
 * Approval gates as Mastra workflow steps.
 *
 * A gate is a step that suspends until enough of the right humans have voted,
 * and a resumer that wakes the suspended run when they have. Both halves are
 * needed and the second is the load-bearing one: votes arrive over this
 * package's HTTP surface, workflows continue through `run.resume()`, and
 * nothing connects the two. A step factory on its own suspends every gate for
 * ever.
 *
 * ```ts
 * import { createStep } from "@mastra/core/workflows";
 * import { approvalStep, approvalResumer } from "mastra-multiplayer/workflows";
 *
 * const gate = createStep(
 *   approvalStep(multiplayer, {
 *     id: "refund-approval",
 *     inputSchema: refundArgs,
 *     outputSchema: refundArgs,
 *     workflowId: "refund",
 *     toolName: "refund-order",
 *     policy: fourEyes(),
 *     sessionId: ({ inputData }) => inputData.sessionId,
 *     requestedBy: ({ inputData }) => inputData.agentId,
 *     summary: ({ inputData }) => `Refund $${inputData.amountCents / 100}`,
 *   }),
 * );
 *
 * const resumer = approvalResumer(multiplayer, mastra);
 * await resumer.start();
 * ```
 *
 * `@mastra/core` is an optional peer and is imported by nothing here. The
 * workflow surface is declared structurally, as in
 * [ADR 0004](../../docs/decisions/0004-structural-mastra-types.md), so this
 * module compiles and tests with no peer installed.
 */
import { randomUUID } from "node:crypto";

import { ApprovalError, type ApprovalGate } from "../approvals/index.js";
import type { TurnLease } from "../concurrency/lease.js";
import { consoleLogger, safeLogger, type Logger } from "../internal/logger.js";
import type { MultiplayerStore } from "../storage/index.js";
import type {
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalStatus,
  ParticipantId,
  SessionId,
} from "../types.js";

/* ------------------------------------------------------------------ */
/* The Mastra surface, declared structurally                           */
/* ------------------------------------------------------------------ */

/**
 * The slice of a step's `execute` arguments a gate reads.
 *
 * The index signature is what lets a caller reach `requestContext`, `runId`,
 * `getStepResult` and the rest from their own resolvers without this package
 * having to model Mastra's whole execution context — or go stale when it grows.
 */
export interface StepExecuteParams<TInput = unknown, TResume = unknown> {
  inputData: TInput;
  resumeData?: TResume;
  suspend: (payload?: unknown) => unknown;
  bail: (result: unknown) => unknown;
  runId?: string;
  [key: string]: unknown;
}

/** One suspended workflow run. Satisfied by Mastra's `Run`. */
export interface WorkflowRunLike {
  resume(params: {
    step?: string | string[];
    resumeData?: unknown;
  }): Promise<{ status: string }>;
}

/** One registered workflow. Satisfied by Mastra's `Workflow`. */
export interface WorkflowLike {
  /** Re-attaches to an existing run when `runId` names one. */
  createRun(options?: { runId?: string }): Promise<WorkflowRunLike>;
  getWorkflowRunById(
    runId: string,
    options?: { fields?: string[] },
  ): Promise<{
    status: string;
    suspendedPaths?: Record<string, unknown>;
  } | null>;
}

/** The workflow registry. Satisfied by Mastra's `Mastra`. */
export interface WorkflowRegistryLike {
  getWorkflow(id: string): WorkflowLike | undefined;
}

/* ------------------------------------------------------------------ */
/* Piece 1 — the step                                                  */
/* ------------------------------------------------------------------ */

/** What a gate suspends with. Readable in a run snapshot or a UI. */
export interface ApprovalSuspendData {
  approvalId: string;
  toolName: string;
  summary: string;
  /** Approve votes still required, from the policy stored on the request. */
  votesNeeded: number;
  expiresAt: number;
}

/** What a gate is resumed with. The resumer supplies it. */
export interface ApprovalResumeData {
  approvalId: string;
  /**
   * Advisory only. The step re-reads the request from the store and decides
   * from that, because `resumeData` travels through a snapshot and an HTTP
   * route — anyone who can call `run.resume()` could otherwise hand a denied
   * gate an `"approved"` here and walk straight through it.
   */
  status?: ApprovalStatus;
}

type Resolver<TInput, TValue> =
  | TValue
  | ((params: StepExecuteParams<TInput, ApprovalResumeData>) => TValue);

export interface ApprovalStepOptions<TInputSchema, TOutputSchema, TInput> {
  /** The step id. Must match what the workflow registers it under. */
  id: string;
  description?: string;
  /** Passed straight through to `createStep`. */
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  /**
   * The workflow this step belongs to, as registered with Mastra.
   *
   * Recorded on the request so a resumer in another process can find the run:
   * a run id alone is not enough to look one up.
   */
  workflowId: string;
  /** The action being gated. Hashed with the arguments into the binding. */
  toolName: string;
  sessionId: Resolver<TInput, SessionId>;
  requestedBy: Resolver<TInput, ParticipantId>;
  summary: Resolver<TInput, string>;
  /**
   * What the approval is bound to. Defaults to `inputData` — the arguments the
   * step will actually run with, which is what a signature should cover.
   */
  toolArgs?: (params: StepExecuteParams<TInput, ApprovalResumeData>) => unknown;
  policy?: ApprovalPolicy;
  /** Optional schemas for the payloads this step suspends and resumes with. */
  resumeSchema?: unknown;
  suspendSchema?: unknown;
  /**
   * The step's output once approved. Defaults to passing `inputData` through,
   * so a gate can be dropped between two existing steps without reshaping
   * anything.
   */
  onApproved?: (
    params: StepExecuteParams<TInput, ApprovalResumeData>,
    request: ApprovalRequest,
  ) => unknown;
  /**
   * The value the run bails with when the gate is denied, cancelled, or
   * expires. Defaults to `{ approved: false, approvalId, status }`.
   */
  onDenied?: (
    params: StepExecuteParams<TInput, ApprovalResumeData>,
    request: ApprovalRequest,
  ) => unknown;
}

/** The subset of `MultiplayerSession` a gate needs. */
export interface ApprovalHost {
  approvals: ApprovalGate;
  store: MultiplayerStore;
}

/**
 * Builds the `createStep` parameters for a gate that suspends until a decision
 * is made.
 *
 * It returns parameters rather than a step because building a step means
 * converting schemas, which is `@mastra/core`'s job — wrap the result in
 * `createStep()` and the peer stays optional.
 *
 * The step is executed twice. Without `resumeData` it opens an approval request
 * and suspends. With `resumeData` it re-reads that request and either bails
 * (denied) or returns (approved).
 */
export function approvalStep<TInputSchema, TOutputSchema, TInput = unknown>(
  host: ApprovalHost,
  options: ApprovalStepOptions<TInputSchema, TOutputSchema, TInput>,
): {
  id: string;
  description?: string;
  // The caller's own schema types, passed through untouched, so the step
  // `createStep` builds still types the workflow chain either side of it.
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  // `any`, not `unknown`, on all three of these. The caller's `outputSchema`
  // decides the real `execute` return type and the resume/suspend schemas have
  // to satisfy `@mastra/core`'s `PublicSchema`, neither of which this module can
  // see. `unknown` here makes every `createStep(approvalStep(...))` a type
  // error — which is how this was found.
  resumeSchema?: any;
  suspendSchema?: any;
  /**
   * Loosely typed on purpose, and only here.
   *
   * `createStep` declares `execute` as a property rather than a method, so its
   * parameter is checked contravariantly: a narrower `params` — one that
   * insists `resumeData` is an `ApprovalResumeData`, or that `suspend` takes one
   * argument — is rejected, however much more accurate it is. The precise types
   * are still enforced where they matter: on the implementation below, and on
   * every resolver the caller writes, which take
   * `StepExecuteParams<TInput, ApprovalResumeData>`.
   *
   * `inputSchema` and `outputSchema` stay exact, so the workflow chain either
   * side of the gate is typed as usual.
   */
  execute: (params: any) => Promise<any>;
} {
  const execute = async (
    params: StepExecuteParams<TInput, ApprovalResumeData>,
  ): Promise<unknown> => {
    const toolArgs = options.toolArgs ? options.toolArgs(params) : params.inputData;

    if (!params.resumeData) {
      const request = await host.approvals.request({
        sessionId: resolve(options.sessionId, params),
        requestedBy: resolve(options.requestedBy, params),
        toolName: options.toolName,
        toolArgs,
        summary: resolve(options.summary, params),
        ...(options.policy ? { policy: options.policy } : {}),
        workflowId: options.workflowId,
        ...(typeof params.runId === "string" ? { runId: params.runId } : {}),
        stepId: options.id,
      });

      const suspendData: ApprovalSuspendData = {
        approvalId: request.id,
        toolName: request.toolName,
        summary: request.summary,
        votesNeeded: request.policy.quorum,
        expiresAt: request.expiresAt,
      };
      return params.suspend(suspendData);
    }

    const approvalId = params.resumeData.approvalId;
    if (!approvalId) {
      throw new ApprovalError(
        `Step "${options.id}" was resumed without an approvalId`,
        "not_found",
      );
    }

    const request = await host.store.getApproval(approvalId);
    if (!request) {
      throw new ApprovalError(
        `Approval ${approvalId} no longer exists; step "${options.id}" cannot ` +
          "establish whether it was authorized",
        "not_found",
      );
    }

    // Re-checked here, on the arguments that are about to execute, because the
    // suspend/resume round trip is the exact window argument binding exists to
    // close. A mismatch is not a business decision and does not `bail`: it
    // means the run is trying to perform something nobody approved, and the
    // run should fail loudly.
    host.approvals.assertBinding(request, options.toolName, toolArgs);

    if (request.status !== "approved") {
      const denied = options.onDenied
        ? options.onDenied(params, request)
        : { approved: false, approvalId, status: request.status };
      // `bail`, not `throw`. A denied gate is a completed run that did not do
      // the thing — the framework's own word for that is a bail, and throwing
      // would turn every routine refusal into an error to triage.
      return params.bail(denied);
    }

    return options.onApproved ? options.onApproved(params, request) : params.inputData;
  };

  return {
    id: options.id,
    ...(options.description ? { description: options.description } : {}),
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    ...(options.resumeSchema ? { resumeSchema: options.resumeSchema } : {}),
    ...(options.suspendSchema ? { suspendSchema: options.suspendSchema } : {}),
    execute,
  };
}

function resolve<TInput, TValue>(
  resolver: Resolver<TInput, TValue>,
  params: StepExecuteParams<TInput, ApprovalResumeData>,
): TValue {
  return typeof resolver === "function"
    ? (resolver as (p: typeof params) => TValue)(params)
    : resolver;
}

/* ------------------------------------------------------------------ */
/* Piece 2 — the resumer                                               */
/* ------------------------------------------------------------------ */

export type ResumeOutcome =
  /** The suspended step was woken. */
  | "resumed"
  /** The run had already moved on. Nothing to do, and not an error. */
  | "skipped"
  /** The run could not be woken. It may still be suspended. */
  | "failed";

export interface ResumeResult {
  approvalId: string;
  outcome: ResumeOutcome;
  /** Why, in a form worth logging. */
  reason: string;
}

export interface ApprovalResumerOptions {
  /**
   * Serializes resume attempts so two instances reacting to the same decision
   * do not both wake the run.
   *
   * Optional: without it a double resume is caught by Mastra, which refuses to
   * resume a run that is not suspended — noisier, but not incorrect. With
   * `RedisTurnLease` the second instance never tries.
   *
   * Keys are namespaced per approval, not per session: two gates in one session
   * are independent, and sharing a key with turn-taking would make an approval
   * resume block an agent run.
   */
  lease?: TurnLease;
  leaseTtlMs?: number;
  logger?: Logger;
}

/** The subset of `MultiplayerSession` a resumer needs. */
export interface ResumerHost {
  approvals: ApprovalGate;
  store: MultiplayerStore;
}

/**
 * Wakes workflow runs that are suspended on a gate which has since been
 * decided.
 *
 * Two triggers, and both are needed:
 *
 * - **`start()`** reacts to decisions made in this process. That covers every
 *   normal vote and every expiry sweep, immediately.
 * - **`reconcile()`** sweeps the store for gates that were decided while no
 *   resumer was listening — a vote taken on an instance that then restarted, a
 *   decision made while a deploy was rolling. Run it on start (which `start()`
 *   does) and on whatever timer already sweeps expiries.
 *
 * Neither alone is enough. Without the first, a human waits for the next sweep.
 * Without the second, a decision made during a restart leaves the run suspended
 * for ever, with the ledger insisting it was approved.
 */
export class ApprovalResumer {
  private readonly logger: Logger;
  private readonly lease: TurnLease | undefined;
  private readonly leaseTtlMs: number;
  /** This resumer's identity, for lease ownership. */
  private readonly holder = randomUUID();
  private readonly inFlight = new Set<Promise<unknown>>();
  private stopListening: (() => void) | undefined;

  constructor(
    private readonly host: ResumerHost,
    private readonly workflows: WorkflowRegistryLike,
    options: ApprovalResumerOptions = {},
  ) {
    this.logger = safeLogger(options.logger ?? consoleLogger);
    this.lease = options.lease;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
  }

  /**
   * Starts listening, and reconciles once for anything decided while nothing
   * was.
   *
   * Returns a stop function. Awaiting `start()` waits for the initial
   * reconciliation, so a caller that wants a clean startup can; a caller that
   * does not care can leave it floating and still be listening immediately,
   * because the listener is registered before the sweep begins.
   */
  async start(): Promise<() => void> {
    this.stop();
    this.stopListening = this.host.approvals.onResolved((request) => {
      this.track(this.resume(request));
    });
    await this.reconcile();
    return () => this.stop();
  }

  /** Stops listening. In-flight resumes are left to finish; see `idle()`. */
  stop(): void {
    this.stopListening?.();
    this.stopListening = undefined;
  }

  /** Resolves once every resume this resumer started has settled. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /**
   * Sweeps every session for gates that are decided but may still be holding a
   * run open.
   *
   * `resumedAt` keeps this cheap: an approval whose run has been dealt with is
   * never looked at again. Without it, every gate ever resolved would be
   * re-checked against the workflow store on every sweep, for ever.
   *
   * It reads the session list on each call, like
   * `MultiplayerSession.sweepExpiredApprovals()`. On a large deployment prefer
   * `reconcileSession()` for the sessions you know are live.
   */
  async reconcile(): Promise<ResumeResult[]> {
    const sessions = await this.host.store.listSessions();
    const results: ResumeResult[] = [];
    for (const session of sessions) {
      results.push(...(await this.reconcileSession(session.id)));
    }
    return results;
  }

  /** `reconcile()`, for one session. */
  async reconcileSession(sessionId: SessionId): Promise<ResumeResult[]> {
    const requests = await this.host.store.listApprovals(sessionId);
    const results: ResumeResult[] = [];

    for (const request of requests) {
      if (request.status === "pending") continue;
      if (request.resumedAt !== undefined) continue;
      if (!isSuspendedOnAStep(request)) continue;
      results.push(await this.resume(request));
    }

    return results;
  }

  /**
   * Wakes the run this request is suspended in, if it still is.
   *
   * Safe to call twice, from two processes, in any order. The guard is the
   * workflow store rather than a flag of our own: a run that is no longer
   * suspended on this step needs nothing, whoever resumed it.
   */
  async resume(request: ApprovalRequest): Promise<ResumeResult> {
    const result = (outcome: ResumeOutcome, reason: string): ResumeResult => ({
      approvalId: request.id,
      outcome,
      reason,
    });

    if (request.status === "pending") {
      return result("skipped", "the request is still pending");
    }
    if (!isSuspendedOnAStep(request)) {
      return result("skipped", "the request is not attached to a workflow step");
    }

    const key = `approval:${request.id}`;
    const acquired = this.lease
      ? await this.lease.acquire(key, this.holder, this.leaseTtlMs)
      : true;
    if (!acquired) {
      return result("skipped", "another instance is resuming this run");
    }

    try {
      return await this.resumeUnderLease(request, result);
    } finally {
      await this.lease?.release(key, this.holder);
    }
  }

  /**
   * The lease is deliberately not renewed while this runs.
   *
   * `run.resume()` awaits the rest of the workflow, which can outlast any
   * sensible TTL — a refund, a deployment. Renewing would mean a timer and a
   * shutdown story for a guarantee that is not needed here: once the run leaves
   * `suspended`, a second instance's own check finds nothing to do. The lease
   * covers the window between reading that state and acting on it, which is
   * short; the workflow store covers the rest.
   */
  private async resumeUnderLease(
    request: SuspendedOnAStep,
    result: (outcome: ResumeOutcome, reason: string) => ResumeResult,
  ): Promise<ResumeResult> {
    const { workflowId, runId, stepId } = request;

    let workflow: WorkflowLike | undefined;
    try {
      workflow = this.workflows.getWorkflow(workflowId);
    } catch {
      // Mastra throws rather than returning undefined for an unregistered id.
      workflow = undefined;
    }
    if (!workflow) {
      // Not marked resumed: registering the workflow is a deploy away, and a
      // gate that silently gave up would be unrecoverable.
      this.logger.warn("no workflow registered for a suspended approval gate", {
        approvalId: request.id,
        workflowId,
        runId,
      });
      return result("failed", `workflow "${workflowId}" is not registered`);
    }

    let state: Awaited<ReturnType<WorkflowLike["getWorkflowRunById"]>>;
    try {
      state = await workflow.getWorkflowRunById(runId, { fields: ["suspendedPaths"] });
    } catch (error) {
      this.logger.warn("could not read a workflow run while resuming a gate", {
        approvalId: request.id,
        runId,
        error,
      });
      return result("failed", "the workflow run could not be read");
    }

    if (!state) {
      // Loud, and re-checked next sweep. The workflow store may simply be
      // behind a restart — but a run that is gone for good is a decision in the
      // ledger with nothing on the other end of it, which is exactly the
      // failure this class exists to prevent, and it should stay visible.
      this.logger.warn("a decided approval gate points at a run that does not exist", {
        approvalId: request.id,
        workflowId,
        runId,
      });
      return result("failed", `workflow run "${runId}" was not found`);
    }

    if (!isResumable(state, stepId)) {
      await this.markResumed(request);
      return result("skipped", `the run is "${state.status}", not suspended on this step`);
    }

    const resumeData: ApprovalResumeData = {
      approvalId: request.id,
      status: request.status,
    };

    try {
      const run = await workflow.createRun({ runId });
      await run.resume({ step: stepId, resumeData });
    } catch (error) {
      // Failing loudly beats a gate that resolved in the ledger and never
      // resumed, which looks fine from the outside and is not.
      this.logger.error("could not resume a workflow suspended on an approval gate", {
        approvalId: request.id,
        workflowId,
        runId,
        stepId,
        error,
      });
      return result("failed", "the resume call failed");
    }

    await this.markResumed(request);
    return result("resumed", `resumed "${workflowId}" run ${runId} at step "${stepId}"`);
  }

  /**
   * Records that this gate no longer needs waking.
   *
   * Written after the fact, never before: a crash between the resume and this
   * write leaves the request unmarked, and the next sweep re-checks it and
   * finds the run already moved on. The other order would drop a resume.
   */
  private async markResumed(request: ApprovalRequest): Promise<void> {
    try {
      const current = (await this.host.store.getApproval(request.id)) ?? request;
      await this.host.store.saveApproval({ ...current, resumedAt: Date.now() });
    } catch (error) {
      // The resume happened. Losing the bookkeeping costs one redundant check
      // on the next sweep, so it is logged rather than surfaced as a failure.
      this.logger.warn("could not record that an approval gate was resumed", {
        approvalId: request.id,
        error,
      });
    }
  }

  private track(promise: Promise<unknown>): void {
    const settled = promise
      .catch((error) => {
        this.logger.error("an approval resume threw", { error });
      })
      .finally(() => {
        this.inFlight.delete(settled);
      });
    this.inFlight.add(settled);
  }
}

/** `new ApprovalResumer(...)`, for callers who prefer a function. */
export function approvalResumer(
  host: ResumerHost,
  workflows: WorkflowRegistryLike,
  options: ApprovalResumerOptions = {},
): ApprovalResumer {
  return new ApprovalResumer(host, workflows, options);
}

/** A request carrying all three keys needed to find its suspended step. */
type SuspendedOnAStep = ApprovalRequest &
  Required<Pick<ApprovalRequest, "workflowId" | "runId" | "stepId">>;

function isSuspendedOnAStep(request: ApprovalRequest): request is SuspendedOnAStep {
  return Boolean(request.workflowId && request.runId && request.stepId);
}

/**
 * Whether waking this step would do anything.
 *
 * `suspendedPaths` is keyed by step id, so it distinguishes "this run is
 * suspended" from "this run is suspended *on this gate*" — a run holding two
 * gates would otherwise have the first one resumed by the second one's
 * decision. When the field is missing, the run status is all there is to go on.
 */
function isResumable(
  state: { status: string; suspendedPaths?: Record<string, unknown> },
  stepId: string,
): boolean {
  if (state.status !== "suspended") return false;
  const paths = state.suspendedPaths;
  if (!paths || Object.keys(paths).length === 0) return true;
  return Object.keys(paths).some((path) => path === stepId || path.endsWith(`.${stepId}`));
}
