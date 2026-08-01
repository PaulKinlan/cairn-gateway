export type JsonSchema = Record<string, unknown>;

/** Deterministic Stage 0 validator for the exact closed JSON-Schema subset we advertise. */
export function validatesSchema(schema: JsonSchema, value: unknown): boolean {
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.filter((item) => isPlainObject(item) && validatesSchema(item, value))
      .length === 1;
  }
  if ("const" in schema && !deepEqual(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(value, item))) {
    return false;
  }
  if (schema.type !== undefined && !matchesType(schema.type, value)) return false;
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (
      isPlainObject(schema.items) &&
      !value.every((item) => validatesSchema(schema.items as JsonSchema, item))
    ) {
      return false;
    }
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    if (!required.every((key) => Object.hasOwn(value, key))) return false;
    if (
      schema.additionalProperties === false &&
      Object.keys(value).some((key) => !(key in properties))
    ) {
      return false;
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (isPlainObject(childSchema) && !validatesSchema(childSchema, child)) return false;
    }
  }
  return true;
}
function matchesType(type: unknown, value: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((item) => {
    if (item === "null") return value === null;
    if (item === "array") return Array.isArray(value);
    if (item === "object") return isPlainObject(value);
    if (item === "integer") return Number.isSafeInteger(value);
    if (item === "number") return typeof value === "number" && Number.isFinite(value);
    if (item === "string") return typeof value === "string";
    if (item === "boolean") return typeof value === "boolean";
    return false;
  });
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length &&
      ak.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}
