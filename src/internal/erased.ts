import { Context, type Layer, Option, type SubscriptionRef } from "effect";
import type { DynamicLayer } from "../DynamicLayer.js";

export interface ErasedDescription {
  readonly id: string;
  readonly exportKey: string;
  readonly requirementKeys: readonly string[];
  readonly layer: Layer.Layer<unknown, unknown, unknown>;
  readonly when?: SubscriptionRef.SubscriptionRef<boolean>;
}

interface AttachedDescription {
  readonly layer: Layer.Any;
  readonly exportService: Context.Key<unknown, unknown>;
}

const attachedDescriptions = new WeakMap<object, AttachedDescription>();

const exportServices = new WeakMap<ErasedDescription, Context.Key<unknown, unknown>>();

/** @internal Attaches implementation values without exposing them on the public recipe. */
export const attachDescription = <ROut, S, L extends Layer.Any>(
  description: object,
  layer: L,
  exportService: Context.Key<ROut, S>,
): void => {
  attachedDescriptions.set(description, { layer, exportService });
};

/**
 * This is the sole heterogeneous registry seam. Runtime output-key validation
 * protects the unavoidable Layer assertion at this boundary.
 */
export const eraseDescription = <ROut, E, RIn>(
  description: DynamicLayer<ROut, E, RIn>,
): ErasedDescription => {
  const attached = attachedDescriptions.get(description);
  if (attached === undefined) throw new TypeError("Unknown DynamicLayer description");
  const erased: ErasedDescription = Object.freeze({
    id: description.id,
    exportKey: description.exportKey,
    requirementKeys: description.requires.keys,
    layer: attached.layer as Layer.Layer<unknown, unknown, unknown>,
    ...(description.when === undefined ? {} : { when: description.when }),
  });
  exportServices.set(erased, attached.exportService);
  return erased;
};

/** Validates and extracts the selected service from a built Layer context. */
export const extractOutput = (
  description: ErasedDescription,
  context: Context.Context<unknown>,
): Option.Option<unknown> => {
  const service = exportServices.get(description);
  if (service === undefined || service.key !== description.exportKey) {
    throw new TypeError("Unknown erased DynamicLayer description");
  }
  if (!context.mapUnsafe.has(description.exportKey)) return Option.none();
  return Context.getOption(context, service);
};

/**
 * Erases the caller context only where the heterogeneous runtime captures it.
 * Context is immutable; this changes no value or ownership at runtime.
 */
export const eraseCapturedContext = (context: Context.Context<never>): Context.Context<unknown> =>
  context as Context.Context<unknown>;

/**
 * Recovers the callback's service shape after validating the publication key.
 * The registry stores unknown values because different service shapes coexist.
 */
export const recoverService = <S>(
  key: Context.Key<unknown, S>,
  publicationKey: string,
  value: unknown,
): S => {
  if (key.key !== publicationKey) {
    throw new TypeError(
      `Publication key ${publicationKey} does not match requested service ${key.key}`,
    );
  }
  return value as S;
};
