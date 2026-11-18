/**
 * Return a copy of an object with undefined-valued properties removed.
 *
 * Optional fields are kept absent rather than explicitly undefined, since some
 * serializers and validators treat those cases differently. Only enumerable
 * own properties are considered; nested values are shared.
 */
export function omitUndefined<T extends object>(value: T): T {
  const result = { ...value };
  for (const key of Object.keys(result)) {
    if (Reflect.get(result, key) === undefined) {
      Reflect.deleteProperty(result, key);
    }
  }
  return result;
}
