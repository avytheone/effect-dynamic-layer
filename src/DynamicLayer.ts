import type { Context, Effect, Layer, SubscriptionRef } from "effect";
import { Layer as EffectLayer, type Scope } from "effect";
import { attachDescription } from "./internal/erased.js";
import type { Requirement } from "./Requirement.js";

const DynamicLayerTypeId: unique symbol = Symbol.for("effect-dynamic-layer/DynamicLayer");
const DynamicLayerVariance: unique symbol = Symbol.for(
  "effect-dynamic-layer/DynamicLayer/variance",
);
const ValidationError: unique symbol = Symbol.for("effect-dynamic-layer/DynamicLayer/validation");

interface Variance<ROut, E, RIn> {
  readonly _ROut: (_service: ROut) => void;
  readonly _E: () => E;
  readonly _RIn: () => RIn;
}

/** An immutable recipe. Resource ownership belongs exclusively to DynamicRuntime. */
export interface DynamicLayer<ROut, E, RIn> {
  readonly [DynamicLayerTypeId]: typeof DynamicLayerTypeId;
  readonly [DynamicLayerVariance]?: Variance<ROut, E, RIn>;
  readonly id: string;
  readonly exportKey: string;
  readonly requires: Requirement<RIn>;
  readonly when?: SubscriptionRef.SubscriptionRef<boolean>;
}

type IsAny<A> = 0 extends 1 & A ? true : false;
type IsUnknown<A> = IsAny<A> extends true ? false : unknown extends A ? true : false;

type IsConcrete<A> = IsAny<A> extends true ? false : IsUnknown<A> extends true ? false : true;

type Covers<Input, Declared> =
  IsConcrete<Input> extends true
    ? [Exclude<Input, Declared>] extends [never]
      ? true
      : false
    : false;

type Provides<Output, Selected> =
  IsConcrete<Output> extends true ? ([Selected] extends [Output] ? true : false) : false;

type Valid<Condition extends boolean, Reason extends string> = Condition extends true
  ? unknown
  : {
      readonly [ValidationError]: Reason;
    };

type RequirementId<R extends Requirement<unknown>> = Requirement.Identifier<R>;

type LayerProof<L extends Layer.Any, ROut, RRequired extends Requirement<unknown>> = Valid<
  Provides<Layer.Success<NoInfer<L>>, ROut>,
  "layer does not provide the selected service"
> &
  Valid<
    Covers<Layer.Services<NoInfer<L>>, RequirementId<RRequired>>,
    "requires does not cover every layer input"
  >;

export interface FromLayerOptions<
  RRequired extends Requirement<unknown>,
  L extends Layer.Any,
  ROut,
> {
  readonly id: string;
  readonly requires: RRequired & Requirement<RequirementId<RRequired>>;
  readonly layer: L & LayerProof<L, ROut, RRequired>;
  readonly when?: SubscriptionRef.SubscriptionRef<boolean>;
}

export interface FromEffectOptions<S, E, R, RRequired extends Requirement<unknown>> {
  readonly id: string;
  readonly requires: RRequired & Requirement<RequirementId<RRequired>>;
  readonly acquire: Effect.Effect<NoInfer<S>, E, R> &
    Valid<
      Covers<Exclude<R, Scope.Scope>, RequirementId<RRequired>>,
      "requires does not cover every effect input"
    >;
  readonly when?: SubscriptionRef.SubscriptionRef<boolean>;
}

const makeDescription = <ROut, S, E, RIn, L extends Layer.Any>(
  output: Context.Key<ROut, S>,
  options: {
    readonly id: string;
    readonly requires: Requirement<RIn>;
    readonly when?: SubscriptionRef.SubscriptionRef<boolean>;
  },
  layer: L,
): DynamicLayer<ROut, E, RIn> => {
  const mutableDescription: DynamicLayer<ROut, E, RIn> = {
    [DynamicLayerTypeId]: DynamicLayerTypeId,
    id: options.id,
    exportKey: output.key,
    requires: options.requires,
    ...(options.when === undefined ? {} : { when: options.when }),
  };
  const description = Object.freeze(mutableDescription);
  attachDescription(description, layer, output);
  return description;
};

/**
 * Selects one exported service from a Layer while retaining its exact error type.
 * The intersections are proofs over the inferred Layer itself, preventing a
 * missing input or output from being repaired by widening a generic to unknown.
 */
export const fromLayer =
  <ROut, S>(output: Context.Key<ROut, S>) =>
  <RRequired extends Requirement<unknown>, L extends Layer.Any>(
    options: FromLayerOptions<RRequired, L, ROut>,
  ): DynamicLayer<ROut, Layer.Error<L>, RequirementId<RRequired>> =>
    makeDescription<ROut, S, Layer.Error<L>, RequirementId<RRequired>, L>(
      output,
      options,
      options.layer,
    );

/** Converts Effect acquisition to the same Layer recipe used by fromLayer. */
export const fromEffect =
  <ROut, S>(output: Context.Key<ROut, S>) =>
  <RRequired extends Requirement<unknown>, E, R>(
    options: FromEffectOptions<S, E, R, RRequired>,
  ): DynamicLayer<ROut, E, RequirementId<RRequired>> =>
    makeDescription<
      ROut,
      S,
      E,
      RequirementId<RRequired>,
      Layer.Layer<ROut, E, Exclude<R, Scope.Scope>>
    >(output, options, EffectLayer.effect(output, options.acquire));
