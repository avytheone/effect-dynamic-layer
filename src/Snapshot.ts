import { Cause } from "effect";

export type RuntimeState = "Running" | "Closing" | "Closed" | "CloseFailed";
export type FailurePhase = "acquire" | "gate" | "release";
export type RevocationReason =
  | "Disable"
  | "Replace"
  | "Unregister"
  | "GateClosed"
  | "DependencyInvalidated"
  | "Shutdown";

export interface RevocationDiagnostic {
  readonly generationId: number;
  readonly reason: RevocationReason;
  readonly rootId?: string;
}

export type PendingReason =
  | { readonly _tag: "MissingService"; readonly serviceKey: string }
  | { readonly _tag: "DependencyNotActive"; readonly serviceKey: string }
  | { readonly _tag: "GateInitializing" }
  | { readonly _tag: "GateClosed" };

export interface FailureDiagnostic {
  readonly phase: FailurePhase;
  readonly cause: Cause.Cause<unknown>;
  readonly generationId?: number;
  readonly fingerprint: string;
  readonly attempt: number;
}

export type NodeState =
  | { readonly _tag: "Pending"; readonly reasons: readonly PendingReason[] }
  | { readonly _tag: "Disabled" }
  | { readonly _tag: "Starting"; readonly generationId: number }
  | { readonly _tag: "Active"; readonly generationId: number }
  | { readonly _tag: "Stopping"; readonly generationId: number }
  | { readonly _tag: "Failed"; readonly failure: FailureDiagnostic };

export interface NodeSnapshot {
  readonly id: string;
  readonly exportKey: string;
  readonly requirementKeys: readonly string[];
  readonly desiredEnabled: boolean;
  readonly lastRevocation?: RevocationDiagnostic;
  readonly recipeRevision: number;
  readonly registrationId: number;
  readonly gateRevision: number;
  readonly generationId?: number;
  readonly dependencyGenerations: Readonly<Record<string, number>>;
  readonly state: NodeState;
}

export interface RuntimeSnapshot {
  readonly state: RuntimeState;
  readonly version: number;
  readonly liveGenerations: number;
  readonly managedCalls: number;
  readonly gateWatchers: number;
  readonly lifecycleWorkers: number;
  readonly nodes: readonly NodeSnapshot[];
}

export interface SafeFailureSummary {
  readonly phase: FailurePhase;
  readonly generationId?: number;
  readonly fingerprint: string;
  readonly attempt: number;
  readonly hasFailures: boolean;
  readonly hasDefects: boolean;
  readonly hasInterruptions: boolean;
}

/** A deliberately detail-free representation suitable for logs and JSON. */
export const safeSummary = (failure: FailureDiagnostic): SafeFailureSummary => {
  const summary: SafeFailureSummary = {
    phase: failure.phase,
    fingerprint: failure.fingerprint,
    attempt: failure.attempt,
    hasFailures: Cause.hasFails(failure.cause),
    hasDefects: Cause.hasDies(failure.cause),
    hasInterruptions: Cause.hasInterrupts(failure.cause),
    ...(failure.generationId === undefined ? {} : { generationId: failure.generationId }),
  };
  return Object.freeze(summary);
};
