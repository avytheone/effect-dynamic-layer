import { type Cause, Data } from "effect";
import type { GraphValidationError } from "./internal/graph.js";
import type { FailureDiagnostic, LifecycleState, RuntimeState } from "./Snapshot.js";

export class RuntimeClosing extends Data.TaggedError("RuntimeClosing")<{
  readonly state: "Closing";
}> {}

export class RuntimeClosed extends Data.TaggedError("RuntimeClosed")<{
  readonly state: "Closed" | "CloseFailed";
}> {}

export class ServiceNotRegistered extends Data.TaggedError("ServiceNotRegistered")<{
  readonly serviceKey: string;
}> {}

export class NodeRetiring extends Data.TaggedError("NodeRetiring")<{
  readonly id?: string;
  readonly exportKey?: string;
}> {}

export class GraphRejected extends Data.TaggedError("GraphRejected")<{
  readonly error: GraphValidationError;
}> {}

export class ReplaceMismatch extends Data.TaggedError("ReplaceMismatch")<{
  readonly id: string;
  readonly descriptionId: string;
  readonly currentExportKey: string;
  readonly replacementExportKey: string;
}> {}

export class ServiceUnavailable extends Data.TaggedError("ServiceUnavailable")<{
  readonly serviceKey: string;
}> {}

export class AwaitStateFailed extends Data.TaggedError("AwaitStateFailed")<{
  readonly id: string;
  readonly expected: LifecycleState;
  readonly failure: FailureDiagnostic;
}> {}

export class AwaitStateUnavailable extends Data.TaggedError("AwaitStateUnavailable")<{
  readonly id: string;
  readonly expected: LifecycleState;
}> {}

export class InvalidExport extends Data.TaggedError("InvalidExport")<{
  readonly id: string;
  readonly exportKey: string;
}> {}

export class ShutdownFailed extends Data.TaggedError("ShutdownFailed")<{
  readonly causes: readonly Cause.Cause<unknown>[];
}> {}

export type CommandError =
  | RuntimeClosing
  | RuntimeClosed
  | ServiceNotRegistered
  | NodeRetiring
  | GraphRejected
  | ReplaceMismatch;

export type AwaitError =
  | RuntimeClosing
  | RuntimeClosed
  | ServiceNotRegistered
  | AwaitStateFailed
  | AwaitStateUnavailable;

export type UseError = RuntimeClosing | RuntimeClosed | ServiceUnavailable;

export const unavailableForState = (state: RuntimeState): RuntimeClosing | RuntimeClosed =>
  state === "Closing"
    ? new RuntimeClosing({ state })
    : new RuntimeClosed({ state: state === "Running" ? "Closed" : state });
