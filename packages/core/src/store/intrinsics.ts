// Authority code must not consult caller-replaceable primordials after module initialization.
// Keep this inventory dependency-free so every consumer receives closures over the original values.
const intrinsicReflectApply = Reflect.apply;
const intrinsicReflectOwnKeys = Reflect.ownKeys;
const intrinsicArrayIsArray = Array.isArray;
const intrinsicObjectAssign = Object.assign;
const intrinsicObjectCreate = Object.create;
const intrinsicObjectEntries = Object.entries;
const intrinsicObjectFreeze = Object.freeze;
const intrinsicObjectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicObjectIs = Object.is;
const intrinsicObjectKeys = Object.keys;
const intrinsicObjectValues = Object.values;
const intrinsicStructuredClone = structuredClone;
const intrinsicJsonParse = JSON.parse;
const intrinsicJsonStringify = JSON.stringify;
const intrinsicNumberIsSafeInteger = Number.isSafeInteger;
const authorityTextEncoder = new TextEncoder();
const authorityTextDecoder = new TextDecoder();
const intrinsicTextEncode = TextEncoder.prototype.encode;
const intrinsicTextDecode = TextDecoder.prototype.decode;
const intrinsicWeakMapGet = WeakMap.prototype.get;
const intrinsicWeakMapHas = WeakMap.prototype.has;
const intrinsicWeakMapSet = WeakMap.prototype.set;
const intrinsicObjectPrototype = Object.prototype;
const intrinsicArrayPrototype = Array.prototype;

function applyIntrinsic<T>(fn: (...args: never[]) => T, receiver: unknown, args: unknown[]): T {
  return intrinsicReflectApply(fn, receiver, args) as T;
}

export const authorityObjectPrototype = intrinsicObjectPrototype;
export const authorityArrayPrototype = intrinsicArrayPrototype;
export const authorityArrayIsArray = (value: unknown): value is unknown[] =>
  intrinsicArrayIsArray(value);
export const authorityObjectGetPrototypeOf = (value: object): object | null =>
  intrinsicObjectGetPrototypeOf(value);
export const authorityObjectGetOwnPropertyDescriptors = (
  value: object,
): Record<PropertyKey, PropertyDescriptor> => intrinsicObjectGetOwnPropertyDescriptors(value);
export const authorityReflectOwnKeys = (value: object): (string | symbol)[] =>
  intrinsicReflectOwnKeys(value);
export const authorityObjectCreate = <T extends object>(prototype: object | null): T =>
  intrinsicObjectCreate(prototype) as T;
export const authorityObjectFreeze = <T>(value: T): Readonly<T> => intrinsicObjectFreeze(value);
export const authorityObjectEntries = <T>(value: Record<string, T>): Array<[string, T]> =>
  intrinsicObjectEntries(value);
export const authorityObjectValues = <T>(value: Record<string, T>): T[] =>
  intrinsicObjectValues(value);
export const authorityObjectKeys = (value: object): string[] => intrinsicObjectKeys(value);
export const authorityObjectAssign = <T extends object, U extends object>(
  target: T,
  source: U,
): T & U => intrinsicObjectAssign(target, source);
export const authorityObjectIs = (left: unknown, right: unknown): boolean =>
  intrinsicObjectIs(left, right);
export const authorityStructuredClone = <T>(value: T): T => intrinsicStructuredClone(value);
export const authorityJsonParse = (value: string): unknown => intrinsicJsonParse(value);
export const authorityJsonStringify = (value: unknown): string => intrinsicJsonStringify(value);
export const authorityNumberIsSafeInteger = (value: unknown): value is number =>
  intrinsicNumberIsSafeInteger(value);
export const authorityEncodeText = (value: string): Uint8Array =>
  applyIntrinsic(intrinsicTextEncode, authorityTextEncoder, [value]);
export const authorityDecodeText = (value: Uint8Array): string =>
  applyIntrinsic(intrinsicTextDecode, authorityTextDecoder, [value]);

export const authorityWeakMapHas = <K extends object, V>(
  map: WeakMap<K, V>,
  key: object,
): boolean => applyIntrinsic(intrinsicWeakMapHas, map, [key]);
export const authorityWeakMapGet = <K extends object, V>(
  map: WeakMap<K, V>,
  key: object,
): V | undefined => applyIntrinsic(intrinsicWeakMapGet, map, [key]);
export const authorityWeakMapSet = <K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
  value: V,
): void => {
  applyIntrinsic(intrinsicWeakMapSet, map, [key, value]);
};

export const authorityApply = applyIntrinsic;
