import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type * as DynamicLayerModel from "./DynamicLayer.js";
import {
  type AwaitError,
  AwaitStateFailed,
  AwaitStateUnavailable,
  type CommandError,
  GraphRejected,
  InvalidExport,
  NodeRetiring,
  ReplaceMismatch,
  RuntimeClosed,
  RuntimeClosing,
  ServiceUnavailable,
  ShutdownFailed,
  UnknownNode,
  type UseError,
} from "./Errors.js";
import {
  type ErasedDescription,
  eraseCapturedContext,
  eraseDescription,
  extractOutput,
  recoverService,
} from "./internal/erased.js";
import {
  affectedClosure,
  type GraphNode,
  topologicalOrder,
  validateGraph,
} from "./internal/graph.js";
import type {
  FailureDiagnostic,
  NodeSnapshot,
  NodeState,
  PendingReason,
  RevocationDiagnostic,
  RevocationReason,
  RuntimeSnapshot,
  RuntimeState,
} from "./Snapshot.js";

export type StateTag = NodeState["_tag"];

type Reply =
  | { readonly _tag: "Success"; readonly value: unknown }
  | { readonly _tag: "Failure"; readonly error: unknown };

type ReplyDeferred = Deferred.Deferred<Reply>;

type Command =
  | {
      readonly _tag: "Register";
      readonly description: ErasedDescription;
      readonly reply: ReplyDeferred;
    }
  | {
      readonly _tag: "Replace";
      readonly id: string;
      readonly description: ErasedDescription;
      readonly reply: ReplyDeferred;
    }
  | {
      readonly _tag: "Enable" | "Disable" | "Retry" | "Unregister";
      readonly id: string;
      readonly reply: ReplyDeferred;
    }
  | { readonly _tag: "Snapshot"; readonly reply: ReplyDeferred }
  | { readonly _tag: "Shutdown"; readonly reply: ReplyDeferred }
  | {
      readonly _tag: "AwaitState";
      readonly id: string;
      readonly expected: StateTag;
      readonly waiterId: number;
      readonly reply: ReplyDeferred;
    }
  | { readonly _tag: "AwaitIdle"; readonly waiterId: number; readonly reply: ReplyDeferred }
  | { readonly _tag: "CancelWaiter"; readonly waiterId: number }
  | {
      readonly _tag: "GateValue";
      readonly registrationId: number;
      readonly gateToken: number;
      readonly value: boolean;
    }
  | {
      readonly _tag: "GateComplete";
      readonly gateToken: number;
      readonly exit: Exit.Exit<void, unknown>;
    }
  | {
      readonly _tag: "BuildComplete";
      readonly generationId: number;
      readonly exit: Exit.Exit<Context.Context<unknown>, unknown>;
    }
  | {
      readonly _tag: "StopComplete";
      readonly generationId: number;
      readonly exit: Exit.Exit<void, unknown>;
    }
  | { readonly _tag: "WorkerComplete"; readonly gateToken?: number }
  | { readonly _tag: "Admit"; readonly serviceKey: string; readonly reply: ReplyDeferred }
  | {
      readonly _tag: "AttachCall";
      readonly callId: number;
      readonly fiber: Fiber.Fiber<unknown, unknown>;
      readonly permit: Deferred.Deferred<void>;
      readonly reply: ReplyDeferred;
    }
  | {
      readonly _tag: "CallComplete";
      readonly callId: number;
      readonly exit: Exit.Exit<void, unknown>;
    };

type NodePhase = StateTag;

type NodeRecord = {
  description: ErasedDescription;
  registrationId: number;
  recipeRevision: number;
  activationRevision: number;
  desiredEnabled: boolean;
  gateKnown: boolean;
  gateValue: boolean;
  gateClosed: boolean;
  gateRevision: number;
  gateToken: number | undefined;
  retirementGateToken: number | undefined;
  generationId: number | undefined;
  phase: NodePhase;
  pendingReasons: readonly PendingReason[];
  failure: FailureDiagnostic | undefined;
  failedFingerprint: string | undefined;
  lastRevocation: RevocationDiagnostic | undefined;
  retiring: boolean;
  quarantined: boolean;
  attempts: number;
};

type Generation = {
  readonly id: number;
  readonly nodeId: string;
  readonly registrationId: number;
  readonly recipeRevision: number;
  readonly activationRevision: number;
  readonly gateRevision: number;
  readonly dependencyGenerations: ReadonlyMap<string, number>;
  readonly fingerprint: string;
  readonly scope: Scope.Closeable;
  status: "Starting" | "Active" | "Stopping";
  buildFiber: Fiber.Fiber<void, unknown> | undefined;
  stopStarted: boolean;
  pendingFailure: FailureDiagnostic | undefined;
  readonly calls: Set<number>;
};

type Publication = {
  readonly generationId: number;
  readonly service: unknown;
};

type GateWatcher = {
  readonly registrationId: number;
  readonly fiber: Fiber.Fiber<void, unknown>;
  interruptStarted: boolean;
};

type ManagedCall = {
  readonly id: number;
  readonly generationId: number;
  fiber: Fiber.Fiber<unknown, unknown> | undefined;
  interruptStarted: boolean;
};

type StateWaiter = {
  readonly _tag: "State";
  readonly id: string;
  readonly expected: StateTag;
  readonly reply: ReplyDeferred;
};

type IdleWaiter = {
  readonly _tag: "Idle";
  readonly reply: ReplyDeferred;
};

type Waiter = StateWaiter | IdleWaiter;

type Admission = {
  readonly callId: number;
  readonly generationId: number;
  readonly serviceKey: string;
  readonly service: unknown;
};

const success = (value: unknown = void 0): Reply => ({ _tag: "Success", value });
const failure = (error: unknown): Reply => ({ _tag: "Failure", error });
const complete = (reply: ReplyDeferred, value: Reply): Effect.Effect<void> =>
  Deferred.succeed(reply, value).pipe(Effect.asVoid);

const causeOf = <A, E>(exit: Exit.Exit<A, E>): Cause.Cause<unknown> | undefined =>
  Exit.isFailure(exit) ? exit.cause : undefined;

