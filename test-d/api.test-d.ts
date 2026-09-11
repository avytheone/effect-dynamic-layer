import { Context, Effect, Layer } from "effect";
import { DynamicLayer, type DynamicRuntime, Requirement, type UseError } from "../src/index.js";

class Database extends Context.Service<Database, { readonly label: string }>()("types/Database") {}
class Auth extends Context.Service<Auth, { readonly subject: string }>()("types/Auth") {}
class Analytics extends Context.Service<Analytics, { readonly summary: string }>()(
  "types/Analytics",
) {}
class Other extends Context.Service<Other, { readonly value: number }>()("types/Other") {}

class BuildError {
  readonly _tag = "BuildError";
}

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? (<T>() => T extends Right ? 1 : 2) extends <T>() => T extends Left ? 1 : 2
      ? true
      : false
    : false;

type Expect<Condition extends true> = Condition;

const nestedRequirements = Requirement.all(
  Requirement.service(Database),
  Requirement.all(Requirement.service(Auth), Requirement.service(Database)),
);
const requirementTypeProof: Expect<
  Equal<Requirement.Requirement.Identifier<typeof nestedRequirements>, Database | Auth>
> = true;
void requirementTypeProof;

const acquisition = Effect.gen(function* () {
  const database = yield* Database;
  const auth = yield* Auth;
  if (database.label.length < 0) return yield* Effect.fail(new BuildError());
  return { summary: `${database.label}:${auth.subject}` };
});

const fromEffectDescription = DynamicLayer.fromEffect(Analytics)({
  id: "analytics-effect",
  requires: nestedRequirements,
  acquire: acquisition,
});
const fromEffectTypeProof: Expect<
  Equal<
    typeof fromEffectDescription,
    DynamicLayer.DynamicLayer<Analytics, BuildError, Database | Auth>
  >
> = true;
void fromEffectTypeProof;

const analyticsLayer = Layer.effect(Analytics, acquisition);
const fromLayerDescription = DynamicLayer.fromLayer(Analytics)({
  id: "analytics-layer",
  requires: nestedRequirements,
  layer: analyticsLayer,
});
const fromLayerTypeProof: Expect<
  Equal<
    typeof fromLayerDescription,
    DynamicLayer.DynamicLayer<Analytics, BuildError, Database | Auth>
  >
> = true;
void fromLayerTypeProof;

DynamicLayer.fromLayer(Analytics)({
  id: "missing-layer-input",
  requires: Requirement.empty,
  // @ts-expect-error T37: the Layer still requires Database and Auth
  layer: analyticsLayer,
});

DynamicLayer.fromEffect(Analytics)({
  id: "missing-effect-input",
  requires: Requirement.service(Database),
  // @ts-expect-error T37: Auth cannot be widened away from the Effect environment
  acquire: acquisition,
});

DynamicLayer.fromEffect(Analytics)({
  id: "wrong-service-shape",
  requires: Requirement.empty,
  // @ts-expect-error T37: acquire must return Analytics's service shape
  acquire: Effect.succeed({ value: 1 }),
});

const otherLayer = Layer.succeed(Other, { value: 1 });
DynamicLayer.fromLayer(Analytics)({
  id: "wrong-export",
  requires: Requirement.empty,
  // @ts-expect-error T37: selecting Analytics cannot accept a Layer that only exports Other
  layer: otherLayer,
});

declare const unknownOutputLayer: Layer.Layer<unknown>;
DynamicLayer.fromLayer(Analytics)({
  id: "widened-wrong-export",
  requires: Requirement.empty,
  // @ts-expect-error T37: widening output to unknown is not accepted as proof of Analytics
  layer: unknownOutputLayer,
});

const databaseLayer = Layer.succeed(Database, { label: "internal" });
const internallyProvided = analyticsLayer.pipe(
  Layer.provide(databaseLayer),
  Layer.provide(Layer.succeed(Auth, { subject: "internal" })),
);
const internalDescription = DynamicLayer.fromLayer(Analytics)({
  id: "internally-provided",
  requires: Requirement.empty,
  layer: internallyProvided,
});
const internalTypeProof: Expect<
  Equal<typeof internalDescription, DynamicLayer.DynamicLayer<Analytics, BuildError, never>>
> = true;
void internalTypeProof;

const scopedOnly = Effect.acquireRelease(Effect.succeed({ summary: "scoped" }), () => Effect.void);
const scopedDescription = DynamicLayer.fromEffect(Analytics)({
  id: "runtime-owned-scope",
  requires: Requirement.empty,
  acquire: scopedOnly,
});
const scopedTypeProof: Expect<
  Equal<typeof scopedDescription, DynamicLayer.DynamicLayer<Analytics, never, never>>
> = true;
void scopedTypeProof;

declare const runtime: DynamicRuntime.DynamicRuntime;

const useEffect = runtime.use(Analytics, (analytics) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    return `${analytics.summary}:${auth.subject}`;
  }),
);
const useSuccessProof: Expect<Equal<Effect.Success<typeof useEffect>, string>> = true;
const useErrorProof: Expect<Equal<Effect.Error<typeof useEffect>, UseError>> = true;
const useRequirementsProof: Expect<Equal<Effect.Services<typeof useEffect>, Auth>> = true;
void useSuccessProof;
void useErrorProof;
void useRequirementsProof;
