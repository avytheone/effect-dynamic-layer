import type { Context } from "effect";

const RequirementTypeId: unique symbol = Symbol.for("effect-dynamic-layer/Requirement");
const RequirementVarianceId: unique symbol = Symbol.for(
  "effect-dynamic-layer/Requirement/variance",
);

interface RequirementVariance<R> {
  readonly [RequirementVarianceId]?: () => R;
}

export interface Empty extends RequirementVariance<never> {
  readonly [RequirementTypeId]: typeof RequirementTypeId;
  readonly _tag: "Empty";
  readonly keys: readonly [];
}

export interface Service<R> extends RequirementVariance<R> {
  readonly [RequirementTypeId]: typeof RequirementTypeId;
  readonly _tag: "Service";
  readonly service: Context.Key<R, unknown>;
  readonly keys: readonly [string];
}

export interface All<R> extends RequirementVariance<R> {
  readonly [RequirementTypeId]: typeof RequirementTypeId;
  readonly _tag: "All";
  readonly requirements: readonly Service<unknown>[];
  readonly keys: readonly string[];
}

/** An immutable, inspectable description of required service identifiers. */
export type Requirement<R> = Empty | Service<R> | All<R>;

export declare namespace Requirement {
  export type Identifier<T> = T extends RequirementVariance<infer R> ? R : never;
}

const emptyNode: Empty = {
  [RequirementTypeId]: RequirementTypeId,
  _tag: "Empty",
  keys: Object.freeze<[]>([]),
};

export const empty: Requirement<never> = Object.freeze(emptyNode);

/** Records the key value because TypeScript identifiers do not exist at runtime. */
export const service = <R, S>(key: Context.Key<R, S>): Requirement<R> => {
  const requirement: Service<R> = {
    [RequirementTypeId]: RequirementTypeId,
    _tag: "Service",
    service: key,
    keys: Object.freeze<[string]>([key.key]),
  };
  return Object.freeze(requirement);
};

type Identifiers<Requirements extends readonly Requirement<unknown>[]> = Requirement.Identifier<
  Requirements[number]
>;

/** Flattens nested conjunctions and de-duplicates service keys in first-seen order. */
export const all = <const Requirements extends readonly Requirement<unknown>[]>(
  ...requirements: Requirements
): Requirement<Identifiers<Requirements>> => {
  const services: Array<Service<unknown>> = [];
  const seen = new Set<string>();

  const append = (requirement: Requirement<unknown>): void => {
    if (requirement._tag === "Empty") return;
    if (requirement._tag === "All") {
      for (const nested of requirement.requirements) append(nested);
      return;
    }
    const key = requirement.keys[0];
    if (seen.has(key)) return;
    seen.add(key);
    services.push(requirement);
  };

  for (const requirement of requirements) append(requirement);
  if (services.length === 0) return empty;

  const conjunction: All<Identifiers<Requirements>> = {
    [RequirementTypeId]: RequirementTypeId,
    _tag: "All",
    requirements: Object.freeze(services),
    keys: Object.freeze(services.map((requirement) => requirement.keys[0])),
  };
  return Object.freeze(conjunction);
};