const graphNode = (node: NodeRecord): GraphNode => ({
  id: node.description.id,
  exportKey: node.description.exportKey,
  requirementKeys: node.description.requirementKeys,
});

class RuntimeController {
  readonly self = this;
  readonly nodes = new Map<string, NodeRecord>();
  readonly publications = new Map<string, Publication>();
  readonly generations = new Map<number, Generation>();
  readonly gateWatchers = new Map<number, GateWatcher>();
  readonly calls = new Map<number, ManagedCall>();
  readonly waiters = new Map<number, Waiter>();
  readonly shutdownWaiters: ReplyDeferred[] = [];
  readonly releaseFailures: Cause.Cause<unknown>[] = [];

  runtimeState: RuntimeState = "Running";
  version = 0;
  lifecycleWorkers = 0;
  nextRegistrationId = 1;
  nextGenerationId = 1;
  nextGateToken = 1;
  nextCallId = 1;
  nextWaiterId = 1;
  lastSnapshot: RuntimeSnapshot;

  constructor(
    readonly mailbox: Queue.Queue<Command>,
    readonly snapshots: SubscriptionRef.SubscriptionRef<RuntimeSnapshot>,
    readonly executionScope: Scope.Closeable,
    readonly staticContext: Context.Context<never>,
  ) {
    this.lastSnapshot = this.makeSnapshot();
  }

  offer(command: Command): Effect.Effect<void> {
    return Queue.offer(this.mailbox, command).pipe(Effect.asVoid);
  }

  request<A>(
    makeCommand: (reply: ReplyDeferred) => Command,
    beforeOffer?: () => Reply | undefined,
  ): Effect.Effect<A, unknown> {
    return Effect.gen(this, function* () {
      const reply = yield* Deferred.make<Reply>();
      const immediate = yield* Effect.sync(() => {
        const guarded = beforeOffer?.();
        if (guarded !== undefined) return guarded;
        return Queue.offerUnsafe(this.mailbox, makeCommand(reply))
          ? undefined
          : failure(new RuntimeClosed({ state: "Closed" }));
      });
      const result = immediate ?? (yield* Deferred.await(reply));
      if (result._tag === "Failure") return yield* Effect.fail(result.error);
      return result.value as A;
    });
  }

  currentUnavailable(): RuntimeClosing | RuntimeClosed {
    return this.runtimeState === "Closing"
      ? new RuntimeClosing({ state: "Closing" })
      : new RuntimeClosed({
          state: this.runtimeState === "CloseFailed" ? "CloseFailed" : "Closed",
        });
  }

  publicRequest<A>(makeCommand: (reply: ReplyDeferred) => Command): Effect.Effect<A, unknown> {
    return this.request(makeCommand, () =>
      this.runtimeState === "Running" ? undefined : failure(this.currentUnavailable()),
    );
  }

  graph(): readonly GraphNode[] {
    return Array.from(this.nodes.values(), graphNode);
  }

  nodeByExport(key: string): NodeRecord | undefined {
    for (const node of this.nodes.values()) {
      if (node.description.exportKey === key) return node;
    }
    return undefined;
  }

  invalidate(nodeIds: ReadonlySet<string>, reason: RevocationReason, rootId?: string): void {
    for (const id of nodeIds) {
      const node = this.nodes.get(id);
      if (node === undefined) continue;
      const generation =
        node.generationId === undefined ? undefined : this.generations.get(node.generationId);
      if (generation !== undefined && generation.status !== "Stopping") {
        generation.status = "Stopping";
        node.phase = "Stopping";
        node.lastRevocation = Object.freeze({
          generationId: generation.id,
          reason,
          ...(rootId === undefined ? {} : { rootId }),
        });
        this.publications.delete(node.description.exportKey);
      }
    }
  }

  invalidateFrom(
    rootIds: ReadonlySet<string>,
    reason: RevocationReason,
    graph: readonly GraphNode[] = this.graph(),
  ): void {
    const rootId = rootIds.values().next().value as string | undefined;
    this.invalidate(affectedClosure(graph, rootIds), reason, rootId);
  }

  interruptWatcher(token: number | undefined): Effect.Effect<void> {
    if (token === undefined) return Effect.void;
    const watcher = this.gateWatchers.get(token);
    if (watcher === undefined || watcher.interruptStarted) return Effect.void;
    watcher.interruptStarted = true;
    this.lifecycleWorkers++;
    return Effect.forkIn(
      Fiber.interrupt(watcher.fiber).pipe(
        Effect.ensuring(this.offer({ _tag: "WorkerComplete", gateToken: token })),
      ),
      this.executionScope,
    ).pipe(Effect.asVoid);
  }

  startGateWatcher(node: NodeRecord): Effect.Effect<void> {
    const gate = node.description.when;
    if (gate === undefined) {
      node.gateKnown = true;
      node.gateValue = true;
      node.gateClosed = false;
      return Effect.void;
    }
    const gateToken = this.nextGateToken++;
    const registrationId = node.registrationId;
    node.gateToken = gateToken;
    node.gateKnown = false;
    node.gateClosed = false;
    const observe = SubscriptionRef.changes(gate).pipe(
      Stream.runForEach((value) =>
        this.offer({ _tag: "GateValue", registrationId, gateToken, value }),
      ),
    );
    const watcherEffect = Effect.uninterruptibleMask((restore) =>
      Effect.exit(restore(observe)).pipe(
        Effect.flatMap((exit) => this.offer({ _tag: "GateComplete", gateToken, exit })),
      ),
    );
    return Effect.gen(this, function* () {
      const fiber = yield* Effect.forkIn(watcherEffect, this.executionScope);
      this.gateWatchers.set(gateToken, { registrationId, fiber, interruptStarted: false });
    });
  }

  fingerprint(node: NodeRecord, dependencies: ReadonlyMap<string, number>): string {
    const dependencyPart = Array.from(dependencies)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, generation]) => `${key}:${generation}`)
      .join(",");
    return `${node.registrationId}/${node.recipeRevision}/${node.activationRevision}/${node.gateRevision}/${dependencyPart}`;
  }

  dependencySelection(node: NodeRecord):
    | {
        readonly _tag: "Ready";
        readonly generations: ReadonlyMap<string, number>;
        readonly context: Context.Context<unknown>;
      }
    | { readonly _tag: "Pending"; readonly reasons: readonly PendingReason[] } {
    const generations = new Map<string, number>();
    // Runtime construction captures the ambient services once; graph erasure is the only type-erased context seam.
    let context = eraseCapturedContext(this.staticContext);
    const reasons: PendingReason[] = [];
    for (const key of node.description.requirementKeys) {
      const publication = this.publications.get(key);
      if (publication === undefined) {
        reasons.push(
          this.nodeByExport(key) === undefined
            ? { _tag: "MissingService", serviceKey: key }
            : { _tag: "DependencyNotActive", serviceKey: key },
        );
      } else {
        generations.set(key, publication.generationId);
        context = Context.addUnsafe(context, key, publication.service);
      }
    }
    return reasons.length === 0
      ? { _tag: "Ready", generations, context }
      : { _tag: "Pending", reasons: Object.freeze(reasons) };
  }

  startGeneration(
    node: NodeRecord,
    dependencies: ReadonlyMap<string, number>,
    inputContext: Context.Context<unknown>,
    fingerprint: string,
  ): Effect.Effect<void> {
    return Effect.uninterruptible(
      Effect.gen(this, function* () {
        const generationId = this.nextGenerationId++;
        const scope = yield* Scope.make("sequential");
        const memoMap = yield* Layer.makeMemoMap;
        const generation: Generation = {
          id: generationId,
          nodeId: node.description.id,
          registrationId: node.registrationId,
          recipeRevision: node.recipeRevision,
          activationRevision: node.activationRevision,
          gateRevision: node.gateRevision,
          dependencyGenerations: new Map(dependencies),
          fingerprint,
          scope,
          status: "Starting",
          buildFiber: undefined,
          stopStarted: false,
          pendingFailure: undefined,
          calls: new Set(),
        };
        this.generations.set(generationId, generation);
        node.generationId = generationId;
        node.phase = "Starting";
        node.failure = undefined;
        node.pendingReasons = [];
        node.attempts++;
        this.lifecycleWorkers++;
        const acquire = Layer.buildWithMemoMap(node.description.layer, memoMap, scope).pipe(
          Effect.provide(inputContext),
        );
        const build = Effect.uninterruptibleMask((restore) =>
          Effect.exit(restore(acquire)).pipe(
            Effect.flatMap((exit) => this.offer({ _tag: "BuildComplete", generationId, exit })),
          ),
        );
        generation.buildFiber = yield* Effect.forkIn(build, this.executionScope);
      }),
    );
  }

  reconcile(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (this.runtimeState === "Running") {
        const order = topologicalOrder(this.graph());
        for (const id of order) {
          const node = this.nodes.get(id);
          if (node === undefined || node.retiring || node.quarantined) continue;
          if (node.generationId !== undefined) continue;
          if (!node.desiredEnabled) {
            node.phase = "Disabled";
            node.pendingReasons = [];
            continue;
          }
          if (!node.gateKnown) {
            node.phase = "Pending";
            node.pendingReasons = [{ _tag: "GateInitializing" }];
            continue;
          }
          if (!node.gateValue || node.gateClosed) {
            node.phase = "Pending";
            node.pendingReasons = [{ _tag: "GateClosed" }];
            continue;
          }
          const selected = this.dependencySelection(node);
          if (selected._tag === "Pending") {
            node.phase = "Pending";
            node.pendingReasons = selected.reasons;
            continue;
          }
          const fingerprint = this.fingerprint(node, selected.generations);
          if (node.failedFingerprint === fingerprint) {
            node.phase = "Failed";
            continue;
          }
          yield* this.startGeneration(node, selected.generations, selected.context, fingerprint);
        }
      }
      yield* this.startEligibleStops();
      this.removeFinishedRetirements();
    });
  }

  startEligibleStops(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      for (const generation of this.generations.values()) {
        if (generation.status !== "Stopping" || generation.stopStarted) continue;
        let hasDependent = false;
        for (const candidate of this.generations.values()) {
          if (
            candidate.id !== generation.id &&
            Array.from(candidate.dependencyGenerations.values()).includes(generation.id)
          ) {
            hasDependent = true;
            break;
          }
        }
        if (hasDependent) continue;
        const pendingCall = Array.from(generation.calls).some((id) => {
          const call = this.calls.get(id);
          return call !== undefined && call.fiber === undefined;
        });
        if (pendingCall) continue;
        for (const callId of generation.calls) yield* this.interruptCall(callId);
        if (generation.calls.size > 0) continue;
        generation.stopStarted = true;
        this.lifecycleWorkers++;
        const stop = Effect.gen(this, function* () {
          if (generation.buildFiber !== undefined) yield* Fiber.interrupt(generation.buildFiber);
          return yield* Effect.exit(Scope.close(generation.scope, Exit.void));
        }).pipe(
          Effect.flatMap((exit) =>
            this.offer({ _tag: "StopComplete", generationId: generation.id, exit }),
          ),
        );
        yield* Effect.forkIn(stop, this.executionScope);
      }
    });
  }

  interruptCall(callId: number): Effect.Effect<void> {
    const call = this.calls.get(callId);
    if (call === undefined || call.fiber === undefined || call.interruptStarted) return Effect.void;
    call.interruptStarted = true;
    this.lifecycleWorkers++;
    return Effect.forkIn(
      Fiber.interrupt(call.fiber).pipe(Effect.ensuring(this.offer({ _tag: "WorkerComplete" }))),
      this.executionScope,
    ).pipe(Effect.asVoid);
  }

  removeFinishedRetirements(): void {
    for (const [id, node] of this.nodes) {
      if (!node.retiring || node.generationId !== undefined || node.quarantined) continue;
      if (node.gateToken !== undefined && this.gateWatchers.has(node.gateToken)) continue;
      if (node.retirementGateToken !== undefined) continue;
      this.nodes.delete(id);
    }
  }

  isIdle(): boolean {
    if (Queue.sizeUnsafe(this.mailbox) !== 0) return false;
    if (this.lifecycleWorkers !== 0 || this.calls.size !== 0) return false;
    for (const generation of this.generations.values()) {
      if (generation.status === "Starting" || generation.status === "Stopping") return false;
    }
    return true;
  }

  stateOf(node: NodeRecord): NodeState {
    const pending = (): NodeState => ({
      _tag: "Pending",
      reasons: Object.freeze(node.pendingReasons.map((reason) => Object.freeze({ ...reason }))),
    });
    switch (node.phase) {
      case "Pending":
        return pending();
      case "Disabled":
        return { _tag: "Disabled" };
      case "Starting":
      case "Active":
      case "Stopping":
        return node.generationId === undefined
          ? pending()
          : { _tag: node.phase, generationId: node.generationId };
      case "Failed":
        return node.failure === undefined
          ? pending()
          : { _tag: "Failed", failure: Object.freeze({ ...node.failure }) };
    }
  }

  makeSnapshot(): RuntimeSnapshot {
    const nodes: NodeSnapshot[] = Array.from(this.nodes.values(), (node) => {
      const generation =
        node.generationId === undefined ? undefined : this.generations.get(node.generationId);
      const dependencyGenerations: Record<string, number> = {};
      if (generation !== undefined) {
        for (const [key, id] of generation.dependencyGenerations) dependencyGenerations[key] = id;
      }
      const snapshot: NodeSnapshot = {
        id: node.description.id,
        exportKey: node.description.exportKey,
        requirementKeys: Object.freeze(Array.from(node.description.requirementKeys)),
        desiredEnabled: node.desiredEnabled,
        ...(node.lastRevocation === undefined
          ? {}
          : { lastRevocation: Object.freeze({ ...node.lastRevocation }) }),
        recipeRevision: node.recipeRevision,
        registrationId: node.registrationId,
        gateRevision: node.gateRevision,
        dependencyGenerations: Object.freeze(dependencyGenerations),
        state: Object.freeze(this.stateOf(node)),
        ...(node.generationId === undefined ? {} : { generationId: node.generationId }),
      };
      return Object.freeze(snapshot);
    }).sort((left, right) => left.id.localeCompare(right.id));
    return Object.freeze({
      state: this.runtimeState,
      version: this.version,
      liveGenerations: this.generations.size,
      managedCalls: this.calls.size,
      gateWatchers: this.gateWatchers.size,
      lifecycleWorkers: this.lifecycleWorkers,
      nodes: Object.freeze(nodes),
    });
  }

  publishSnapshot(): Effect.Effect<void> {
    this.version++;
    this.lastSnapshot = this.makeSnapshot();
    return SubscriptionRef.set(this.snapshots, this.lastSnapshot);
  }

  evaluateWaiters(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      for (const [waiterId, waiter] of Array.from(this.waiters)) {
        if (waiter._tag === "Idle") {
          if (this.isIdle()) {
            this.waiters.delete(waiterId);
            yield* complete(waiter.reply, success());
          }
          continue;
        }
        const node = this.nodes.get(waiter.id);
        if (node === undefined || node.retiring) {
          this.waiters.delete(waiterId);
          yield* complete(
            waiter.reply,
            failure(new AwaitStateUnavailable({ id: waiter.id, expected: waiter.expected })),
          );
        } else if (node.phase === waiter.expected) {
          this.waiters.delete(waiterId);
          yield* complete(waiter.reply, success());
        } else if (
          node.phase === "Failed" &&
          waiter.expected !== "Failed" &&
          node.failure !== undefined
        ) {
          this.waiters.delete(waiterId);
          yield* complete(
            waiter.reply,
            failure(
              new AwaitStateFailed({
                id: waiter.id,
                expected: waiter.expected,
                failure: node.failure,
              }),
            ),
          );
        }
      }
    });
  }

  checkShutdown(): Effect.Effect<boolean> {
    return Effect.gen(this, function* () {
      if (this.runtimeState !== "Closing") return true;
      if (this.generations.size !== 0 || this.calls.size !== 0 || this.lifecycleWorkers !== 0)
        return true;
      if (this.gateWatchers.size !== 0) {
        for (const token of this.gateWatchers.keys()) yield* this.interruptWatcher(token);
        yield* this.publishSnapshot();
        return true;
      }
      // Every command accepted before terminal transition must receive its acknowledgement.
      if (Queue.sizeUnsafe(this.mailbox) !== 0) return true;
      this.runtimeState = this.releaseFailures.length === 0 ? "Closed" : "CloseFailed";
      yield* this.publishSnapshot();
      const reply =
        this.releaseFailures.length === 0
          ? success()
          : failure(
              new ShutdownFailed({ causes: Object.freeze(Array.from(this.releaseFailures)) }),
            );
      for (const waiter of this.shutdownWaiters.splice(0)) yield* complete(waiter, reply);
      return false;
    });
  }

  rejectWhenClosing(reply: ReplyDeferred): Effect.Effect<boolean> {
    if (this.runtimeState === "Running") return Effect.succeed(false);
    return complete(reply, failure(this.currentUnavailable())).pipe(Effect.as(true));
  }

  handleRegister(description: ErasedDescription, reply: ReplyDeferred): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (yield* this.rejectWhenClosing(reply)) return;
      for (const node of this.nodes.values()) {
        if (
          node.retiring &&
          (node.description.id === description.id ||
            node.description.exportKey === description.exportKey)
        ) {
          yield* complete(
            reply,
            failure(
              new NodeRetiring({
                ...(node.description.id === description.id ? { id: description.id } : {}),
                ...(node.description.exportKey === description.exportKey
                  ? { exportKey: description.exportKey }
                  : {}),
              }),
            ),
          );
          return;
        }
      }
      const candidate: GraphNode[] = [
        ...this.graph(),
        {
          id: description.id,
          exportKey: description.exportKey,
          requirementKeys: description.requirementKeys,
        },
      ];
      const graphError = validateGraph(candidate);
      if (graphError !== undefined) {
        yield* complete(reply, failure(new GraphRejected({ error: graphError })));
        return;
      }
      const node: NodeRecord = {
        description,
        registrationId: this.nextRegistrationId++,
        recipeRevision: 1,
        activationRevision: 1,
        desiredEnabled: true,
        gateKnown: description.when === undefined,
        gateValue: description.when === undefined,
        gateClosed: false,
        gateRevision: 0,
        gateToken: undefined,
        retirementGateToken: undefined,
        generationId: undefined,
        phase: "Pending",
        pendingReasons: description.when === undefined ? [] : [{ _tag: "GateInitializing" }],
        failure: undefined,
        failedFingerprint: undefined,
        retiring: false,
        quarantined: false,
        lastRevocation: undefined,
        attempts: 0,
      };
      this.nodes.set(description.id, node);
      yield* this.startGateWatcher(node);
      yield* this.reconcile();
      yield* this.publishSnapshot();
      yield* complete(reply, success());
    });
  }

  handleReplace(
    id: string,
    description: ErasedDescription,
    reply: ReplyDeferred,
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (yield* this.rejectWhenClosing(reply)) return;
      const node = this.nodes.get(id);
      if (node === undefined) {
        yield* complete(reply, failure(new UnknownNode({ id })));
        return;
      }
      if (node.retiring) {
        yield* complete(reply, failure(new NodeRetiring({ id })));
        return;
      }
      if (description.id !== id || description.exportKey !== node.description.exportKey) {
        yield* complete(
          reply,
          failure(
            new ReplaceMismatch({
              id,
              descriptionId: description.id,
              currentExportKey: node.description.exportKey,
              replacementExportKey: description.exportKey,
            }),
          ),
        );
        return;
      }
      const candidate = this.graph().map((entry) =>
        entry.id === id
          ? { id, exportKey: description.exportKey, requirementKeys: description.requirementKeys }
          : entry,
      );
      const graphError = validateGraph(candidate);
      if (graphError !== undefined) {
        yield* complete(reply, failure(new GraphRejected({ error: graphError })));
        return;
      }
      const affected = affectedClosure(this.graph(), new Set([id]));
      yield* this.interruptWatcher(node.gateToken);
      node.registrationId = this.nextRegistrationId++;
      node.recipeRevision++;
      node.activationRevision++;
      node.description = description;
      node.gateToken = undefined;
      node.gateKnown = description.when === undefined;
      node.gateValue = description.when === undefined;
      node.gateClosed = false;
      node.gateRevision++;
      if (!node.quarantined) {
        node.failure = undefined;
        node.failedFingerprint = undefined;
      }
      this.invalidate(affected, "Replace", id);
      yield* this.startGateWatcher(node);
      yield* this.reconcile();
      yield* this.publishSnapshot();
      yield* complete(reply, success());
    });
  }

  handleToggle(id: string, enabled: boolean, reply: ReplyDeferred): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (yield* this.rejectWhenClosing(reply)) return;
      const node = this.nodes.get(id);
      if (node === undefined) {
        yield* complete(reply, failure(new UnknownNode({ id })));
        return;
      }
      if (node.retiring) {
        yield* complete(reply, failure(new NodeRetiring({ id })));
        return;
      }
      if (node.desiredEnabled === enabled) {
        yield* complete(reply, success());
        return;
      }
      node.desiredEnabled = enabled;
      node.activationRevision++;
      if (!node.quarantined) {
        node.failure = undefined;
        node.failedFingerprint = undefined;
      }
      if (!enabled) this.invalidateFrom(new Set([id]), "Disable");
      yield* this.reconcile();
      yield* this.publishSnapshot();
      yield* complete(reply, success());
    });
  }

  handleRetry(id: string, reply: ReplyDeferred): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (yield* this.rejectWhenClosing(reply)) return;
      const node = this.nodes.get(id);
      if (node === undefined) {
        yield* complete(reply, failure(new UnknownNode({ id })));
        return;
      }
      if (node.retiring) {
        yield* complete(reply, failure(new NodeRetiring({ id })));
        return;
      }
      if (node.phase === "Failed" && !node.quarantined) {
        node.failedFingerprint = undefined;
        node.failure = undefined;
        yield* this.reconcile();
        yield* this.publishSnapshot();
      }
      yield* complete(reply, success());
    });
  }

  handleUnregister(id: string, reply: ReplyDeferred): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (yield* this.rejectWhenClosing(reply)) return;
      const node = this.nodes.get(id);
      if (node === undefined) {
        yield* complete(reply, failure(new UnknownNode({ id })));
        return;
      }
      if (node.retiring) {
        yield* complete(reply, failure(new NodeRetiring({ id })));
        return;
      }
      const oldGraph = this.graph();
      node.retiring = true;
      node.desiredEnabled = false;
      node.activationRevision++;
      this.invalidate(affectedClosure(oldGraph, new Set([id])), "Unregister", id);
      node.retirementGateToken = node.gateToken;
      yield* this.interruptWatcher(node.gateToken);
      yield* this.reconcile();
      yield* this.publishSnapshot();
      yield* complete(reply, success());
    });
  }

  handleGateValue(registrationId: number, gateToken: number, value: boolean): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const node = Array.from(this.nodes.values()).find(
        (candidate) => candidate.registrationId === registrationId,
      );
      if (node === undefined || node.gateToken !== gateToken || node.retiring) return;
      const changed = !node.gateKnown || node.gateValue !== value;
      node.gateKnown = true;
      node.gateClosed = false;
      if (!changed) return;
      node.gateValue = value;
      node.gateRevision++;
      if (!node.quarantined) {
        node.failure = undefined;
        node.failedFingerprint = undefined;
      }
      if (!value) this.invalidateFrom(new Set([node.description.id]), "GateClosed");
      yield* this.reconcile();
      yield* this.publishSnapshot();
    });
  }

  handleGateComplete(gateToken: number, exit: Exit.Exit<void, unknown>): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const watcher = this.gateWatchers.get(gateToken);
      if (watcher === undefined) return;
      this.gateWatchers.delete(gateToken);
      const node = Array.from(this.nodes.values()).find(
        (candidate) => candidate.registrationId === watcher.registrationId,
      );
      if (node !== undefined && node.gateToken === gateToken) {
        node.gateToken = undefined;
        const cause = causeOf(exit);
        const expectedInterrupt =
          cause !== undefined && Cause.hasInterrupts(cause) && watcher.interruptStarted;
        if (!node.retiring && this.runtimeState === "Running" && !expectedInterrupt) {
          node.gateKnown = true;
          node.gateValue = false;
          node.gateClosed = true;
          node.gateRevision++;
          this.invalidateFrom(new Set([node.description.id]), "GateClosed");
          if (cause !== undefined) {
            node.failure = {
              phase: "gate",
              cause,
              fingerprint: `${node.registrationId}/${node.gateRevision}`,
              attempt: node.attempts,
            };
            node.phase = "Failed";
          }
        }
      }
      yield* this.reconcile();
      yield* this.publishSnapshot();
    });
  }

  handleBuildComplete(
    generationId: number,
    exit: Exit.Exit<Context.Context<unknown>, unknown>,
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      this.lifecycleWorkers--;
      const generation = this.generations.get(generationId);
      if (generation === undefined) {
        yield* this.publishSnapshot();
        return;
      }
      const node = this.nodes.get(generation.nodeId);
      const stillCurrent =
        node !== undefined &&
        node.generationId === generation.id &&
        node.registrationId === generation.registrationId &&
        node.recipeRevision === generation.recipeRevision &&
        node.activationRevision === generation.activationRevision &&
        node.gateRevision === generation.gateRevision &&
        node.desiredEnabled &&
        node.gateKnown &&
        node.gateValue &&
        !node.gateClosed &&
        !node.retiring;
      let dependenciesCurrent = true;
      for (const [key, selectedId] of generation.dependencyGenerations) {
        if (this.publications.get(key)?.generationId !== selectedId) dependenciesCurrent = false;
      }
      if (
        generation.status === "Starting" &&
        stillCurrent &&
        dependenciesCurrent &&
        Exit.isSuccess(exit)
      ) {
        const output = extractOutput(node.description, exit.value);
        if (Option.isSome(output)) {
          const service = output.value;
          generation.status = "Active";
          generation.buildFiber = undefined;
          node.phase = "Active";
          this.publications.set(node.description.exportKey, { generationId, service });
        } else {
          const invalid = new InvalidExport({
            id: node.description.id,
            exportKey: node.description.exportKey,
          });
          generation.pendingFailure = {
            phase: "acquire",
            cause: Cause.fail(invalid),
            generationId,
            fingerprint: generation.fingerprint,
            attempt: node.attempts,
          };
          generation.status = "Stopping";
          node.phase = "Stopping";
        }
      } else {
        if (generation.status === "Starting") {
          generation.status = "Stopping";
          if (node !== undefined) node.phase = "Stopping";
        }
        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
          // Multiple defects are conservatively treated as acquisition plus rollback failure:
          // public Layer causes do not label which defect came from a finalizer.
          const rollbackFailure =
            exit.cause.reasons.filter(Cause.isDieReason).length > 1 ||
            (Cause.hasDies(exit.cause) &&
              (Cause.hasFails(exit.cause) || Cause.hasInterrupts(exit.cause)));
          if (rollbackFailure || (stillCurrent && dependenciesCurrent)) {
            generation.pendingFailure = {
              phase: rollbackFailure ? "release" : "acquire",
              cause: exit.cause,
              generationId,
              fingerprint: generation.fingerprint,
              attempt: node?.attempts ?? 0,
            };
          }
        }
      }
      yield* this.reconcile();
      yield* this.publishSnapshot();
    });
  }

  handleStopComplete(generationId: number, exit: Exit.Exit<void, unknown>): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      this.lifecycleWorkers--;
      const generation = this.generations.get(generationId);
      if (generation === undefined) {
        yield* this.publishSnapshot();
        return;
      }
      this.generations.delete(generationId);
      const node = this.nodes.get(generation.nodeId);
      if (node !== undefined && node.generationId === generationId) {
        node.generationId = undefined;
        const releaseCause = causeOf(exit);
        if (releaseCause !== undefined) {
          const diagnostic: FailureDiagnostic = {
            phase: "release",
            cause: releaseCause,
            generationId,
            fingerprint: generation.fingerprint,
            attempt: node.attempts,
          };
          node.failure = diagnostic;
          node.failedFingerprint = generation.fingerprint;
          node.phase = "Failed";
          node.quarantined = true;
          this.releaseFailures.push(releaseCause);
        } else if (generation.pendingFailure?.phase === "release") {
          node.failure = generation.pendingFailure;
          node.failedFingerprint = generation.pendingFailure.fingerprint;
          node.phase = "Failed";
          node.quarantined = true;
          this.releaseFailures.push(generation.pendingFailure.cause);
        } else if (
          generation.pendingFailure !== undefined &&
          node.registrationId === generation.registrationId &&
          !node.retiring
        ) {
          node.failure = generation.pendingFailure;
          node.failedFingerprint = generation.pendingFailure.fingerprint;
          node.phase = "Failed";
        } else if (node.retiring) {
          node.phase = "Disabled";
        } else if (!node.desiredEnabled) {
          node.phase = "Disabled";
        } else {
          node.phase = "Pending";
        }
      }
      yield* this.reconcile();
      yield* this.publishSnapshot();
    });
  }

  handleAdmit(serviceKey: string, reply: ReplyDeferred): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (yield* this.rejectWhenClosing(reply)) return;
      const publication = this.publications.get(serviceKey);
      const generation =
        publication === undefined ? undefined : this.generations.get(publication.generationId);
      if (publication === undefined || generation === undefined || generation.status !== "Active") {
        yield* complete(reply, failure(new ServiceUnavailable({ serviceKey })));
        return;
      }
      const callId = this.nextCallId++;
      const call: ManagedCall = {
        id: callId,
        generationId: generation.id,
        fiber: undefined,
        interruptStarted: false,
      };
      this.calls.set(callId, call);
      generation.calls.add(callId);
      yield* this.publishSnapshot();
      yield* complete(
        reply,
        success({
          callId,
          generationId: generation.id,
          serviceKey,
          service: publication.service,
        } satisfies Admission),
      );
    });
  }

  handleAttachCall(
    callId: number,
    fiber: Fiber.Fiber<unknown, unknown>,
    permit: Deferred.Deferred<void>,
    reply: ReplyDeferred,
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const call = this.calls.get(callId);
      if (call === undefined) {
        yield* Fiber.interrupt(fiber);
        yield* complete(reply, success());
        return;
      }
      call.fiber = fiber;
      const generation = this.generations.get(call.generationId);
      if (generation !== undefined && generation.status === "Active") {
        yield* Deferred.succeed(permit, void 0);
      } else {
        yield* this.interruptCall(callId);
      }
      yield* complete(reply, success());
      yield* this.reconcile();
      yield* this.publishSnapshot();
    });
  }

  handleCallComplete(callId: number, exit: Exit.Exit<void, unknown>): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const call = this.calls.get(callId);
      if (call === undefined) return;
      this.calls.delete(callId);
      const generation = this.generations.get(call.generationId);
      generation?.calls.delete(callId);
      if (generation !== undefined && Exit.isFailure(exit)) {
        const node = this.nodes.get(generation.nodeId);
        generation.pendingFailure = {
          phase: "release",
          cause: exit.cause,
          generationId: generation.id,
          fingerprint: generation.fingerprint,
          attempt: node?.attempts ?? 0,
        };
        this.invalidateFrom(new Set([generation.nodeId]), "DependencyInvalidated");
      }
      yield* this.reconcile();
      yield* this.publishSnapshot();
    });
  }

  handleShutdown(reply: ReplyDeferred): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (this.runtimeState === "Closed") {
        yield* complete(reply, success());
        return;
      }
      if (this.runtimeState === "CloseFailed") {
        yield* complete(
          reply,
          failure(new ShutdownFailed({ causes: Object.freeze(Array.from(this.releaseFailures)) })),
        );
        return;
      }
      this.shutdownWaiters.push(reply);
      if (this.runtimeState === "Closing") return;
      this.runtimeState = "Closing";
      this.invalidate(new Set(this.nodes.keys()), "Shutdown");
      for (const node of this.nodes.values()) node.desiredEnabled = false;
      for (const [waiterId, waiter] of this.waiters) {
        yield* complete(waiter.reply, failure(new RuntimeClosing({ state: "Closing" })));
        this.waiters.delete(waiterId);
      }
      yield* this.reconcile();
      yield* this.publishSnapshot();
    });
  }

  handle(command: Command): Effect.Effect<void> {
    switch (command._tag) {
      case "Register":
        return this.handleRegister(command.description, command.reply);
      case "Replace":
        return this.handleReplace(command.id, command.description, command.reply);
      case "Enable":
        return this.handleToggle(command.id, true, command.reply);
      case "Disable":
        return this.handleToggle(command.id, false, command.reply);
      case "Retry":
        return this.handleRetry(command.id, command.reply);
      case "Unregister":
        return this.handleUnregister(command.id, command.reply);
      case "Snapshot":
        return complete(command.reply, success(this.lastSnapshot));
      case "Shutdown":
        return this.handleShutdown(command.reply);
      case "GateValue":
        return this.handleGateValue(command.registrationId, command.gateToken, command.value);
      case "GateComplete":
        return this.handleGateComplete(command.gateToken, command.exit);
      case "BuildComplete":
        return this.handleBuildComplete(command.generationId, command.exit);
      case "StopComplete":
        return this.handleStopComplete(command.generationId, command.exit);
      case "WorkerComplete":
        this.lifecycleWorkers--;
        if (command.gateToken !== undefined) {
          this.gateWatchers.delete(command.gateToken);
          for (const node of this.nodes.values()) {
            if (node.gateToken === command.gateToken) node.gateToken = undefined;
            if (node.retirementGateToken === command.gateToken)
              node.retirementGateToken = undefined;
          }
        }
        return this.reconcile().pipe(Effect.andThen(this.publishSnapshot()));
      case "Admit":
        return this.handleAdmit(command.serviceKey, command.reply);
      case "AttachCall":
        return this.handleAttachCall(command.callId, command.fiber, command.permit, command.reply);
      case "CallComplete":
        return this.handleCallComplete(command.callId, command.exit);
      case "CancelWaiter":
        this.waiters.delete(command.waiterId);
        return Effect.void;
      case "AwaitState": {
        if (this.runtimeState !== "Running")
          return complete(command.reply, failure(this.currentUnavailable()));
        const node = this.nodes.get(command.id);
        if (node === undefined || node.retiring)
          return complete(command.reply, failure(new UnknownNode({ id: command.id })));
        this.waiters.set(command.waiterId, {
          _tag: "State",
          id: command.id,
          expected: command.expected,
          reply: command.reply,
        });
        return this.evaluateWaiters();
      }
      case "AwaitIdle":
        if (this.runtimeState !== "Running")
          return complete(command.reply, failure(this.currentUnavailable()));
        this.waiters.set(command.waiterId, { _tag: "Idle", reply: command.reply });
        return this.evaluateWaiters();
    }
  }

  loop(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      while (true) {
        const command = yield* Queue.take(this.mailbox);
        yield* this.handle(command);
        yield* this.evaluateWaiters();
        if (!(yield* this.checkShutdown())) return;
      }
    });
  }
}

export interface DynamicRuntime {
  readonly snapshot: Effect.Effect<RuntimeSnapshot, RuntimeClosing | RuntimeClosed>;
  readonly changes: Stream.Stream<RuntimeSnapshot>;
  /** Ordered and uninterruptible like Scope.close; cancellation never force-detaches cleanup. */
  readonly shutdown: Effect.Effect<void, ShutdownFailed>;
  register<ROut, E, RIn>(
    description: DynamicLayerModel.DynamicLayer<ROut, E, RIn>,
  ): Effect.Effect<void, CommandError>;
  replace<ROut, E, RIn>(
    id: string,
    description: DynamicLayerModel.DynamicLayer<ROut, E, RIn>,
  ): Effect.Effect<void, CommandError>;
  enable(id: string): Effect.Effect<void, CommandError>;
  disable(id: string): Effect.Effect<void, CommandError>;
  unregister(id: string): Effect.Effect<void, CommandError>;
  retry(id: string): Effect.Effect<void, CommandError>;
  awaitState(id: string, state: StateTag): Effect.Effect<void, AwaitError>;
  awaitIdle(): Effect.Effect<void, RuntimeClosing | RuntimeClosed>;
  use<I, S, A, E, R>(
    service: Context.Key<I, S>,
    callback: (service: S) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | UseError, Exclude<R, Scope.Scope>>;
}

const awaitWithCancellation = <A>(
  controller: RuntimeController,
  waiterId: number,
  command: (reply: ReplyDeferred) => Command,
): Effect.Effect<A, unknown> =>
  Effect.uninterruptibleMask((restore) =>
    restore(controller.publicRequest<A>(command)).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          Queue.offerUnsafe(controller.mailbox, { _tag: "CancelWaiter", waiterId });
        }),
      ),
    ),
  );

const makeRuntime = Effect.uninterruptible(
  Effect.gen(function* () {
    const owningScope = yield* Scope.Scope;
    const staticContext = yield* Effect.context<never>();
    const mailbox = yield* Queue.unbounded<Command>();
    const executionScope = yield* Scope.make("sequential");
    const initial: RuntimeSnapshot = Object.freeze({
      state: "Running",
      version: 0,
      liveGenerations: 0,
      managedCalls: 0,
      gateWatchers: 0,
      lifecycleWorkers: 0,
      nodes: Object.freeze([]),
    });
    const snapshots = yield* SubscriptionRef.make(initial);
    const controller = new RuntimeController(mailbox, snapshots, executionScope, staticContext);
    const controllerFiber = yield* Effect.forkIn(controller.loop(), executionScope);

    const shutdown = Effect.suspend(() => {
      if (controller.runtimeState === "Closed") return Effect.void;
      if (controller.runtimeState === "CloseFailed") {
        return Effect.fail(
          new ShutdownFailed({ causes: Object.freeze(Array.from(controller.releaseFailures)) }),
        );
      }
      return Effect.uninterruptible(
        controller.request<void>(
          (reply) => ({ _tag: "Shutdown", reply }),
          () => {
            if (controller.runtimeState === "Running" || controller.runtimeState === "Closing")
              return undefined;
            return controller.runtimeState === "Closed"
              ? success()
              : failure(
                  new ShutdownFailed({
                    causes: Object.freeze(Array.from(controller.releaseFailures)),
                  }),
                );
          },
        ),
      ).pipe(
        Effect.onExit(() =>
          Fiber.await(controllerFiber).pipe(
            Effect.andThen(Scope.close(executionScope, Exit.void)),
            Effect.asVoid,
          ),
        ),
      ) as Effect.Effect<void, ShutdownFailed>;
    });

    const use = <I, S, A, E, R>(
      service: Context.Key<I, S>,
      callback: (service: S) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | UseError, Exclude<R, Scope.Scope>> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const admission = yield* controller.publicRequest<Admission>((reply) => ({
            _tag: "Admit",
            serviceKey: service.key,
            reply,
          }));
          const callScope = yield* Scope.make("sequential");
          const permit = yield* Deferred.make<void>();
          const callbackEffect = Deferred.await(permit).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                callback(recoverService(service, admission.serviceKey, admission.service)),
              ),
            ),
            Effect.provideService(Scope.Scope, callScope),
          );
          const fiber = yield* Effect.forkIn(callbackEffect, callScope);
          yield* controller.request<void>((reply) => ({
            _tag: "AttachCall",
            callId: admission.callId,
            fiber,
            permit,
            reply,
          }));
          return yield* restore(Fiber.join(fiber)).pipe(
            Effect.ensuring(
              Effect.exit(Scope.close(callScope, Exit.void)).pipe(
                Effect.flatMap((exit) =>
                  controller
                    .offer({ _tag: "CallComplete", callId: admission.callId, exit })
                    .pipe(Effect.andThen(exit)),
                ),
              ),
            ),
          );
        }),
      ) as Effect.Effect<A, E | UseError, Exclude<R, Scope.Scope>>;

    const runtime: DynamicRuntime = {
      get snapshot() {
        return Effect.suspend(() =>
          controller.runtimeState !== "Running"
            ? Effect.succeed(controller.lastSnapshot)
            : controller.publicRequest<RuntimeSnapshot>((reply) => ({ _tag: "Snapshot", reply })),
        ) as DynamicRuntime["snapshot"];
      },
      changes: SubscriptionRef.changes(snapshots),
      shutdown,
      register: (description) =>
        controller.publicRequest<void>((reply) => ({
          _tag: "Register",
          description: eraseDescription(description),
          reply,
        })) as Effect.Effect<void, CommandError>,
      replace: (id, description) =>
        controller.publicRequest<void>((reply) => ({
          _tag: "Replace",
          id,
          description: eraseDescription(description),
          reply,
        })) as Effect.Effect<void, CommandError>,
      enable: (id) =>
        controller.publicRequest<void>((reply) => ({ _tag: "Enable", id, reply })) as Effect.Effect<
          void,
          CommandError
        >,
      disable: (id) =>
        controller.publicRequest<void>((reply) => ({
          _tag: "Disable",
          id,
          reply,
        })) as Effect.Effect<void, CommandError>,
      unregister: (id) =>
        controller.publicRequest<void>((reply) => ({
          _tag: "Unregister",
          id,
          reply,
        })) as Effect.Effect<void, CommandError>,
      retry: (id) =>
        controller.publicRequest<void>((reply) => ({ _tag: "Retry", id, reply })) as Effect.Effect<
          void,
          CommandError
        >,
      awaitState: (id, state) =>
        Effect.suspend(() => {
          if (controller.runtimeState !== "Running")
            return Effect.fail(controller.currentUnavailable());
          const waiterId = controller.nextWaiterId++;
          return awaitWithCancellation<void>(controller, waiterId, (reply) => ({
            _tag: "AwaitState",
            id,
            expected: state,
            waiterId,
            reply,
          }));
        }) as Effect.Effect<void, AwaitError>,
      awaitIdle: () =>
        Effect.suspend(() => {
          if (controller.runtimeState !== "Running")
            return Effect.fail(controller.currentUnavailable());
          const waiterId = controller.nextWaiterId++;
          return awaitWithCancellation<void>(controller, waiterId, (reply) => ({
            _tag: "AwaitIdle",
            waiterId,
            reply,
          }));
        }) as Effect.Effect<void, RuntimeClosing | RuntimeClosed>,
      use,
    };

    yield* Scope.addFinalizer(owningScope, shutdown.pipe(Effect.orDie));
    return runtime;
  }),
);

export const make = (): Effect.Effect<DynamicRuntime, never, Scope.Scope> => makeRuntime;
