import {
  noteStageRootLoss,
  readLaneJournalFile,
  summarizeLane,
  summarizeLaneHistory
} from "./chunk-B6IQC4A2.mjs";
import {
  REVIEW_BASENAME,
  STATE,
  WINDOWS_HIDE,
  WindowsStageExecutor,
  canonical,
  compareKey,
  getReviewService,
  hashAbsent,
  isExternalKey,
  listReviewServices,
  renderCandidateDiff,
  resolveDshModuleRoot,
  resolveReviewStoreDir,
  sha256Buffer,
  suppressWindowsCriticalErrorDialogs,
  verifyStageRootAlive,
  writeFileAtomic
} from "./chunk-JQDMKSOE.mjs";
import {
  __export
} from "./chunk-Z53TC6BM.mjs";

// node_modules/@deepseek-ai/cosmokit/lib/index.js
function isNullable(value) {
  return value === null || value === void 0;
}
function isPlainObject(data) {
  return data && typeof data === "object" && !Array.isArray(data);
}
function filterKeys(object, filter) {
  return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
function mapValues(object, transform) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
function pick(source, keys, forced) {
  if (!keys) return { ...source };
  const result = {};
  for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
  return result;
}
var write = /* @__PURE__ */ Symbol.for("cosmokit.volatile.write");
function snapshot(value, ancestors = /* @__PURE__ */ new Set()) {
  if (typeof value === "function") throw new TypeError("volatile config cannot contain functions");
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError("volatile config cannot contain cycles");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors)));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("volatile config objects must be plain objects or arrays");
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])));
  } finally {
    ancestors.delete(value);
  }
}
function createVolatile(value) {
  let current = snapshot(value);
  return Object.freeze({
    get: () => current,
    [write]: (value2) => {
      current = value2;
    }
  });
}
function isVolatile(value) {
  return typeof value === "object" && value !== null && write in value;
}
function is(type, value) {
  if (arguments.length === 1) return (value2) => is(type, value2);
  return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
  return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
  return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
var Binary;
(function(Binary2) {
  Binary2.is = isArrayBufferLike;
  Binary2.isSource = isArrayBufferSource;
  function fromSource(source) {
    if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    else return source;
  }
  Binary2.fromSource = fromSource;
  function toBase64(source) {
    source = fromSource(source);
    if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
    let binary = "";
    const bytes = new Uint8Array(source);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  Binary2.toBase64 = toBase64;
  function fromBase64(source) {
    if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
    return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
  }
  Binary2.fromBase64 = fromBase64;
  function toHex(source) {
    source = fromSource(source);
    if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
    return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  Binary2.toHex = toHex;
  function fromHex(source) {
    if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
    const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
    const buffer = [];
    for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
    return Uint8Array.from(buffer).buffer;
  }
  Binary2.fromHex = fromHex;
})(Binary || (Binary = {}));
var base64ToArrayBuffer = Binary.fromBase64;
var arrayBufferToBase64 = Binary.toBase64;
var hexToArrayBuffer = Binary.fromHex;
var arrayBufferToHex = Binary.toHex;
function clone(source, refs = /* @__PURE__ */ new Map()) {
  if (!source || typeof source !== "object") return source;
  if (is("Date", source)) return new Date(source.valueOf());
  if (is("RegExp", source)) return new RegExp(source.source, source.flags);
  if (isArrayBufferLike(source)) return source.slice(0);
  if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  const cached = refs.get(source);
  if (cached) return cached;
  if (Array.isArray(source)) {
    const result2 = [];
    refs.set(source, result2);
    source.forEach((value, index) => {
      result2[index] = Reflect.apply(clone, null, [value, refs]);
    });
    return result2;
  }
  const result = Object.create(Object.getPrototypeOf(source));
  refs.set(source, result);
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
    if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
    Reflect.defineProperty(result, key, descriptor);
  }
  return result;
}
function deepEqual(a, b, strict) {
  const ancestors = /* @__PURE__ */ new Set();
  function compare(a2, b2) {
    if (a2 === b2) return true;
    if (isVolatile(a2) || isVolatile(b2)) return isVolatile(a2) && isVolatile(b2);
    if (!strict && isNullable(a2) && isNullable(b2)) return true;
    if (typeof a2 !== typeof b2 || typeof a2 !== "object" || !a2 || !b2) return false;
    if (ancestors.has(a2)) return false;
    function check(test, then) {
      return test(a2) ? test(b2) ? then(a2, b2) : false : test(b2) ? false : void 0;
    }
    ancestors.add(a2);
    try {
      return check(Array.isArray, (a3, b3) => {
        if (a3.length !== b3.length) return false;
        for (let index = 0; index < a3.length; index++) if (!compare(a3[index], b3[index])) return false;
        return true;
      }) ?? check(is("Date"), (a3, b3) => a3.valueOf() === b3.valueOf()) ?? check(is("URL"), (a3, b3) => a3.href === b3.href) ?? check(is("RegExp"), (a3, b3) => a3.source === b3.source && a3.flags === b3.flags) ?? check(isArrayBufferLike, (a3, b3) => {
        if (a3.byteLength !== b3.byteLength) return false;
        const viewA = new Uint8Array(a3);
        const viewB = new Uint8Array(b3);
        for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
        return true;
      }) ?? ((!strict || [a2, b2].every((value) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) && Object.keys({
        ...a2,
        ...b2
      }).every((key) => compare(a2[key], b2[key])));
    } finally {
      ancestors.delete(a2);
    }
  }
  return compare(a, b);
}
var Time;
(function(Time2) {
  Time2.millisecond = 1;
  Time2.second = 1e3;
  Time2.minute = Time2.second * 60;
  Time2.hour = Time2.minute * 60;
  Time2.day = Time2.hour * 24;
  Time2.week = Time2.day * 7;
  let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
  function setTimezoneOffset(offset) {
    timezoneOffset = offset;
  }
  Time2.setTimezoneOffset = setTimezoneOffset;
  function getTimezoneOffset() {
    return timezoneOffset;
  }
  Time2.getTimezoneOffset = getTimezoneOffset;
  function getDateNumber(date2 = /* @__PURE__ */ new Date(), offset) {
    if (typeof date2 === "number") date2 = new Date(date2);
    if (offset === void 0) offset = timezoneOffset;
    return Math.floor((date2.valueOf() / Time2.minute - offset) / 1440);
  }
  Time2.getDateNumber = getDateNumber;
  function fromDateNumber(value, offset) {
    const date2 = new Date(value * Time2.day);
    if (offset === void 0) offset = timezoneOffset;
    return new Date(+date2 + offset * Time2.minute);
  }
  Time2.fromDateNumber = fromDateNumber;
  const numeric = /\d+(?:\.\d+)?/.source;
  const timeRegExp = new RegExp(`^${[
    "w(?:eek(?:s)?)?",
    "d(?:ay(?:s)?)?",
    "h(?:our(?:s)?)?",
    "m(?:in(?:ute)?(?:s)?)?",
    "s(?:ec(?:ond)?(?:s)?)?"
  ].map((unit) => `(${numeric}${unit})?`).join("")}$`);
  function parseTime(source) {
    const capture = timeRegExp.exec(source);
    if (!capture) return 0;
    return (parseFloat(capture[1]) * Time2.week || 0) + (parseFloat(capture[2]) * Time2.day || 0) + (parseFloat(capture[3]) * Time2.hour || 0) + (parseFloat(capture[4]) * Time2.minute || 0) + (parseFloat(capture[5]) * Time2.second || 0);
  }
  Time2.parseTime = parseTime;
  function parseDate(date2) {
    const parsed = parseTime(date2);
    if (parsed) date2 = Date.now() + parsed;
    else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) date2 = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date2}`;
    else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) date2 = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date2}`;
    return date2 ? new Date(date2) : /* @__PURE__ */ new Date();
  }
  Time2.parseDate = parseDate;
  function format(ms) {
    const abs = Math.abs(ms);
    if (abs >= Time2.day - Time2.hour / 2) return Math.round(ms / Time2.day) + "d";
    else if (abs >= Time2.hour - Time2.minute / 2) return Math.round(ms / Time2.hour) + "h";
    else if (abs >= Time2.minute - Time2.second / 2) return Math.round(ms / Time2.minute) + "m";
    else if (abs >= Time2.second) return Math.round(ms / Time2.second) + "s";
    return ms + "ms";
  }
  Time2.format = format;
  function toDigits(source, length = 2) {
    return source.toString().padStart(length, "0");
  }
  Time2.toDigits = toDigits;
  function template(template2, time = /* @__PURE__ */ new Date()) {
    return template2.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
  }
  Time2.template = template;
})(Time || (Time = {}));

// node_modules/@deepseek-ai/schemastery/lib/index.mjs
var kSchema = /* @__PURE__ */ Symbol.for("schemastery");
var kValidationError = /* @__PURE__ */ Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
  options;
  name = "ValidationError";
  constructor(message, options) {
    let prefix = "$";
    for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
    else if (typeof segment === "number") prefix += "[" + segment + "]";
    else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
    if (prefix.startsWith(".")) prefix = prefix.slice(1);
    super((prefix === "$" ? "" : `${prefix} `) + message);
    this.options = options;
  }
  static is(error) {
    return !!error?.[kValidationError];
  }
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
var Schema = function(options) {
  const schema = function(data, options2 = {}) {
    return Schema.resolve(data, schema, options2)[0];
  };
  if (options.refs) {
    const refs = mapValues(options.refs, (options2) => new Schema(options2));
    const getRef = (uid) => refs[uid];
    for (const key in refs) {
      const options2 = refs[key];
      options2.sKey = getRef(options2.sKey);
      options2.inner = getRef(options2.inner);
      options2.list = options2.list && options2.list.map(getRef);
      options2.dict = options2.dict && mapValues(options2.dict, getRef);
    }
    return refs[options.uid];
  }
  Object.assign(schema, options);
  if (typeof schema.callback === "string") try {
    schema.callback = new Function("return " + schema.callback)();
  } catch {
  }
  Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
  Object.setPrototypeOf(schema, Schema.prototype);
  schema.meta ||= {};
  schema.toString = schema.toString.bind(schema);
  return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
  return {
    version: 1,
    vendor: "schemastery",
    validate: (value) => {
      try {
        return { value: Schema.resolve(value, this, {})[0] };
      } catch (error) {
        if (ValidationError.is(error)) return { issues: [{
          message: error.message,
          path: error.options.path
        }] };
        throw error;
      }
    }
  };
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
  if (globalThis.__schemastery_refs__) {
    globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
    return this.uid;
  }
  globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
  globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
  const result = {
    uid: this.uid,
    refs: globalThis.__schemastery_refs__
  };
  globalThis.__schemastery_refs__ = void 0;
  return result;
};
Schema.prototype.set = function set(key, value) {
  this.dict[key] = value;
  return this;
};
Schema.prototype.push = function push(value) {
  this.list.push(value);
  return this;
};
function mergeDesc(original, messages) {
  const result = typeof original === "string" ? { "": original } : { ...original };
  for (const locale in messages) {
    const value = messages[locale];
    if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
    else if (typeof value === "string") result[locale] = value;
  }
  return result;
}
function getInner(value) {
  return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
  return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
  const schema = Schema(this);
  const desc = mergeDesc(schema.meta.description, messages);
  if (Object.keys(desc).length) schema.meta.description = desc;
  if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
    return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
  });
  if (schema.list) schema.list = schema.list.map((inner, index) => {
    return inner.i18n(mapValues(messages, (data = {}) => {
      if (Array.isArray(getInner(data))) return getInner(data)[index];
      if (Array.isArray(data)) return data[index];
      return extractKeys(data);
    }));
  });
  if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
    if (getInner(data)) return getInner(data);
    return extractKeys(data);
  }));
  if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
  return schema;
};
Schema.prototype.extra = function extra(key, value) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
};
for (const key of [
  "required",
  "disabled",
  "collapse",
  "hidden",
  "loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
} });
Schema.prototype.deprecated = function deprecated() {
  const schema = Schema(this);
  schema.meta.badges ||= [];
  schema.meta.badges.push({
    text: "deprecated",
    type: "danger"
  });
  return schema;
};
Schema.prototype.experimental = function experimental() {
  const schema = Schema(this);
  schema.meta.badges ||= [];
  schema.meta.badges.push({
    text: "experimental",
    type: "warning"
  });
  return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
  const schema = Schema(this);
  const pattern2 = pick(regexp, ["source", "flags"]);
  schema.meta = {
    ...schema.meta,
    pattern: pattern2
  };
  return schema;
};
Schema.prototype.simplify = function simplify(value) {
  if (isVolatile(value)) value = value.get();
  if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
  if (isNullable(value)) return value;
  if (this.type === "object" || this.type === "dict") {
    const result = {};
    for (const key in value) {
      const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
      if (this.type === "dict" || !isNullable(item)) result[key] = item;
    }
    if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
    return result;
  } else if (this.type === "array" || this.type === "tuple") {
    const result = [];
    value.forEach((value2, index) => {
      const schema = this.type === "array" ? this.inner : this.list[index];
      const item = schema ? schema.simplify(value2) : value2;
      result.push(item);
    });
    return result;
  } else if (this.type === "intersect") {
    const result = {};
    for (const item of this.list) Object.assign(result, item.simplify(value));
    return result;
  } else if (this.type === "union") for (const schema of this.list) try {
    Schema.resolve(value, schema, {});
    return schema.simplify(value);
  } catch {
  }
  return value;
};
Schema.prototype.toString = function toString(inline) {
  return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra2) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    role,
    extra: extra2
  };
  return schema;
};
for (const key of [
  "default",
  "link",
  "comment",
  "description",
  "max",
  "min",
  "step"
]) Object.assign(Schema.prototype, { [key](value) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
} });
Schema.prototype.volatile = function volatile() {
  if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped");
  return this.extra("volatile", true);
};
var resolvers = {};
var checkedVolatile = /* @__PURE__ */ Symbol("checked-volatile-schema");
function validateVolatileSchema(schema, path = [], blocked = false, seen = /* @__PURE__ */ new Map()) {
  const states = seen.get(schema) ?? /* @__PURE__ */ new Set();
  if (states.has(blocked)) return;
  states.add(blocked);
  seen.set(schema, states);
  if (schema.meta?.volatile && blocked) throw new ValidationError("volatile fields require a fixed object path without an enclosing volatile field", { path });
  const nested = blocked || !!schema.meta?.volatile;
  if (schema.dict) for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path, key], nested, seen);
  if (schema.sKey) validateVolatileSchema(schema.sKey, [...path, "<key>"], true, seen);
  if (schema.inner && (schema.type !== "lazy" || schema.inner[kSchema])) validateVolatileSchema(schema.inner, [...path, "*"], true, seen);
  if (schema.list) for (let index = 0; index < schema.list.length; index++) validateVolatileSchema(schema.list[index], [...path, String(index)], true, seen);
}
Schema.extend = function extend(type, resolve3) {
  resolvers[type] = resolve3;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
  if (!schema) return [data];
  if (!options[checkedVolatile]) {
    validateVolatileSchema(schema, options.path);
    options = {
      ...options,
      [checkedVolatile]: true
    };
  }
  if (schema.meta?.volatile) {
    const inner = Schema(schema);
    inner.meta = {
      ...schema.meta,
      volatile: false
    };
    const [value, adapted] = Schema.resolve(data, inner, options, strict);
    try {
      return [createVolatile(value), adapted];
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : String(error), options);
    }
  }
  if (options.ignore?.(data, schema)) return [data];
  if (isNullable(data) && schema.type !== "lazy") {
    if (schema.meta.required) throw new ValidationError(`missing required value`, options);
    let current = schema;
    let fallback = schema.meta.default;
    while (current?.type === "intersect" && isNullable(fallback)) {
      current = current.list[0];
      fallback = current?.meta.default;
    }
    if (isNullable(fallback)) return [data];
    data = clone(fallback);
  }
  const callback = resolvers[schema.type];
  if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
  try {
    return callback(data, schema, options, strict);
  } catch (error) {
    if (!schema.meta.loose) throw error;
    return [schema.meta.default];
  }
};
Schema.from = function from(source) {
  if (isNullable(source)) return Schema.any();
  else if ([
    "string",
    "number",
    "boolean"
  ].includes(typeof source)) return Schema.const(source).required();
  else if (source[kSchema]) return source;
  else if (typeof source === "function") switch (source) {
    case String:
      return Schema.string().required();
    case Number:
      return Schema.number().required();
    case Boolean:
      return Schema.boolean().required();
    case Function:
      return Schema.function().required();
    default:
      return Schema.is(source).required();
  }
  else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
  const toJSON2 = () => {
    if (!schema.inner[kSchema]) {
      schema.inner = schema.builder();
      schema.inner.meta = {
        ...schema.meta,
        ...schema.inner.meta
      };
    }
    return schema.inner.toJSON();
  };
  const schema = new Schema({
    type: "lazy",
    builder,
    inner: { toJSON: toJSON2 }
  });
  return schema;
};
Schema.natural = function natural() {
  return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
  return Schema.number().step(0.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
  return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
    const date2 = new Date(value);
    if (isNaN(+date2)) throw new ValidationError(`invalid date "${value}"`, options);
    return date2;
  }, true)]);
};
Schema.regExp = function regExp(flag = "") {
  return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
    try {
      return new RegExp(value, flag);
    } catch (e) {
      throw new ValidationError(e.message, options);
    }
  }, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
  return Schema.union([
    Schema.is(ArrayBuffer),
    Schema.is(SharedArrayBuffer),
    Schema.transform(Schema.any(), (value, options) => {
      if (Binary.isSource(value)) return Binary.fromSource(value);
      throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
    }, true),
    ...encoding ? [Schema.transform(Schema.string(), (value, options) => {
      try {
        return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
      } catch (e) {
        throw new ValidationError(e.message, options);
      }
    }, true)] : []
  ]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
  if (!schema.inner[kSchema]) {
    schema.inner = schema.builder();
    schema.inner.meta = {
      ...schema.meta,
      ...schema.inner.meta
    };
    validateVolatileSchema(schema.inner, options.path, true);
  }
  return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
  return [data];
});
Schema.extend("never", (data, _, options) => {
  throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
  if (deepEqual(data, value)) return [value];
  throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
  const { max = Infinity, min = -Infinity } = meta;
  if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
  if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
  if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
  if (meta.pattern) {
    const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
    if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
  }
  checkWithinRange(data.length, meta, "string length", options);
  return [data];
});
function decimalShift(data, digits) {
  const str = data.toString();
  if (str.includes("e")) return data * Math.pow(10, digits);
  const index = str.indexOf(".");
  if (index === -1) return data * Math.pow(10, digits);
  const frac = str.slice(index + 1);
  const integer = str.slice(0, index);
  if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
  return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
  step = Math.abs(step);
  if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
  const index = step.toString().indexOf(".");
  const digits = step.toString().slice(index + 1).length;
  return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
  if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
  checkWithinRange(data, meta, "number", options);
  const { step } = meta;
  if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
  return [data];
});
Schema.extend("boolean", (data, _, options) => {
  if (typeof data === "boolean") return [data];
  throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
  let value = 0, keys = [];
  if (typeof data === "number") {
    value = data;
    for (const key in bits) if (data & bits[key]) keys.push(key);
  } else if (Array.isArray(data)) {
    keys = data;
    for (const key of keys) {
      if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
      if (key in bits) value |= bits[key];
    }
  } else throw new ValidationError(`expected number or array but got ${data}`, options);
  if (value === meta.default) return [value];
  return [value, keys];
});
Schema.extend("function", (data, _, options) => {
  if (typeof data === "function") return [data];
  throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
  if (typeof constructor === "function") {
    if (data instanceof constructor) return [data];
    throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
  } else {
    if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
    let prototype = Object.getPrototypeOf(data);
    while (prototype) {
      if (prototype.constructor?.name === constructor) return [data];
      prototype = Object.getPrototypeOf(prototype);
    }
    throw new ValidationError(`expected ${constructor} but got ${data}`, options);
  }
});
function property(data, key, schema, options) {
  try {
    const [value, adapted] = Schema.resolve(data[key], schema, {
      ...options,
      path: [...options.path || [], key]
    });
    if (adapted !== void 0) data[key] = adapted;
    return value;
  } catch (e) {
    if (!options?.autofix) throw e;
    delete data[key];
    return schema.meta.volatile ? createVolatile(schema.meta.default) : schema.meta.default;
  }
}
Schema.extend("array", (data, { inner, meta }, options) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
  checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
  return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
  const result = {};
  for (const key in data) {
    let rKey;
    try {
      rKey = Schema.resolve(key, sKey, options)[0];
    } catch (error) {
      if (strict) continue;
      throw error;
    }
    result[rKey] = property(data, key, inner, options);
    data[rKey] = data[key];
    if (key !== rKey) delete data[key];
  }
  return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
  const result = list.map((inner, index) => property(data, index, inner, options));
  if (strict) return [result];
  result.push(...data.slice(list.length));
  return [result];
});
function merge(result, data) {
  for (const key in data) {
    if (key in result) continue;
    result[key] = data[key];
  }
}
Schema.extend("object", (data, { dict }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
  const result = {};
  for (const key in dict) {
    const value = property(data, key, dict[key], options);
    if (!isNullable(value) || key in data) result[key] = value;
  }
  if (!strict) merge(result, data);
  return [result];
});
Schema.extend("union", (data, { list, toString: toString2 }, options, strict) => {
  const messages = [];
  for (const inner of list) try {
    return Schema.resolve(data, inner, options, strict);
  } catch (error) {
    messages.push(error);
  }
  throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString: toString2 }, options, strict) => {
  if (!list.length) return [data];
  let result;
  for (const inner of list) {
    const value = Schema.resolve(data, inner, options, true)[0];
    if (isNullable(value)) continue;
    if (isNullable(result)) result = value;
    else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
    else if (typeof value === "object") merge(result ??= {}, value);
    else if (result !== value) throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
  }
  if (!strict && isPlainObject(data)) merge(result, data);
  return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
  const [result, adapted = data] = Schema.resolve(data, inner, options, true);
  if (preserve) return [callback(result)];
  else return [callback(result), callback(adapted)];
});
var formatters = {};
function defineMethod(name3, keys, format) {
  formatters[name3] = format;
  Object.assign(Schema, { [name3](...args) {
    const schema = new Schema({ type: name3 });
    keys.forEach((key, index) => {
      switch (key) {
        case "sKey":
          schema.sKey = args[index] ?? Schema.string();
          break;
        case "inner":
          schema.inner = Schema.from(args[index]);
          break;
        case "list":
          schema.list = args[index].map(Schema.from);
          break;
        case "dict":
          schema.dict = mapValues(args[index], Schema.from);
          break;
        case "bits":
          schema.bits = {};
          for (const key2 in args[index]) {
            if (typeof args[index][key2] !== "number") continue;
            schema.bits[key2] = args[index][key2];
          }
          break;
        case "callback": {
          const callback = schema.callback = args[index];
          callback["toJSON"] ||= () => callback.toString();
          break;
        }
        case "constructor": {
          const constructor = schema.constructor = args[index];
          if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
          break;
        }
        default:
          schema[key] = args[index];
      }
    });
    if (name3 === "object" || name3 === "dict") schema.meta.default = {};
    else if (name3 === "array" || name3 === "tuple") schema.meta.default = [];
    else if (name3 === "bitset") schema.meta.default = 0;
    return schema;
  } });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
  if (typeof constructor === "function") return constructor.name;
  else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
  if (Object.keys(dict).length === 0) return "{}";
  return `{ ${Object.entries(dict).map(([key, inner]) => {
    return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
  }).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
  const result = list.map(({ toString: format }) => format()).join(" | ");
  return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
  return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
  "inner",
  "callback",
  "preserve"
], ({ inner }, isInner) => inner.toString(isInner));

// plugin/config.ts
var Config = Schema.object({
  enabled: Schema.boolean().default(true).extra("volatile", true).description("\u542F\u7528 WinStage \u6C99\u7BB1\uFF08\u6682\u5B58\u2014\u5019\u9009\u2014\u9009\u62E9\u6027\u63D0\u4EA4\uFF09\u3002\u5173\u95ED\u540E\u672C\u63D2\u4EF6\u4E0D\u505A\u4EFB\u4F55\u68C0\u67E5\u3002"),
  workspaceRoot: Schema.string().default("").extra("volatile", true).description("\u6C99\u7BB1\u5DE5\u4F5C\u533A\u6839\u76EE\u5F55\uFF1B\u7559\u7A7A\u5219\u4F7F\u7528\u63D2\u4EF6\u6240\u5728\u9879\u76EE\u7684\u6839\u76EE\u5F55\u3002"),
  probeOnStart: Schema.boolean().default(true).extra("volatile", true).description("\u52A0\u8F7D\u65F6\u6267\u884C\u4E00\u6B21\u771F\u5B9E\u80FD\u529B\u63A2\u6D4B\uFF08\u4E0D\u521B\u5EFA\u6C99\u7BB1\uFF0C\u53EA\u62A5\u544A\u672C\u4F1A\u8BDD\u80FD\u5426\u5EFA\u7ACB\uFF09\u3002"),
  verboseLog: Schema.boolean().default(false).extra("volatile", true).description("\u628A\u5B8C\u6574\u63A2\u6D4B\u62A5\u544A\u5199\u5165\u65E5\u5FD7\u3002")
});
function readConfigValue(value) {
  if (value !== null && typeof value === "object") {
    const candidate = value;
    if (typeof candidate.get === "function") {
      try {
        return candidate.get();
      } catch {
        return void 0;
      }
    }
  }
  return value;
}
function boolOf(value, fallback) {
  const resolved = readConfigValue(value);
  return typeof resolved === "boolean" ? resolved : fallback;
}
function stringOf(value, fallback = "") {
  const resolved = readConfigValue(value);
  return typeof resolved === "string" ? resolved : fallback;
}

// dsh-plugin/host-plugin.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";

// dsh-plugin/schema.ts
var STANDARD_VERSION = "~standard";
var SCHEMASTER_BRAND = /* @__PURE__ */ Symbol.for("schemastery");
function field(type, meta) {
  return {
    type,
    /** (c) 标量字段必须 volatile，否则不会被投影进设置表单 */
    meta: { volatile: true, ...meta },
    /** (b) 原生身份：品牌 + type + meta 齐备后 `isNativeConfigSchema` 才为 true */
    [SCHEMASTER_BRAND]: true,
    /** (c) 字段级别的序列化，供 `plainSchema` 的 `new z(node.toJSON())` 使用 */
    toJSON() {
      return { type, meta: { volatile: true, ...meta } };
    }
  };
}
function nodeOf(spec) {
  return { type: spec.type, meta: { ...spec.meta } };
}
function encodeDocument(dict) {
  const refs = {};
  const uidDict = {};
  let next = 1;
  for (const [key, spec] of Object.entries(dict)) {
    refs[String(next)] = nodeOf(spec);
    uidDict[key] = next;
    next += 1;
  }
  const rootUid = next;
  refs[String(rootUid)] = { type: "object", meta: { default: {} }, dict: uidDict };
  return { uid: rootUid, refs };
}
function validateObject(dict, input) {
  const issues = [];
  const value = {};
  const source = input === null || typeof input !== "object" ? {} : input;
  for (const [key, spec] of Object.entries(dict)) {
    const raw = source[key];
    if (raw === void 0 || raw === null) {
      if ("default" in spec.meta) value[key] = spec.meta.default;
      continue;
    }
    if (typeof raw !== spec.type) {
      issues.push({ message: `expected ${spec.type} but got ${typeof raw}`, path: [key] });
      continue;
    }
    value[key] = raw;
  }
  return issues.length > 0 ? { issues } : { value };
}
var PluginConfigSchema = class {
  constructor(dict) {
    this.type = "object";
    this.meta = { default: {} };
    this.dict = dict;
    this[SCHEMASTER_BRAND] = true;
    const document = encodeDocument(dict);
    this._document = document;
    this[STANDARD_VERSION] = {
      version: 1,
      vendor: "winstage-sandbox-local-schema",
      validate: (input) => validateObject(dict, input)
    };
  }
  /** (d) 设置页水合用的文档形式 */
  toJSON() {
    return this._document;
  }
  /** 便于诊断：字段名清单 */
  keys() {
    return Object.keys(this.dict);
  }
};
var DICT = {
  enabled: field("boolean", {
    default: true,
    description: "\u542F\u7528 WinStage \u6C99\u7BB1\uFF08\u6682\u5B58\u2014\u5019\u9009\u2014\u9009\u62E9\u6027\u63D0\u4EA4\uFF09\u3002\u5173\u95ED\u540E\u672C\u63D2\u4EF6\u4E0D\u505A\u4EFB\u4F55\u68C0\u67E5\u3002"
  }),
  workspaceRoot: field("string", {
    default: "",
    description: "\u6C99\u7BB1\u5DE5\u4F5C\u533A\u6839\u76EE\u5F55\uFF1B\u7559\u7A7A\u5219\u4F7F\u7528\u63D2\u4EF6\u6240\u5728\u9879\u76EE\u7684\u6839\u76EE\u5F55\u3002"
  }),
  probeOnStart: field("boolean", {
    default: true,
    description: "\u52A0\u8F7D\u65F6\u6267\u884C\u4E00\u6B21\u771F\u5B9E\u80FD\u529B\u63A2\u6D4B\uFF08\u4E0D\u521B\u5EFA\u6C99\u7BB1\uFF0C\u53EA\u62A5\u544A\u672C\u4F1A\u8BDD\u80FD\u5426\u5EFA\u7ACB\uFF09\u3002"
  }),
  verboseLog: field("boolean", {
    default: false,
    description: "\u628A\u5B8C\u6574\u63A2\u6D4B\u62A5\u544A\u5199\u5165\u65E5\u5FD7\u3002"
  })
};
var Config2 = new PluginConfigSchema(DICT);
var FIELD_NAMES = Object.keys(DICT);

// dsh-plugin/environment-gate.ts
function evaluateEnvironment(input = {}) {
  const enabled = input.enabled !== false;
  const skip = input.skip === true;
  const platform = input.platform ?? process.platform;
  const probe = input.probeResult;
  const checks = {};
  if (skip) {
    return { ok: true, skipped: true, code: "WINSTAGE_ENV_GATE_SKIPPED", checks, failures: [] };
  }
  if (!enabled) {
    return { ok: true, skipped: true, code: "WINSTAGE_DISABLED", checks, failures: [] };
  }
  checks.platform = {
    ok: platform === "win32",
    detail: `platform=${platform}\uFF08WinStage \u6C99\u7BB1\u4F9D\u8D56 Windows \u53D7\u9650\u4EE4\u724C / ACL / Job Object\uFF09`
  };
  checks.runtime = probe ? { ok: probe.ready === true, detail: probe.detail ?? (probe.ready === true ? "ready" : "not ready") } : { ok: false, detail: "\u6CA1\u6709\u53EF\u7528\u7684\u8FD0\u884C\u671F\u63A2\u6D4B\u7ED3\u679C\uFF08probeResult \u7F3A\u5931\uFF09" };
  const failures = Object.entries(checks).filter(([, v]) => !v.ok).map(([k]) => k);
  return { ok: failures.length === 0, skipped: false, code: failures.length ? "WINSTAGE_ENV_UNSUPPORTED" : "WINSTAGE_ENV_OK", checks, failures };
}
function environmentFailureMessage(report) {
  if (!report) return "\u73AF\u5883\u76D1\u6D4B\uFF1A\u65E0\u62A5\u544A";
  if (report.skipped) return `\u73AF\u5883\u76D1\u6D4B\u5DF2\u8DF3\u8FC7\uFF08${report.code}\uFF09`;
  if (report.ok) return "\u73AF\u5883\u76D1\u6D4B\u901A\u8FC7";
  const parts = report.failures.map((k) => `${k}: ${report.checks[k]?.detail ?? "\u672A\u901A\u8FC7"}`);
  return `\u73AF\u5883\u76D1\u6D4B\u672A\u901A\u8FC7\uFF08${report.code}\uFF09\uFF1A${parts.join("\uFF1B")}`;
}

// src/capability.ts
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, parse, resolve as resolve2, sep } from "node:path";
import { tmpdir } from "node:os";
suppressWindowsCriticalErrorDialogs();
var require_ = createRequire(import.meta.url);
var PASS = "pass";
var FAIL = "fail";
var UNKNOWN = "unknown";
function ok(detail, extra2 = {}) {
  return { status: PASS, detail, ...extra2 };
}
function no(detail, extra2 = {}) {
  return { status: FAIL, detail, ...extra2 };
}
function unknown(detail, extra2 = {}) {
  return { status: UNKNOWN, detail, ...extra2 };
}
function safe(fn, fallback) {
  try {
    return fn();
  } catch (error) {
    return fallback(error);
  }
}
function loadFfi() {
  const candidates = [...resolveDshModuleRoot().map((root) => join(root, "koffi"))];
  if (typeof process.env.DSH_PROFILE_DIR === "string" && process.env.DSH_PROFILE_DIR.length > 0) {
    candidates.push(join(process.env.DSH_PROFILE_DIR, "node_modules", "koffi"));
  }
  candidates.push("koffi");
  for (const spec of candidates) {
    const loaded = safe(
      () => {
        const mod = require_(spec);
        return mod && typeof mod.load === "function" ? mod : void 0;
      },
      () => void 0
    );
    if (loaded) return loaded;
  }
  return void 0;
}
function probeWin32Abi() {
  const koffi = loadFfi();
  if (!koffi) {
    return unknown("koffi FFI unavailable; Win32 ABI probes cannot run in this context", {
      evidence: '[\u5B9E\u6D4B] require("koffi") failed'
    });
  }
  const results = {};
  let advapi32;
  let kernel32;
  try {
    advapi32 = koffi.load("advapi32.dll");
    kernel32 = koffi.load("kernel32.dll");
  } catch (error) {
    return no(`advapi32/kernel32 load failed: ${error.message}`, { evidence: "[\u5B9E\u6D4B]" });
  }
  const GetCurrentProcess = kernel32.func("void *GetCurrentProcess()");
  const CloseHandleK = kernel32.func("bool CloseHandle(void *hObject)");
  const OpenProcessToken = advapi32.func("bool OpenProcessToken(void *h, uint32 acc, _Out_ void **out)");
  const RIGHTS = {
    TOKEN_ASSIGN_PRIMARY: 1,
    TOKEN_DUPLICATE: 2,
    TOKEN_QUERY: 8,
    TOKEN_ADJUST_DEFAULT: 128,
    TOKEN_ADJUST_SESSIONID: 256
  };
  const granted = {};
  for (const [name3, mask] of Object.entries(RIGHTS)) {
    const slot = [null];
    let okFlag = false;
    try {
      okFlag = OpenProcessToken(GetCurrentProcess(), mask, slot) === true;
    } catch {
      okFlag = false;
    }
    granted[name3] = okFlag;
    if (okFlag && slot[0]) safe(() => CloseHandleK(slot[0]), () => void 0);
  }
  results.tokenRights = {
    status: Object.values(granted).every(Boolean) ? PASS : FAIL,
    evidence: "[\u5B9E\u6D4B] OpenProcessToken \u9010\u9879\u63A2\u6D4B",
    detail: Object.entries(granted).map(([name3, has]) => `${name3}=${has ? "yes" : "NO"}`).join(" "),
    granted
  };
  const restrictedTokenViable = granted.TOKEN_DUPLICATE && granted.TOKEN_QUERY && granted.TOKEN_ASSIGN_PRIMARY && granted.TOKEN_ADJUST_DEFAULT && granted.TOKEN_ADJUST_SESSIONID;
  results.createRestrictedTokenViable = restrictedTokenViable ? ok("all rights required by CreateRestrictedToken are held \u2014 a nested restricted token can be minted", {
    evidence: "[\u5B9E\u6D4B]"
  }) : no(
    "CreateRestrictedToken cannot succeed here: the token lacks " + Object.entries(granted).filter(([, has]) => !has).map(([name3]) => name3).join(", ") + ". A nested sandbox is impossible in an already-confined process.",
    { evidence: "[\u5B9E\u6D4B]", granted }
  );
  const outsideRoot = join(dirname(tmpdir()), `dsh-probe-outside-${Date.now()}`);
  results.writeOutsideWorkspace = safe(
    () => {
      mkdirSync(outsideRoot, { recursive: true });
      writeFileSync(join(outsideRoot, "x.txt"), "x");
      rmSync(outsideRoot, { recursive: true, force: true });
      return ok(`created and removed ${outsideRoot} \u2014 no outer write boundary observed`, { evidence: "[\u5B9E\u6D4B]" });
    },
    (error) => no(`write outside workspace denied: ${error.code || error.message} \u2014 an outer write boundary is active`, { evidence: "[\u5B9E\u6D4B]" })
  );
  results.writeSystemDir = safe(
    () => {
      writeFileSync("C:\\Windows\\dsh-probe-write.txt", "x");
      rmSync("C:\\Windows\\dsh-probe-write.txt", { force: true });
      return no("C:\\Windows is writable \u2014 write boundary absent!", { evidence: "[\u5B9E\u6D4B]" });
    },
    (error) => ok(`C:\\Windows write denied: ${error.code || error.message}`, { evidence: "[\u5B9E\u6D4B]" })
  );
  const readTargets = [
    ["C:\\Windows\\System32\\config\\SAM", "\u672C\u5730\u8D26\u6237\u6570\u636E\u5E93"],
    ["C:\\Windows\\win.ini", "\u7CFB\u7EDF\u6587\u4EF6\uFF08\u5BF9\u7167\u9879\uFF09"]
  ];
  results.readSurface = readTargets.map(([path, label]) => {
    const r = safe(() => statSync(path).size, (error) => `DENIED(${error.code || "ERR"})`);
    return { path, label, result: r };
  });
  const CreateJobObjectW = kernel32.func("void *CreateJobObjectW(void *a, const char16_t *name)");
  const SetInformationJobObject = kernel32.func(
    "bool SetInformationJobObject(void *job, int infoClass, void *info, uint32 len)"
  );
  const AssignProcessToJobObject = kernel32.func("bool AssignProcessToJobObject(void *job, void *process)");
  const QueryInformationJobObject = kernel32.func(
    "bool QueryInformationJobObject(void *job, int cls, void *info, uint32 len, void *ret)"
  );
  const GetLastError = kernel32.func("uint32 GetLastError()");
  const makeVerifyJob = () => {
    const job = CreateJobObjectW(null, null);
    if (!job) throw new Error("CreateJobObjectW returned NULL");
    const info = Buffer.alloc(144);
    if (SetInformationJobObject(job, 9, info, info.length) !== true) {
      const code = GetLastError();
      safe(() => CloseHandleK(job), () => void 0);
      throw new Error(`SetInformationJobObject failed (GetLastError=${code})`);
    }
    return job;
  };
  const JOB_ACCOUNTING_SIZE = 48;
  const OFF_TOTAL_PROCESSES = 36;
  const OFF_ACTIVE_PROCESSES = 40;
  const accountingOf = (job) => {
    const accounting = Buffer.alloc(JOB_ACCOUNTING_SIZE);
    const queried = QueryInformationJobObject(job, 1, accounting, accounting.length, null);
    if (!queried) return void 0;
    return { total: accounting.readUInt32LE(OFF_TOTAL_PROCESSES), active: accounting.readUInt32LE(OFF_ACTIVE_PROCESSES) };
  };
  const spawnAssignmentProbe = () => {
    const { spawn } = require_("node:child_process");
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const candidates = [];
    const ping = join(systemRoot, "System32", "ping.exe");
    if (existsSync(ping)) candidates.push({ exe: ping, args: ["-n", "30", "127.0.0.1"], kind: "ping.exe" });
    candidates.push({ exe: process.execPath, args: ["-e", "setTimeout(() => {}, 20000)"], kind: "node-idle" });
    for (const candidate of candidates) {
      if (!existsSync(candidate.exe)) continue;
      const child = safe(
        () => spawn(candidate.exe, candidate.args, {
          stdio: "ignore",
          // 见 src/spawn-window.ts：不用会 0xC0000142 的那组创建标志；
          // 弹框由该模块在模块入口的 SetErrorMode 抑制。
          windowsHide: WINDOWS_HIDE,
          env: { SystemRoot: systemRoot }
        }),
        () => void 0
      );
      if (child && typeof child.pid === "number" && child.pid > 0) {
        return { pid: child.pid, kind: candidate.kind, child };
      }
      safe(() => child?.kill?.(), () => void 0);
    }
    return void 0;
  };
  results.jobObject = safe(
    () => {
      const job = makeVerifyJob();
      const probe = spawnAssignmentProbe();
      try {
        if (!probe) {
          return no(
            "no assignment probe child could be spawned (ping.exe and the current node executable were both unusable); cannot prove process-tree reclamation",
            { evidence: "[\u5B9E\u6D4B]", childSpawned: false, selfAssigned: false }
          );
        }
        const OpenProcess = kernel32.func("void *OpenProcess(uint32 access, bool inherit, uint32 pid)");
        const TerminateProcess = kernel32.func("bool TerminateProcess(void *proc, uint32 code)");
        const PROCESS_TERMINATE = 1;
        const PROCESS_SET_QUOTA = 256;
        const PROCESS_QUERY_INFORMATION = 1024;
        const handle = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION, false, probe.pid) || null;
        if (!handle) {
          const openError = GetLastError();
          if (openError === 5) {
            return unknown(
              `OpenProcess(pid=${probe.pid}) denied (GetLastError=5 ACCESS_DENIED): this session cannot open its own derived child, so job ownership cannot be measured here. Classified as a session boundary (requires an unconstrained session), NOT as "Job Object unavailable" \u2014 and NOT as pass: fail-closed is preserved because selectTier requires status=pass.`,
              {
                evidence: "[\u5B9E\u6D4B]",
                boundary: "open-process-denied",
                win32Code: 5,
                childSpawned: true,
                childPid: probe.pid,
                childKind: probe.kind,
                selfAssigned: false
              }
            );
          }
          return no(`OpenProcess(pid=${probe.pid}) failed (GetLastError=${openError})`, {
            evidence: "[\u5B9E\u6D4B]",
            childSpawned: true,
            childPid: probe.pid,
            childKind: probe.kind,
            selfAssigned: false
          });
        }
        try {
          const childAssigned = AssignProcessToJobObject(job, handle) === true;
          if (!childAssigned) {
            const assignError = GetLastError();
            return no(
              `AssignProcessToJobObject failed for the derived child (pid=${probe.pid}, ${probe.kind}, GetLastError=${assignError}); process-tree reclamation cannot be enforced in this context`,
              {
                evidence: "[\u5B9E\u6D4B]",
                childSpawned: true,
                childPid: probe.pid,
                childKind: probe.kind,
                childAssigned: false,
                assignError,
                selfAssigned: false
              }
            );
          }
          const acct = accountingOf(job);
          if (!acct || acct.total < 1) {
            return no(
              `AssignProcessToJobObject(child pid=${probe.pid}) returned success but the job accounting does not show it (accounting=${acct ? JSON.stringify(acct) : "query failed"}); refusing to treat the job as usable`,
              {
                evidence: "[\u5B9E\u6D4B]",
                childSpawned: true,
                childPid: probe.pid,
                childKind: probe.kind,
                childAssigned: true,
                accounting: acct ?? null,
                selfAssigned: false
              }
            );
          }
          return ok(
            `a derived child process (pid=${probe.pid}, ${probe.kind}) was assigned into a scratch Job and verified in the job accounting (totalProcesses=${acct.total}, activeProcesses=${acct.active}); the current process is deliberately NOT assigned, so closing the job handle cannot kill the caller`,
            {
              evidence: "[\u5B9E\u6D4B]",
              verifiedVia: "child-process",
              childSpawned: true,
              childPid: probe.pid,
              childKind: probe.kind,
              childAssigned: true,
              accounting: acct,
              selfAssigned: false,
              killOnJobClose: false
            }
          );
        } finally {
          safe(() => TerminateProcess(handle, 1), () => void 0);
          safe(() => CloseHandleK(handle), () => void 0);
        }
      } finally {
        safe(() => probe?.child?.kill?.(), () => void 0);
        safe(() => CloseHandleK(job), () => void 0);
      }
    },
    (error) => no(`Job Object unavailable: ${error.message}`, { evidence: "[\u5B9E\u6D4B]", selfAssigned: false })
  );
  return { status: "mixed", checks: results };
}
var APPCONTAINER_ISOLATION_TTL_MS = 6 * 60 * 60 * 1e3;
var winIni = join(process.env.SystemRoot || "C:\\Windows", "win.ini");

// dsh-plugin/baseline-watch.ts
var WATCH_INTERVAL_MS = 1500;
function watchIntervalFromEnv(env = process.env) {
  const raw = env?.WINSTAGE_WATCH_MS;
  if (raw === void 0 || raw === "") return void 0;
  const value = Number(raw);
  if (!Number.isFinite(value)) return void 0;
  return value;
}
function installBaselineWatch(ctx, options = {}) {
  const { workspaceRoot, log = () => {
  }, logError = () => {
  }, env = process.env } = options;
  if (!workspaceRoot) throw new Error("installBaselineWatch: workspaceRoot is required");
  const envInterval = watchIntervalFromEnv(env);
  const intervalMs = options.intervalMs !== void 0 ? options.intervalMs : envInterval !== void 0 ? envInterval : WATCH_INTERVAL_MS;
  const tick = () => {
    let services = [];
    try {
      services = listReviewServices(workspaceRoot);
    } catch (error) {
      logError(`\u57FA\u7EBF\u590D\u6838\uFF1A\u679A\u4E3E\u4F1A\u8BDD\u670D\u52A1\u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF09\uFF1A${error?.message ?? error}`);
      return 0;
    }
    for (const service of services) {
      try {
        const result = service.reviewDrift();
        if (result.changed === true && result.stale.length > 0) {
          log(`\u57FA\u7EBF\u590D\u6838\uFF1A\u5916\u90E8\u6539\u52A8\u4F7F ${result.stale.length} \u9879\u57FA\u7EBF\u8FC7\u671F\uFF0C\u5DF2\u91CD\u65B0\u53D1\u5E03\u5FEB\u7167\u3002`);
        }
        if (typeof service.emitDriftDiagnostics === "function") service.emitDriftDiagnostics(result.stale);
      } catch (error) {
        logError(`\u57FA\u7EBF\u590D\u6838\u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF0C\u4E0D\u5F71\u54CD\u5BA1\u6279\uFF09\uFF1A${error?.message ?? error}`);
      }
    }
    return services.length;
  };
  if (!(intervalMs > 0)) {
    return { stop: () => {
    }, intervalMs: 0, tick };
  }
  let timer;
  const start = () => {
    timer = setInterval(tick, intervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = void 0;
  };
  if (ctx && typeof ctx.effect === "function") {
    ctx.effect(() => {
      start();
      return stop;
    }, "winstage-sandbox: baseline watch");
  } else {
    start();
  }
  return { stop, intervalMs, tick };
}

// dsh-plugin/audit-mirror.ts
function hasOpenTurn(session) {
  try {
    const seq = Number(session?.seq);
    if (!Number.isFinite(seq) || seq <= 0) return false;
    for (let i = seq - 1; i >= 0; i -= 1) {
      const event = session.eventAt?.(i);
      const type = event?.type;
      if (type === "turn/start") return true;
      if (type === "turn/end") return false;
    }
  } catch {
  }
  return false;
}
function winStageApprovalId(candidateId) {
  const key = typeof candidateId === "string" && candidateId.length > 0 ? candidateId : "unknown";
  return `winstage:${key}`;
}
function createAuditMirror(options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {
  };
  const logError = typeof options.logError === "function" ? options.logError : () => {
  };
  const sessionOf = typeof options.sessionOf === "function" ? options.sessionOf : () => void 0;
  function emit(kind, payload) {
    try {
      const session = sessionOf();
      if (!session || typeof session.append !== "function") {
        log(`winstage \u5BA1\u8BA1\uFF1A${kind} \u8DF3\u8FC7\uFF08\u62FF\u4E0D\u5230 session \u53E5\u67C4\uFF09`);
        return false;
      }
      if (!hasOpenTurn(session)) {
        log(`winstage \u5BA1\u8BA1\uFF1A${kind} \u8DF3\u8FC7\uFF08\u5F53\u524D\u4E0D\u5728\u5F00\u7740\u56DE\u5408\u5185\uFF0C\u5199\u4E0B\u53BB\u4E0E\u5D29\u6E83\u5C3E\u5DF4\u65E0\u6CD5\u533A\u5206\uFF09`);
        return false;
      }
      session.append(kind, payload);
      return true;
    } catch (error) {
      logError(`winstage \u5BA1\u8BA1\uFF1A\u5199 ${kind} \u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF0C\u4E0D\u5F71\u54CD\u5BA1\u6279\uFF09\uFF1A${error?.message ?? error}`);
      return false;
    }
  }
  return {
    /**
     * 暂存产生待审候选 ⇒ 写 `approval/asked`。
     * @param {{candidateId?: string, fileCount?: number, reason?: string}} info
     */
    ask(info = {}) {
      const id = winStageApprovalId(info.candidateId);
      const count = Number.isFinite(info.fileCount) ? info.fileCount : void 0;
      const reason = typeof info.reason === "string" && info.reason.length > 0 ? info.reason : `${count ?? "\u82E5\u5E72"} \u9879\u53D8\u66F4\u5DF2\u6682\u5B58\uFF0C\u7B49\u5F85\u5BA1\u6279\uFF08/winstage approve|reject\uFF09`;
      return emit("approval/asked", {
        id,
        toolName: "winstage-stage",
        reason
      });
    },
    /**
     * 批准/拒绝完成 ⇒ 写 `approval/decided`（与 asked 同一 id）。
     * `outcome` 沿用原生词汇：批准 = `'allowed-once'`（唯一的授予值），
     * 拒绝 = `'rejected'`。
     * @param {{candidateId?: string, approved?: boolean, pathCount?: number, note?: string}} info
     */
    decide(info = {}) {
      const id = winStageApprovalId(info.candidateId);
      const outcome = info.approved === true ? "allowed-once" : "rejected";
      const payload = { id, outcome };
      if (Number.isFinite(info.pathCount)) payload.pathCount = info.pathCount;
      if (typeof info.note === "string" && info.note.length > 0) payload.note = info.note;
      return emit("approval/decided", payload);
    }
  };
}

// dsh-plugin/run-capture.ts
import { existsSync as existsSync2, lstatSync, readFileSync as readFileSync2, readdirSync } from "node:fs";
import { join as join2, normalize, relative, sep as sep2 } from "node:path";
var MIRROR_BASENAME = "capture-mirror.json";
var MIRROR_VERSION = 1;
function shimLayoutPathOf(stagedDir, abs, leaf = "fs") {
  if (typeof stagedDir !== "string" || stagedDir.length === 0) return void 0;
  const normalized = normalize(String(abs));
  let drive;
  let rest;
  if (normalized.startsWith("\\\\")) {
    drive = "_unc";
    rest = normalized.slice(2);
  } else {
    const match = /^([a-zA-Z]):[\\/]?(.*)$/.exec(normalized);
    if (!match) return void 0;
    drive = match[1].toUpperCase();
    rest = match[2];
  }
  const parts = rest.split(/[\\/]+/).filter((part) => part.length > 0);
  return join2(stagedDir, leaf, drive, ...parts);
}
var DEFAULT_ROOTS = (workspaceRoot) => [workspaceRoot];
var DEFAULT_EXCLUDE = ["**/.dshstage/**", "**/.git/**", "**/node_modules/**"];
var DEFAULT_MAX_FILE_BYTES = 5e6;
var DEFAULT_MAX_FILES = 5e3;
var MAX_SKIP_RECORDS = 200;
var CAPTURE_FAILURE_TEXT = Object.freeze({
  writeNotPersisted: (displayPath) => `cannot save "${displayPath}": the change could not be read back from disk and is not reported as applied`
});
function isReparse(info) {
  if (!info) return false;
  if (typeof info.isSymbolicLink === "function" && info.isSymbolicLink()) return true;
  return (Number(info.mode ?? 0) & 1024) !== 0;
}
function matchesAny(patterns, rel, abs) {
  const relSlash = rel.split(sep2).join("/");
  const absSlash = abs.split(sep2).join("/");
  for (const pattern2 of patterns) {
    if (pattern2.test(relSlash)) return true;
    if (pattern2.test(absSlash)) return true;
  }
  return false;
}
function excludedDir(patterns, rel, abs) {
  if (matchesAny(patterns, rel, abs)) return true;
  const relSlash = rel.split(sep2).join("/");
  const absSlash = abs.split(sep2).join("/");
  return patterns.some((pattern2) => pattern2.test(`${relSlash}/`) || pattern2.test(`${absSlash}/`));
}
function globToRegExp(glob) {
  const text = String(glob).split("\\").join("/");
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "*") {
      if (next === "*") {
        i += 1;
        if (text[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += /[a-zA-Z0-9_/-]/.test(ch) ? ch : `\\${ch}`;
  }
  return new RegExp(`^${out}$`, "i");
}
function walkMonitored(roots, patterns, maxFileBytes, maxFiles) {
  const files = /* @__PURE__ */ new Map();
  const skipped = [];
  const note = (path, reason) => {
    if (skipped.length < MAX_SKIP_RECORDS) skipped.push({ path, reason });
  };
  let truncated = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      note(dir, `readdir-failed: ${error.message}`);
      return;
    }
    for (const entry of entries) {
      const name3 = entry.name;
      const abs = join2(dir, name3);
      const rel = relative(dir, abs);
      if (entry.isSymbolicLink()) {
        note(abs, "reparse-point");
        continue;
      }
      let info;
      try {
        info = lstatSync(abs);
      } catch (error) {
        note(abs, `lstat-failed: ${error.message}`);
        continue;
      }
      if (info.isDirectory()) {
        if (excludedDir(patterns, rel, abs)) continue;
        if (isReparse(info)) {
          note(abs, "reparse-point(directory)");
          continue;
        }
        walk(abs);
        continue;
      }
      if (isReparse(info)) {
        note(abs, "reparse-point");
        continue;
      }
      if (!info.isFile()) {
        note(abs, "not-a-regular-file");
        continue;
      }
      if (matchesAny(patterns, rel, abs)) continue;
      if (info.size > maxFileBytes) {
        note(abs, `too-large(${info.size}>${maxFileBytes})`);
        continue;
      }
      if (files.size >= maxFiles) {
        truncated += 1;
        continue;
      }
      files.set(abs, { size: info.size, mtimeMs: info.mtimeMs });
    }
  };
  for (const root of roots) {
    const absRoot = normalize(root);
    let info;
    try {
      info = lstatSync(absRoot);
    } catch (error) {
      note(absRoot, `root-missing: ${error.message}`);
      continue;
    }
    if (info.isDirectory()) {
      if (isReparse(info)) {
        note(absRoot, "reparse-point(directory)");
        continue;
      }
      walk(absRoot);
      continue;
    }
    if (isReparse(info) || !info.isFile()) {
      note(absRoot, isReparse(info) ? "reparse-point" : "not-a-regular-file");
      continue;
    }
    if (info.size > maxFileBytes) {
      note(absRoot, `too-large(${info.size}>${maxFileBytes})`);
      continue;
    }
    if (files.size < maxFiles) files.set(absRoot, { size: info.size, mtimeMs: info.mtimeMs });
    else truncated += 1;
  }
  if (truncated > 0) {
    note(`<maxFiles>`, `truncated: ${truncated} more file(s) were NOT collected (maxFiles=${maxFiles})`);
  }
  return { files, skipped };
}
function asMap(before) {
  if (before instanceof Map) return before;
  if (before && typeof before === "object") {
    if (before.before instanceof Map) return before.before;
    if (before.files && typeof before.files === "object") return new Map(Object.entries(before.files));
  }
  return /* @__PURE__ */ new Map();
}
function mirrorAbsOf(key) {
  try {
    return canonical(key);
  } catch {
    return void 0;
  }
}
function pathKey(abs) {
  try {
    return canonical(abs);
  } catch {
    return String(abs);
  }
}
function createRunCapture(options = {}) {
  if (!options || typeof options !== "object") throw new TypeError("createRunCapture: options must be an object");
  const workspaceRoot = options.workspaceRoot;
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new TypeError("createRunCapture: options.workspaceRoot is required");
  }
  const store = options.store;
  if (!store || typeof store.putBlob !== "function" || typeof store.materializeBlob !== "function") {
    throw new TypeError("createRunCapture: options.store must be a Store instance (putBlob/materializeBlob)");
  }
  const workspace = options.workspace;
  if (!workspace || typeof workspace.writeFile !== "function" || typeof workspace.diffEntries !== "function") {
    throw new TypeError("createRunCapture: options.workspace must be a Workspace instance (writeFile/diffEntries)");
  }
  const log = typeof options.log === "function" ? options.log : () => {
  };
  const roots = (Array.isArray(options.roots) && options.roots.length > 0 ? options.roots : DEFAULT_ROOTS(workspaceRoot)).map((root) => canonical(root));
  const exclude = (Array.isArray(options.exclude) ? options.exclude : DEFAULT_EXCLUDE).map(globToRegExp);
  const maxFileBytes = Number.isFinite(options.maxFileBytes) ? options.maxFileBytes : DEFAULT_MAX_FILE_BYTES;
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : DEFAULT_MAX_FILES;
  const mirrorPath = join2(String(store.dir), MIRROR_BASENAME);
  let lastPrimed = /* @__PURE__ */ new Map();
  function walk() {
    return walkMonitored(roots, exclude, maxFileBytes, maxFiles);
  }
  function keyOf(abs) {
    const place = workspace.keyOf ? workspace.keyOf(abs) : void 0;
    if (place && typeof place.key === "string" && place.key.length > 0) return place.key;
    return canonical(abs);
  }
  function readMirror() {
    try {
      if (!existsSync2(mirrorPath)) return { files: {}, error: void 0 };
      const raw = JSON.parse(readFileSync2(mirrorPath, "utf8"));
      if (!raw || raw.version !== MIRROR_VERSION || typeof raw.files !== "object" || raw.files === null) {
        return { files: {}, error: `\u955C\u50CF\u7248\u672C\u6216\u5F62\u72B6\u4E0D\u53D7\u652F\u6301\uFF08version=${raw && raw.version}\uFF09` };
      }
      return { files: raw.files, error: void 0 };
    } catch (error) {
      return { files: {}, error: error.message };
    }
  }
  function writeMirror(files) {
    const mirror = { version: MIRROR_VERSION, updatedAt: (/* @__PURE__ */ new Date()).toISOString(), files };
    writeFileAtomic(mirrorPath, JSON.stringify(mirror, null, 2));
    return mirror;
  }
  function afterHashOf(abs) {
    const buffer = readFileSync2(abs);
    return { hash: store.putBlob(buffer), bytes: buffer.length };
  }
  function stage(change) {
    const abs = change.abs;
    const isDelete = change.kind === "deleted";
    const priorBaseHash = workspace.entryOf(keyOf(abs))?.baseHash;
    if (isDelete) {
      workspace.remove(abs, { missingOk: true, origin: "run-capture" });
    } else {
      workspace.writeFile(abs, readFileSync2(abs), { origin: "run-capture" });
    }
    const key = keyOf(abs);
    const entry = workspace.entryOf(key);
    if (entry) {
      if (isDelete) {
        entry.baseHash = change.beforeHash;
        entry.baseKind = "file";
      } else if (change.kind === "created") {
        entry.baseHash = hashAbsent();
        entry.baseKind = "file";
      } else {
        entry.baseHash = priorBaseHash !== void 0 ? priorBaseHash : change.beforeHash;
        entry.baseKind = "file";
      }
      entry.changed = entry.state === STATE.DELETED ? true : entry.stagedHash !== entry.baseHash;
      entry.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    }
    return { key, entry };
  }
  function verifyStagedChange(change, key, afterBytes) {
    const problems = [];
    let stagedPath;
    try {
      stagedPath = store.stagedPath(key);
    } catch (error2) {
      problems.push(`stagedPath-unresolved(${error2.message})`);
      stagedPath = void 0;
    }
    const entry = workspace.entryOf(key);
    const hashOfFile = (path) => {
      try {
        return sha256Buffer(readFileSync2(path));
      } catch (error2) {
        return `unreadable:${error2.code ?? error2.message}`;
      }
    };
    const bytesOfFile = (path) => {
      try {
        return readFileSync2(path);
      } catch (error2) {
        return `unreadable:${error2.code ?? error2.message}`;
      }
    };
    if (change.kind === "deleted") {
      if (!entry) problems.push("manifest-entry-missing");
      else if (entry.state !== STATE.DELETED) problems.push(`manifest-state=${entry.state}`);
      if (stagedPath && existsSync2(stagedPath)) problems.push(`staged-object-still-present(${stagedPath})`);
    } else {
      const expected = change.afterHash;
      if (!store.hasBlob(expected)) problems.push(`blob-missing(${expected})`);
      else {
        const found = hashOfFile(store.blobPath(expected));
        if (found !== expected) problems.push(`blob-hash-mismatch(on-disk=${found})`);
      }
      try {
        const raw = JSON.parse(readFileSync2(join2(String(store.dir), "manifest.json"), "utf8"));
        const persisted = raw?.entries?.[key];
        if (!persisted) problems.push("manifest-not-persisted");
        else if (persisted.stagedHash !== expected) problems.push(`manifest-persisted-hash-mismatch(${persisted.stagedHash})`);
      } catch (error2) {
        problems.push(`manifest-unreadable(${error2.code ?? error2.message})`);
      }
      if (!entry) problems.push("manifest-entry-missing");
      else if (entry.stagedHash !== expected) problems.push(`manifest-hash-mismatch(${entry.stagedHash})`);
      const blobBytes = store.hasBlob(expected) ? bytesOfFile(store.blobPath(expected)) : void 0;
      let stagedBytes;
      if (stagedPath === void 0 || !existsSync2(stagedPath)) problems.push(`staged-object-missing(${stagedPath})`);
      else stagedBytes = bytesOfFile(stagedPath);
      if (typeof stagedBytes === "string") problems.push(`staged-object-unreadable(${stagedBytes})`);
      else if (Buffer.isBuffer(stagedBytes)) {
        if (Buffer.isBuffer(afterBytes) && !stagedBytes.equals(afterBytes)) {
          problems.push(`staged-object-bytes-mismatch(on-disk=${stagedBytes.length} submitted=${afterBytes.length})`);
        }
        if (Buffer.isBuffer(blobBytes) && !blobBytes.equals(stagedBytes)) problems.push("blob-bytes-mismatch");
      }
      if (Buffer.isBuffer(afterBytes) && Buffer.isBuffer(blobBytes) && !blobBytes.equals(afterBytes)) {
        problems.push(`blob-bytes-vs-submitted-mismatch(on-disk=${blobBytes.length} submitted=${afterBytes.length})`);
      }
      if (!Buffer.isBuffer(afterBytes)) problems.push("submitted-bytes-unavailable");
    }
    if (problems.length === 0) return { key, stagedPath, verified: true };
    const error = new Error(CAPTURE_FAILURE_TEXT.writeNotPersisted(change.abs));
    error.code = "staging_write_not_persisted";
    error.key = key;
    error.stagedPath = stagedPath;
    error.problems = problems;
    error.detail = problems.join("; ");
    return { key, stagedPath, verified: false, error, problems };
  }
  function detectSplit(change, key) {
    const stagedDir = store.stagedDir;
    const twin = shimLayoutPathOf(stagedDir, change.abs, "fs");
    const whiteout = shimLayoutPathOf(stagedDir, change.abs, "wo");
    const twinExists = twin !== void 0 && existsSync2(twin);
    const whiteoutExists = whiteout !== void 0 && existsSync2(whiteout);
    if (!twinExists && !whiteoutExists) return void 0;
    const record = {
      key,
      abs: change.abs,
      stagedPath: (() => {
        try {
          return store.stagedPath(key);
        } catch {
          return void 0;
        }
      })(),
      otherLayout: twinExists ? { layout: "shim-fs", path: twin } : { layout: "shim-fs-whiteout", path: whiteout }
    };
    log(
      `[run-capture] \u6682\u5B58\u843D\u70B9\u5206\u88C2\uFF08BUG-2\uFF09\uFF1A\u540C\u4E00\u903B\u8F91\u76EE\u6807 ${change.abs} \u5728\u4E24\u5957\u5E03\u5C40\u91CC\u90FD\u6709\u843D\u70B9 \u2014\u2014 \u6E05\u5355\u843D\u70B9 ${record.stagedPath}\uFF08\u672C\u6A21\u5757\u5199\u5165\u5F52\u4E00\u5230\u8FD9\u91CC\uFF09\uFF1Bshim/shell \u843D\u70B9 ${record.otherLayout.path}\u3002\u8BFB\u53D6\u65F6\u4E24\u8FB9\u90FD\u770B\uFF08staging-fs.ts\uFF09\uFF0C\u4F46\u6E05\u5355/\u5BA1\u6279\u53EA\u8BA4\u524D\u8005\uFF0C\u540E\u8005\u4E0D\u4F1A\u88AB\u81EA\u52A8\u6E05\u7406\u3002`,
      "error"
    );
    return record;
  }
  async function prime() {
    const { files, skipped } = walk();
    const entries = {};
    const before = /* @__PURE__ */ new Map();
    let bytes = 0;
    for (const [abs, info] of files) {
      let hash;
      try {
        hash = store.putBlob(readFileSync2(abs));
      } catch (error) {
        log(`[run-capture] prime \u8BFB\u53D6\u5931\u8D25\uFF0C\u8BE5\u8DEF\u5F84\u4E0D\u8FDB\u6267\u884C\u524D\u955C\u50CF\uFF1A${abs} \u2014 ${error.message}`, "error");
        skipped.push({ path: abs, reason: `read-failed: ${error.message}` });
        continue;
      }
      const key = keyOf(abs);
      entries[key] = { hash, size: info.size, mtimeMs: info.mtimeMs };
      before.set(abs, { hash, size: info.size, mtimeMs: info.mtimeMs });
      bytes += info.size;
    }
    const index = writeMirror(entries);
    lastPrimed = before;
    before.authoritative = true;
    return { files: before.size, bytes, skipped, index, before, authoritative: true };
  }
  async function snapshot2() {
    const { files } = walk();
    const out = /* @__PURE__ */ new Map();
    for (const [abs, info] of files) out.set(pathKey(abs), { size: info.size, mtimeMs: info.mtimeMs });
    return out;
  }
  async function diff(before) {
    const { changes } = await diffAgainst(before);
    return changes;
  }
  async function diffAgainst(before) {
    const base = before === void 0 ? lastPrimed : asMap(before);
    const lookup = /* @__PURE__ */ new Map();
    for (const [path, entry] of base) {
      if (!entry || typeof entry.hash !== "string") continue;
      const key = pathKey(path);
      if (!lookup.has(key)) lookup.set(key, entry);
    }
    const { files } = walk();
    const changes = [];
    const seen = /* @__PURE__ */ new Set();
    for (const [abs, info] of files) {
      const key = pathKey(abs);
      seen.add(key);
      const previous = lookup.get(key);
      const beforeHash = previous ? previous.hash : hashAbsent();
      const { hash: after } = afterHashOf(abs);
      if (beforeHash === hashAbsent()) {
        changes.push({ abs, key: keyOf(abs), kind: "created", beforeHash, afterHash: after });
        continue;
      }
      if (beforeHash !== after) {
        changes.push({ abs, key: keyOf(abs), kind: "modified", beforeHash, afterHash: after });
      }
    }
    for (const [abs, previous] of base) {
      if (seen.has(pathKey(abs))) continue;
      if (existsSync2(abs)) continue;
      if (previous.hash === hashAbsent()) continue;
      changes.push({ abs, key: keyOf(abs), kind: "deleted", beforeHash: previous.hash, afterHash: hashAbsent() });
    }
    return { changes, lookup };
  }
  async function capture(before, opts = {}) {
    const restore = opts.restore !== false;
    const failures = [];
    const noteFailure = (path, phase, message) => {
      failures.push({ path, phase, message });
      log(`[run-capture] ${phase} \u5931\u8D25\uFF1A${path} \u2014 ${message}`, "error");
    };
    const { files: mirrorFiles, error } = readMirror();
    if (error) {
      log(`[run-capture] \u6267\u884C\u524D\u955C\u50CF\u4E0D\u53EF\u7528\uFF08${mirrorPath}\uFF09\uFF1A${error}`, "error");
    }
    const base = before === void 0 ? new Map(Object.entries(mirrorFiles)) : asMap(before);
    const authoritative = before !== void 0 ? before.authoritative === true : error === void 0 && existsSync2(mirrorPath);
    const unknownPaths = new Set(
      (Array.isArray(opts.unknownPaths) ? opts.unknownPaths : []).map((p) => pathKey(canonical(String(p))))
    );
    if (workspace.init) {
      try {
        workspace.init();
      } catch (initError) {
        log(`[run-capture] workspace.init() \u5931\u8D25\uFF0C\u7EE7\u7EED\u7528\u5185\u5B58\u4E2D\u7684\u6E05\u5355\uFF1A${initError.message}`, "error");
      }
    }
    const { changes: changeRecords, lookup } = await diffAgainst(base);
    const stagedChanges = [];
    const splits = [];
    for (const change of changeRecords) {
      let afterBytes;
      if (change.kind !== "deleted") {
        try {
          afterBytes = readFileSync2(change.abs);
          const hash = store.putBlob(afterBytes);
          if (hash !== change.afterHash) {
            noteFailure(change.abs, "blob", `\u5185\u5BB9\u6233\u4E0E\u5224\u53D8\u7ED3\u679C\u4E0D\u4E00\u81F4\uFF1A${hash} != ${change.afterHash}`);
            continue;
          }
        } catch (blobError) {
          noteFailure(change.abs, "blob", `\u843D after blob \u5931\u8D25\uFF1A${blobError.message}`);
          continue;
        }
      }
      try {
        stage(change);
      } catch (stageError) {
        noteFailure(change.abs, "stage", `\u843D\u6682\u5B58\u6761\u76EE\u5931\u8D25\uFF1A${stageError.message}`);
        continue;
      }
      const verification = verifyStagedChange(change, change.key, afterBytes);
      if (verification.verified !== true) {
        noteFailure(
          change.abs,
          "verify",
          `\u843D\u6682\u5B58\u540E\u56DE\u8BFB\u786E\u8BA4\u5931\u8D25\uFF08BUG-1\uFF0C\u4EA7\u7269\u4E0D\u5B58\u5728\u6216\u5185\u5BB9\u4E0D\u4E00\u81F4\uFF0C\u672A\u51BB\u7ED3\u5019\u9009\uFF09\uFF1A${verification.error.detail}`
        );
        continue;
      }
      const split = detectSplit(change, change.key);
      if (split) splits.push(split);
      stagedChanges.push(change);
    }
    if (stagedChanges.length > 0) {
      try {
        const frozen = workspace.freezeIfNeeded({ source: "run-capture" });
        if (frozen && frozen.frozen === false && frozen.reason !== "already-represented") {
          log(`[run-capture] \u672A\u4EA7\u751F\u65B0\u5019\u9009\uFF1A${frozen.reason}\uFF08\u51C0\u53D8\u5316 ${frozen.changes ?? 0} \u6761\uFF09`, "error");
        }
      } catch (freezeError) {
        for (const change of stagedChanges) {
          noteFailure(change.abs, "freeze", `\u51BB\u7ED3\u5019\u9009\u5931\u8D25\uFF08\u6682\u5B58\u5185\u5BB9\u4ECD\u5728\uFF09\uFF1A${freezeError.message}`);
        }
      }
    }
    let restored = 0;
    const restoredChanges = [];
    if (restore) {
      for (const change of stagedChanges) {
        const recorded = lookup.get(pathKey(change.abs));
        if (change.kind === "created") {
          if (!authoritative || unknownPaths.has(pathKey(change.abs))) {
            noteFailure(
              change.abs,
              "restore",
              '\u6267\u884C\u524D\u72B6\u6001\u4E0D\u6743\u5A01\uFF08\u672A prime\uFF0C\u6216\u8BE5\u8DEF\u5F84\u5728 prime \u9636\u6BB5\u8BFB\u5931\u8D25\uFF09\uFF1A\u4E0D\u6562\u6309"\u6267\u884C\u524D\u4E0D\u5B58\u5728"\u5220\u9664\uFF0C\u672A\u8C03\u7528 materializeBlob'
            );
            continue;
          }
          try {
            store.materializeBlob(hashAbsent(), change.abs);
            restored += 1;
            restoredChanges.push(change);
          } catch (restoreError) {
            noteFailure(change.abs, "restore", `\u8FD8\u539F\u771F\u5B9E\u4E3B\u673A\u5931\u8D25\uFF1A${restoreError.message}`);
          }
          continue;
        }
        const target = recorded?.hash ?? change.beforeHash;
        try {
          store.materializeBlob(target, change.abs);
          restored += 1;
          restoredChanges.push(change);
        } catch (restoreError) {
          noteFailure(change.abs, "restore", `\u8FD8\u539F\u771F\u5B9E\u4E3B\u673A\u5931\u8D25\uFF1A${restoreError.message}`);
        }
      }
    }
    try {
      const diskNow = await snapshot2();
      const updated = {};
      for (const [key, value] of Object.entries(mirrorFiles)) {
        const abs = mirrorAbsOf(isExternalKey(key) ? key : join2(workspaceRoot, key));
        if (!abs || !diskNow.has(pathKey(abs))) continue;
        updated[key] = value;
      }
      const restoredCreates = new Set(
        restoredChanges.filter((change) => change.kind === "created").map((change) => change.key)
      );
      for (const change of stagedChanges) {
        if (change.kind === "deleted") continue;
        if (change.kind === "created" && !restoredCreates.has(change.key)) continue;
        const meta = diskNow.get(pathKey(change.abs));
        if (!meta) continue;
        updated[change.key] = { hash: change.afterHash, size: meta.size, mtimeMs: meta.mtimeMs };
      }
      if (!restore && stagedChanges.length > 0) {
        log(
          "[run-capture] restore=false\uFF1A\u6267\u884C\u524D\u955C\u50CF\u4FDD\u6301\u4E0D\u53D8\uFF08\u7EDD\u4E0D\u7528\u6267\u884C\u540E\u7684\u78C1\u76D8\u5185\u5BB9\u8986\u76D6 before \u57FA\u7EBF\uFF09",
          "info"
        );
      }
      writeMirror(updated);
    } catch (mirrorError) {
      log(`[run-capture] \u5237\u65B0\u6267\u884C\u524D\u955C\u50CF\u5931\u8D25\uFF08\u4E0B\u6B21\u6355\u83B7\u4F1A\u9000\u56DE\u5185\u5B58\u955C\u50CF\uFF09\uFF1A${mirrorError.message}`, "error");
    }
    if (changeRecords.length > 0) {
      log(
        `[run-capture] \u6355\u83B7\u5B8C\u6210\uFF1A\u53D8\u5316 ${changeRecords.length} \u6761\uFF08\u5165\u6682\u5B58 ${stagedChanges.length} \u6761\uFF0C\u8FD8\u539F ${restored} \u6761\uFF0C\u5931\u8D25 ${failures.length} \u6761\uFF0C\u843D\u70B9\u5206\u88C2 ${splits.length} \u6761\uFF09`,
        failures.length > 0 || splits.length > 0 ? "error" : "info"
      );
    }
    return { changes: changeRecords, staged: stagedChanges.length, restored, failures, splits };
  }
  return { prime, snapshot: snapshot2, diff, capture, mirrorPath, roots: [...roots], exclude: [...exclude] };
}

// dsh-plugin/host-plugin.ts
var name = "winstage-sandbox";
var inject = [];
function makeLog(ctx) {
  const logger = ctx?.logger;
  if (logger && typeof logger.info === "function") {
    return {
      info: (msg) => logger.info(msg),
      warn: (msg) => typeof logger.warn === "function" ? logger.warn(msg) : logger.info(msg)
    };
  }
  return {
    info: (msg) => console.log(`[winstage-sandbox] ${msg}`),
    warn: (msg) => console.warn(`[winstage-sandbox] ${msg}`)
  };
}
function probeRuntime() {
  const result = {
    tokenRights: void 0,
    canMintRestrictedToken: false,
    missingRights: [],
    moduleRoots: [],
    ready: false,
    detail: ""
  };
  try {
    result.moduleRoots = resolveDshModuleRoot();
  } catch (error) {
    result.detail = `\u65E0\u6CD5\u89E3\u6790\u4F9D\u8D56\u4F4D\u7F6E: ${error.message}`;
    return result;
  }
  try {
    const caps = WindowsStageExecutor.capabilities();
    if (!caps.aclAvailable) {
      result.detail = `ACL \u540E\u7AEF\u4E0D\u53EF\u52A0\u8F7D: ${caps.aclError ?? "unknown"}`;
      return result;
    }
    const abi = probeWin32Abi();
    const rights = abi?.checks?.tokenRights?.granted ?? {};
    result.tokenRights = rights;
    result.missingRights = Object.entries(rights).filter(([, granted]) => !granted).map(([right]) => right);
    result.canMintRestrictedToken = abi?.checks?.createRestrictedTokenViable?.status === "pass";
    result.ready = result.canMintRestrictedToken;
    result.detail = result.ready ? "\u672C\u4F1A\u8BDD\u53EF\u4EE5\u5EFA\u7ACB\u53D7\u9650\u4EE4\u724C\uFF0CWinStageSandbox \u7684\u6C99\u7BB1\u6267\u884C\u9762\u53EF\u7528" : `\u672C\u4F1A\u8BDD\u65E0\u6CD5\u5EFA\u7ACB\u53D7\u9650\u4EE4\u724C\uFF08\u7F3A\u5C11 ${result.missingRights.join(", ")}\uFF09\u3002\u8FD9\u53EA\u5F71\u54CD"\u6C99\u7BB1\u5185\u8DD1\u547D\u4EE4"\uFF0C\u6682\u5B58\u9762\u4E0D\u53D7\u5F71\u54CD\u3002`;
  } catch (error) {
    result.detail = `\u63A2\u6D4B\u629B\u9519: ${error.message}`;
  }
  return result;
}
function splitArgs(rawInput) {
  const out = [];
  let current = "";
  let quoted = false;
  for (const ch of String(rawInput ?? "")) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) out.push(current);
  return out;
}
function parseInvocation(rawInput) {
  const parts = splitArgs(rawInput);
  if (parts.length === 0) return { subcommand: "list", args: [] };
  return { subcommand: parts[0].toLowerCase(), args: parts.slice(1) };
}
function matchPaths(changes, args) {
  if (!args || args.length === 0) return [];
  const wanted = args.map((arg) => compareKey(arg.replace(/^\.?[\\/]/, "")));
  return changes.filter((change) => {
    const key = compareKey(change.path);
    const base = key.split(/[\\/]/).pop();
    return wanted.some((want) => want === key || want.indexOf("\\") < 0 && want.indexOf("/") < 0 && want === base);
  });
}
function staleShapeText(code) {
  if (code === "baseline-appeared") return "\xB7 \u771F\u5B9E\u6587\u4EF6\u5728\u6682\u5B58\u540E\u51FA\u73B0";
  if (code === "baseline-deleted") return "\xB7 \u771F\u5B9E\u6587\u4EF6\u88AB\u5916\u90E8\u5220\u9664";
  if (code === "baseline-drifted") return "\xB7 \u771F\u5B9E\u6587\u4EF6\u88AB\u5916\u90E8\u6539\u5199";
  return "";
}
function formatList(service, snapshot2) {
  const snap = snapshot2 ?? service.snapshot();
  if (!snap.pending) return "WinStage \u6682\u5B58\u533A\u6CA1\u6709\u5F85\u5BA1\u6539\u52A8\uFF08\u6539\u4E86\u6587\u4EF6\u4E4B\u540E\u4F1A\u81EA\u52A8\u51FA\u73B0\u5728\u8FD9\u91CC\uFF09";
  const lines = [
    `WinStage \u6682\u5B58\u5F85\u5BA1  ${snap.counts.files} \u4E2A\u6587\u4EF6  +${snap.counts.additions} / \u2212${snap.counts.deletions}`
  ];
  if (snap.counts.frozenOnly > 0) {
    lines.push(`  \u5176\u4E2D ${snap.counts.frozenOnly} \u4E2A\u5DF2\u4E0D\u5728\u5F53\u524D\u51C0 diff\uFF08\u4EC5\u5B58\u6863\uFF0C\u4E0D\u53EF\u6279\u51C6\uFF09`);
  }
  if ((snap.counts.staleBaseline ?? 0) > 0) {
    const lossy = snap.counts.staleBaselineLossy ?? 0;
    lines.push(
      `  \u5176\u4E2D ${snap.counts.staleBaseline} \u9879\u57FA\u7EBF\u5DF2\u8FC7\u671F\uFF08\u771F\u5B9E\u6587\u4EF6\u5728\u6682\u5B58\u4E4B\u540E\u88AB\u5916\u90E8\u6539\u52A8\u8FC7\uFF09\uFF1A\u76F4\u63A5\u6279\u51C6\u4F1A\u88AB\u62D2\u7EDD\uFF1B\u7528 /winstage rebase [\u8DEF\u5F84\u2026] \u4EE5\u771F\u5B9E\u6587\u4EF6\u4E3A\u57FA\u7EBF\u91CD\u65B0\u6682\u5B58\u3002`
    );
    if (lossy > 0) {
      lines.push(
        `  \u26A0 \u5176\u4E2D ${lossy} \u9879\u4F1A\u8986\u76D6\u771F\u5B9E\u78C1\u76D8\u4E0A**\u5DF2\u5B58\u5728**\u7684\u5185\u5BB9\uFF08\u771F\u5B9E\u6587\u4EF6\u4E0D\u662F\u7A7A\u57FA\u7EBF\uFF09\uFF1A\u6279\u51C6\u5DF2\u6309 STALE_BASELINE \u62D2\u7EDD\uFF0C\u5148 rebase \u770B\u6E05 before/after \u518D\u51B3\u5B9A\uFF0C\u6216 /winstage reject \u4E22\u5F03\u8FD9\u4EFD\u6682\u5B58\u3002`
      );
    }
  }
  for (const file of snap.files) {
    const frozen = file.frozenOnly === true ? "   [\u5DF2\u4E0D\u5728\u51C0 diff \xB7 \u4E0D\u53EF\u6279\u51C6]" : "";
    const stale = file.baselineStale === true ? `   [\u57FA\u7EBF\u5DF2\u8FC7\u671F${staleShapeText(file.baselineStaleCode)} \xB7 \u5148 rebase]` : "";
    lines.push(`  ${file.op.padEnd(7)} ${file.path}   +${file.totals.added} / \u2212${file.totals.removed}${frozen}${stale}`);
  }
  if (snap.truncated) {
    const total = snap.counts.files;
    const shown = snap.counts.listed ?? snap.files.length;
    const hidden = Math.max(0, total - shown);
    lines.push(hidden > 0 ? `  \u2026\uFF08\u5217\u8868\u5DF2\u622A\u65AD\uFF1A\u5171 ${total} \u9879\uFF0C\u5DF2\u663E\u793A ${shown} \u9879\uFF0C**\u8FD8\u6709 ${hidden} \u9879\u672A\u663E\u793A**\uFF1B\u7528 /winstage diff <\u8DEF\u5F84> \u6216\u6309\u8DEF\u5F84\u6279\u51C6\uFF09` : "  \u2026\uFF08\u5217\u8868\u5DF2\u622A\u65AD\uFF09");
  }
  lines.push(`\u5019\u9009 ${snap.candidateId ?? "(\u672A\u51BB\u7ED3)"} \xB7 \u5DE5\u4F5C\u533A ${snap.workspaceRoot}`);
  lines.push(
    "\u7528 /winstage diff <\u8DEF\u5F84> \u770B\u6539\u52A8\uFF1B/winstage approve [\u8DEF\u5F84\u2026] \u5199\u5165\u771F\u5B9E\u5DE5\u4F5C\u533A\uFF1B/winstage rebase [\u8DEF\u5F84\u2026] \u4EE5\u771F\u5B9E\u6587\u4EF6\u4E3A\u57FA\u7EBF\u91CD\u65B0\u6682\u5B58\uFF08\u57FA\u7EBF\u8FC7\u671F\u65F6\uFF09\uFF1B/winstage reject [\u8DEF\u5F84\u2026] \u9000\u56DE\u771F\u5B9E\u78C1\u76D8"
  );
  return lines.join("\n");
}
function formatDiff(service, args) {
  const ws = service.reload();
  const changes = ws.diffEntries();
  if (changes.length === 0) return "WinStage \u6682\u5B58\u533A\u6CA1\u6709\u5F85\u5BA1\u6539\u52A8";
  const wanted = args && args.length > 0 ? matchPaths(changes, args) : changes;
  if (wanted.length === 0) return `\u6CA1\u6709\u5339\u914D\u7684\u5F85\u5BA1\u8DEF\u5F84\uFF1A${args.join(" ")}`;
  const lines = [];
  for (const change of wanted) {
    lines.push(`--- ${change.op} ${change.path}`);
    for (const line of renderCandidateDiff(ws.store, { changes: [change] }, { maxLines: 120 })) {
      if (line.type === "add") lines.push(`+ ${line.text}`);
      else if (line.type === "remove") lines.push(`- ${line.text}`);
      else if (line.type === "note") lines.push(`  (${line.text})`);
    }
  }
  return lines.join("\n");
}
function storeHash(dir) {
  const text = typeof dir === "string" ? dir : "";
  if (text.length === 0) return null;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
function summarizeUnsettledApprovals(session) {
  const empty = { available: false, scanned: 0, unsettledCount: 0, unsettled: [] };
  if (!session || typeof session.eventAt !== "function") {
    return { ...empty, reason: "no-session" };
  }
  const seq = Number(session.seq);
  if (!Number.isFinite(seq) || seq <= 0) return { ...empty, available: true, reason: "no-events" };
  const open = /* @__PURE__ */ new Map();
  let scanned = 0;
  for (let i = 0; i < seq; i += 1) {
    let event;
    try {
      event = session.eventAt(i);
    } catch {
      break;
    }
    if (!event || typeof event !== "object") continue;
    scanned += 1;
    const id = event?.data?.id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (event.type === "approval/asked") {
      if (!open.has(id)) open.set(id, { id, reason: event?.data?.reason ?? null, toolName: event?.data?.toolName ?? null, seq: i });
    } else if (event.type === "approval/decided") {
      open.delete(id);
    }
  }
  const unsettled = [...open.values()].sort((a, b) => a.seq - b.seq);
  return { available: true, scanned, unsettledCount: unsettled.length, unsettled };
}
function summarizeUnpersistedWrites(manifestPath) {
  const empty = { available: false, count: 0, items: [], last: null };
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    return { ...empty, reason: "no-manifest-path" };
  }
  if (!existsSync3(manifestPath)) return { ...empty, available: true, reason: "no-manifest" };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync3(manifestPath, "utf8"));
  } catch (error) {
    return { ...empty, reason: `manifest-unreadable: ${error?.message ?? error}` };
  }
  const entries = manifest?.entries && typeof manifest.entries === "object" ? manifest.entries : {};
  const items = [];
  for (const [key, entry] of Object.entries(entries)) {
    const failure = entry?.persistenceFailure;
    if (!failure || typeof failure !== "object") continue;
    items.push({
      path: key,
      at: failure.at ?? null,
      hash: failure.hash ?? null,
      // `problems` 是**结构化检查项**（例如 `manifest-not-persisted`），不含路径片段
      problems: Array.isArray(failure.problems) ? failure.problems.map((p) => ({ check: p?.check ?? "unknown", detail: p?.detail ?? null })) : []
    });
  }
  items.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  return {
    available: true,
    count: items.length,
    items,
    last: items.length > 0 ? items[items.length - 1] : null,
    note: "\u53EA\u53CD\u6620**\u6E05\u5355\u91CC\u4ECD\u7136\u7559\u7740**\u7684\u672A\u786E\u8BA4\u5199\u5165\uFF08\u88AB\u540E\u7EED\u6210\u529F\u5199\u5165\u53D6\u4EE3\u540E\u8BE5\u8BB0\u8D26\u4F1A\u6D88\u5931\uFF09\uFF1B\u4E0D\u6784\u6210\u5386\u53F2\u5BA1\u8BA1\u3002"
  };
}
function summarizeReadVisibility(readVisibility) {
  const rv = readVisibility && typeof readVisibility === "object" ? readVisibility : void 0;
  if (!rv) return { available: false, policy: null, objects: 0, reads: 0, truncated: false, topMaskIds: [], note: null };
  const byMaskId = rv.byMaskId && typeof rv.byMaskId === "object" ? rv.byMaskId : {};
  const topMaskIds = Object.entries(byMaskId).map(([maskId, count]) => ({ maskId, count: Number(count) || 0 })).sort((a, b) => b.count - a.count || (a.maskId < b.maskId ? -1 : 1));
  return {
    available: true,
    policy: rv.policy ?? null,
    objects: Number(rv.objects) || 0,
    reads: Number(rv.reads) || 0,
    truncated: rv.truncated === true,
    topMaskIds,
    note: typeof rv.note === "string" ? rv.note : null
  };
}
function buildTrustCard(options = {}) {
  const service = options.service;
  const store = service?.workspace?.store;
  const dir = typeof store?.dir === "string" && store.dir.length > 0 ? store.dir : typeof options.storeDir === "string" && options.storeDir.length > 0 ? options.storeDir : void 0;
  const journal = readLaneJournalFile(dir);
  const record = journal.available ? journal.record ?? {} : void 0;
  const lane = summarizeLane(record ?? {});
  const history = summarizeLaneHistory(record);
  const tier = {
    /** 产物是否存在（= 有没有命令真的经过本执行器） */
    recorded: journal.available,
    recordedReason: journal.reason,
    at: record?.at ?? null,
    launchMode: lane.launchMode,
    tierEffective: lane.tierEffective,
    requestedTier: lane.requestedTier,
    winStageEnabled: lane.winStageEnabled,
    fallbackClass: lane.fallback,
    fallbackText: lane.fallbackText,
    fallbackReasonRaw: record?.fallbackReason ?? null,
    status: lane.status,
    degraded: lane.degraded,
    conclusion: lane.conclusion
  };
  const firstDegrade = {
    everDegraded: history.everDegraded,
    at: history.firstDegrade?.at ?? null,
    seq: history.firstDegrade?.seq ?? null,
    launchMode: history.firstDegrade?.launchMode ?? null,
    tierEffective: history.firstDegrade?.tierEffective ?? null,
    fallbackClass: history.firstDegrade?.fallbackClass ?? null,
    fallbackReason: history.firstDegrade?.fallbackReason ?? null,
    degradeCount: history.degradeCount,
    shimCount: history.shimCount,
    commandSeq: history.commandSeq
  };
  let live;
  if (store && typeof store.stageStatus === "function") {
    try {
      live = store.stageStatus();
    } catch (error) {
      live = { alive: false, reason: `status-threw: ${error?.message ?? error}` };
    }
  } else if (dir !== void 0) {
    live = verifyStageRootAlive(dir);
  }
  const checked = live !== void 0;
  const aliveNow = checked ? live.alive === true : null;
  const rootMissing = checked && live.alive !== true && (live.reason === "root-missing" || live.reason === "root-not-directory");
  const everCreated = journal.available || checked && !rootMissing;
  const lossRelevant = checked && aliveNow !== true && everCreated;
  let rootLoss = history.rootLoss;
  if (lossRelevant) {
    const entry = noteStageRootLoss(dir, { reason: live.reason ?? "not-alive", phase: "status" });
    if (entry) {
      rootLoss = {
        everLost: true,
        count: entry.count,
        lastReason: entry.lastReason,
        lastAt: entry.lastAt,
        lastPhase: entry.lastPhase,
        lastSeq: entry.lastSeq,
        observedAt: entry.observedAt
      };
    }
  }
  const stageRoot = {
    checked,
    alive: aliveNow,
    reason: live?.reason ?? null,
    /** `never-created` = 根还没建（不是故障）；其余取值即 `verifyStageRootAlive()` 的 reason */
    reasonCode: rootMissing && !everCreated ? "never-created" : live?.reason ?? null,
    guarded: live?.guarded ?? null,
    everCreated,
    lossRelevant,
    everLost: rootLoss?.everLost === true,
    lossCount: rootLoss?.count ?? 0,
    lastLossAt: rootLoss?.lastAt ?? null,
    lastLossReason: rootLoss?.lastReason ?? null,
    lastLossPhase: rootLoss?.lastPhase ?? null,
    lastLossSeq: rootLoss?.lastSeq ?? null,
    observedAt: Array.isArray(rootLoss?.observedAt) ? [...rootLoss.observedAt] : [],
    note: '\u5931\u6839\u6B21\u6570\u662F**\u88AB\u89C2\u6D4B\u5230**\u7684\u6B21\u6570\uFF08\u89C2\u6D4B\u70B9\uFF1A\u547D\u4EE4\u6267\u884C\u524D / \u7528\u6237\u67E5\u770B\u72B6\u6001\u65F6\uFF09\uFF0C\u4E0D\u662F\u5B8C\u6574\u5BA1\u8BA1\uFF1B"\u6839\u8FD8\u6CA1\u5EFA"\u4E0D\u7B97\u5931\u6839\u3002'
  };
  const approvals = summarizeUnsettledApprovals(options.session);
  const manifestPath = typeof store?.manifestPath === "string" && store.manifestPath.length > 0 ? store.manifestPath : dir ? join3(dir, "manifest.json") : void 0;
  const writes = summarizeUnpersistedWrites(manifestPath);
  const readVisibility = summarizeReadVisibility(options.snapshot?.readVisibility);
  const blockers = [];
  let level;
  if (stageRoot.lossRelevant) {
    level = "lost";
    blockers.push({ code: "stage-root-lost", detail: stageRoot.reason });
  } else if (tier.winStageEnabled !== false && tier.status === "degraded") {
    level = "degraded";
    blockers.push({ code: "lane-degraded", detail: tier.fallbackClass });
  } else if (writes.count > 0) {
    level = "write-unconfirmed";
    blockers.push({ code: "unpersisted-write", detail: writes.last?.path ?? null });
  } else if (tier.winStageEnabled === false) {
    level = "off";
    blockers.push({ code: "sandbox-off", detail: null });
  } else if (tier.status === "unknown") {
    level = "unknown";
    blockers.push({ code: tier.recorded ? "lane-unknown" : "lane-unrecorded", detail: tier.recordedReason });
  } else if (approvals.unsettledCount > 0 || readVisibility.reads > 0) {
    level = "attention";
    if (approvals.unsettledCount > 0) blockers.push({ code: "unsettled-approval", detail: approvals.unsettledCount });
    if (readVisibility.reads > 0) blockers.push({ code: "sensitive-reads", detail: readVisibility.reads });
  } else {
    level = "trusted";
  }
  const ok2 = level === "trusted" || level === "off" || level === "attention";
  const conclusion = level === "lost" ? `\u6C99\u7BB1\u6B64\u523B**\u4E0D\u53EF\u4FE1**\uFF1A\u4F1A\u8BDD\u5DE5\u4F5C\u6839\u5DF2\u4E0D\u53EF\u7528\uFF08${stageRoot.reason ?? "\u539F\u56E0\u672A\u77E5"}\uFF09\u2014\u2014\u5199\u5165\u4F1A\u4EE5 STAGE_ROOT_LOST \u5931\u8D25\uFF0C\u4E0D\u4F1A\u9759\u9ED8\u6539\u5199\u771F\u5B9E\u6587\u4EF6\u3002` : level === "degraded" ? `\u6C99\u7BB1\u6B64\u523B**\u4E0D\u53EF\u4FE1**\uFF1A\u6863\u4F4D\u56DE\u9000\u5230 ${tier.launchMode ?? "(\u672A\u62A5\u51FA)"}\uFF0C\u6CA1\u6709\u53BB\u4EE4\u724C\u5316\u901A\u9053 \u2014\u2014 \u5199\u5165\u53EA\u5269\u5185\u6838\u786C\u62D2\u3001\u547D\u4EE4\u4EA7\u51FA\u4E0D\u8FDB\u6682\u5B58\u3002` : level === "write-unconfirmed" ? `\u6C99\u7BB1\u6863\u4F4D\u6B63\u5E38\uFF0C\u4F46\u6709 ${writes.count} \u6B21\u5199\u5165**\u6CA1\u6709\u786E\u8BA4\u843D\u76D8**\uFF08\u6700\u8FD1\u4E00\u6B21\uFF1A${writes.last?.path ?? "\u672A\u77E5"}\uFF09\u2014\u2014\u90A3\u6B21\u5199\u5165\u4E0D\u5E94\u5F53\u6210\u5DF2\u5B8C\u6210\u3002` : level === "unknown" ? '\u6C99\u7BB1\u6863\u4F4D**\u672A\u77E5**\uFF1A\u672C\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u4E00\u6B21\u6863\u4F4D\u5224\u5B9A\u7ECF\u8FC7\u672C\u6267\u884C\u5668 \u2014\u2014 \u6309"\u672A\u8BC1\u5B9E\u5DF2\u751F\u6548"\u5BF9\u5F85\u3002' : level === "off" ? `\u6C99\u7BB1**\u5173\u95ED**\uFF08\u5C5E\u9884\u671F\uFF09\uFF1A\u6863\u4F4D=${tier.launchMode ?? "(\u672A\u62A5\u51FA)"}\uFF0C\u672C\u6267\u884C\u5668\u4E0D\u63A5\u7BA1\u6682\u5B58\u9762\uFF0C\u6B64\u5F62\u6001\u4EC5\u4F5C\u8BB0\u5F55\u3002` : level === "attention" ? `\u6C99\u7BB1\u6863\u4F4D\u6B63\u5E38\uFF08\u5DF2\u751F\u6548\uFF09\uFF0C\u4F46\u6709 ${blockers.length} \u7C7B**\u5F85\u5904\u7406\u4E8B\u9879**\uFF1A${blockers.map((b) => b.code).join("\u3001")}\u3002` : "\u6C99\u7BB1\u6B64\u523B**\u53EF\u4FE1**\uFF1A\u547D\u4EE4\u8D70\u53BB\u4EE4\u724C\u5316\u901A\u9053\uFF0C\u6587\u4EF6/\u6CE8\u518C\u8868\u5199\u5165\u5148\u843D\u6682\u5B58\u3001\u6279\u51C6\u540E\u624D\u5199\u771F\u5B9E\u78C1\u76D8\u3002";
  return {
    kind: "winstage-trust-card",
    version: 1,
    at: typeof options.now === "string" ? options.now : (/* @__PURE__ */ new Date()).toISOString(),
    /** 存储根的**短哈希**（关联用；**不是**路径 —— 路径绝不进卡片） */
    storeHash: storeHash(dir),
    storeLabel: dir ? "\u4F1A\u8BDD\u5DE5\u4F5C\u6839\uFF08Windows \u7F13\u5B58\uFF09" : "\uFF08\u65E0\u4F1A\u8BDD\u5B58\u50A8\u6839\uFF09",
    tier,
    firstDegrade,
    stageRoot,
    approvals,
    writes,
    readVisibility,
    trust: { level, ok: ok2, blockers },
    conclusion
  };
}
function formatTierLines(card) {
  const { tier, firstDegrade } = card;
  const lines = ["\u3010\u6C99\u7BB1\u6863\u4F4D\u4E0E\u964D\u7EA7\u544A\u8B66\u3011"];
  if (!tier.recorded) {
    lines.push(`  \xB7 \u6CA1\u6709\u6863\u4F4D\u5224\u5B9A\u8BB0\u5F55\uFF08${tier.recordedReason}\uFF09`);
    lines.push(
      "  \xB7 \u7ED3\u8BBA\uFF1A**\u5C1A\u672A\u8BC1\u5B9E\u6C99\u7BB1\u771F\u7684\u751F\u6548**\uFF08\u6863\u4F4D\u5224\u5B9A\u53EA\u5728\u547D\u4EE4\u6267\u884C\u65F6\u4EA7\u751F\uFF09\u3002\u8DD1\u4E00\u6761 pwsh \u547D\u4EE4\uFF08\u4F8B\u5982 `node -v`\uFF09\u540E\u518D\u770B\u8FD9\u91CC\uFF1B\u82E5\u90A3\u65F6\u4ECD\u65E0\u8BB0\u5F55\uFF0C\u8BF4\u660E\u547D\u4EE4\u6CA1\u6709\u7ECF\u8FC7 WinStage \u6267\u884C\u5668\u3002"
    );
    return lines;
  }
  lines.push(`  \xB7 \u6700\u8FD1\u4E00\u6B21\u5224\u5B9A\uFF1A${tier.at ?? "\uFF08\u65E0\u65F6\u95F4\u6233\uFF09"}`);
  lines.push(
    `  \xB7 lane\uFF08launchMode\uFF09= ${tier.launchMode ?? "\uFF08\u672A\u62A5\u51FA\uFF09"}\uFF1BtierEffective = ${tier.tierEffective ?? "\uFF08\u672A\u62A5\u51FA\uFF09"}\uFF1B\u8BF7\u6C42\u6863\u4F4D = ${tier.requestedTier ?? "\uFF08\u672A\u62A5\u51FA\uFF09"}\uFF1BWinStage \u5F00\u5173 = ${tier.winStageEnabled ? "\u5F00" : "\u5173"}`
  );
  lines.push(`  \xB7 \u56DE\u9000\u5206\u7C7B = ${tier.fallbackClass}${tier.fallbackText ? ` \u2014 ${tier.fallbackText}` : ""}`);
  lines.push(`  \xB7 \u539F\u59CB fallbackReason = ${tier.fallbackReasonRaw ?? "\uFF08\u65E0\uFF09"}`);
  lines.push(`  \xB7 \u7ED3\u8BBA\uFF1A${tier.conclusion}`);
  lines.push(
    firstDegrade.everDegraded ? `  \xB7 \u9996\u6B21\u6389\u6863\uFF1A${firstDegrade.at ?? "\uFF08\u65E0\u65F6\u95F4\u6233\uFF09"}\uFF08\u7B2C ${firstDegrade.seq ?? "?"} \u6761\u547D\u4EE4\uFF09\uFF0ClaunchMode=${firstDegrade.launchMode ?? "?"}\uFF0C\u5206\u7C7B=${firstDegrade.fallbackClass ?? "?"}\uFF1B\u672C\u4F1A\u8BDD\u7D2F\u8BA1\u6389\u6863 ${firstDegrade.degradeCount} \u6B21 / \u6B63\u5E38 ${firstDegrade.shimCount} \u6B21\uFF08\u5171 ${firstDegrade.commandSeq ?? "?"} \u6B21\u5224\u5B9A\uFF09` : `  \xB7 \u9996\u6B21\u6389\u6863\uFF1A**\u6CA1\u6709\u6389\u8FC7\u6863**\uFF08\u672C\u4F1A\u8BDD ${firstDegrade.commandSeq ?? "?"} \u6B21\u5224\u5B9A\u5168\u90E8\u8D70 shim \u901A\u9053\uFF09`
  );
  if (tier.status === "degraded") {
    lines.push(
      '  \xB7 \u5904\u7F6E\uFF1A\u2460 \u67E5 shim \u4EA7\u7269\u662F\u5426\u9F50\u5907\uFF08DLL / winstage-inject.exe / winstage-probe.exe\uFF09\uFF1B\u2461 \u67E5\u63A2\u6D4B\u8BC1\u636E\uFF08\u6682\u5B58\u6839\u4E0B\u7684 shim.log \u4E0E\u80FD\u529B\u63A2\u6D4B\u8F93\u51FA\uFF09\uFF1B\u2462 \u5728\u4FEE\u597D\u4E4B\u524D\uFF0C\u672C\u7A97\u53E3\u7684\u5199\u5165\u7ED3\u679C\u6309"\u53EF\u80FD\u53EA\u5269\u5185\u6838\u786C\u62D2"\u5BF9\u5F85\uFF0C**\u4E0D\u8981**\u5F53\u6210\u6C99\u7BB1\u5185\u6210\u529F\u3002'
    );
  }
  return lines;
}
function formatTrustCard(card) {
  const { tier, firstDegrade, stageRoot, approvals, writes, readVisibility, trust } = card;
  const lines = [`\u3010WinStage \u53EF\u4FE1\u6027\u72B6\u6001\u5361\u3011 \u751F\u6210\u4E8E ${card.at}`];
  lines.push(`  \u7ED3\u8BBA\uFF1A${card.conclusion}`);
  lines.push(
    `  \u673A\u8BFB\uFF1Alevel=${trust.level} ok=${trust.ok} \u2026store=${card.storeHash ?? "(none)"} markers=${trust.blockers.map((b) => b.code).join(",") || "(none)"}`
  );
  lines.push("");
  lines.push("\u2460 \u6863\u4F4D");
  for (const line of formatTierLines(card).slice(1)) lines.push(line);
  lines.push("");
  lines.push("\u2461 \u9996\u6B21\u6389\u6863 / \u662F\u5426\u66FE\u6389\u6863");
  lines.push(
    `  \xB7 \u662F\u5426\u66FE\u6389\u6863 = ${firstDegrade.everDegraded ? "\u662F" : "\u5426"}\uFF1B\u9996\u6B21 = ${firstDegrade.at ?? "\uFF08\u65E0\uFF09"}\uFF1B\u547D\u4EE4\u5E8F\u53F7 = ${firstDegrade.seq ?? "\uFF08\u65E0\uFF09"}\uFF1B\u539F\u56E0\u5206\u7C7B = ${firstDegrade.fallbackClass ?? "\uFF08\u65E0\uFF09"}`
  );
  lines.push(`  \xB7 \u8BA1\u6570\uFF1A\u6389\u6863 ${firstDegrade.degradeCount} \u6B21 / \u8D70 shim ${firstDegrade.shimCount} \u6B21\uFF08\u5224\u5B9A\u603B\u6570 ${firstDegrade.commandSeq ?? 0}\uFF09`);
  if (firstDegrade.fallbackReason) lines.push(`  \xB7 \u9996\u6B21\u539F\u56E0\u539F\u6587 = ${firstDegrade.fallbackReason}`);
  lines.push("");
  lines.push("\u2462 \u5931\u6839");
  lines.push(
    `  \xB7 \u6B64\u523B = ${!stageRoot.checked ? "\uFF08\u672A\u68C0\u67E5\uFF1A\u6CA1\u6709\u4F1A\u8BDD\u5B58\u50A8\u6839\uFF09" : stageRoot.alive ? "\u5B58\u6D3B" : stageRoot.reasonCode === "never-created" ? "\u5C1A\u672A\u5EFA\u7ACB\uFF08\u672C\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u8FC7\u6682\u5B58\u5199\u5165 \u2014\u2014 **\u4E0D\u662F**\u6545\u969C\uFF09" : `**\u4E0D\u53EF\u7528**\uFF08${stageRoot.reason}\uFF09`}\uFF1B\u662F\u5426\u53D1\u751F\u8FC7 = ${stageRoot.everLost ? "\u662F" : "\u5426"}\uFF1B\u6B21\u6570 = ${stageRoot.lossCount}`
  );
  if (stageRoot.everLost) {
    lines.push(`  \xB7 \u6700\u8FD1\u4E00\u6B21\uFF1A${stageRoot.lastLossAt ?? "\uFF08\u65E0\u65F6\u95F4\u6233\uFF09"}\uFF08${stageRoot.lastLossReason ?? "\u539F\u56E0\u672A\u77E5"}\uFF0C\u89C2\u6D4B\u70B9=${stageRoot.lastLossPhase ?? "?"}\uFF0C\u547D\u4EE4\u5E8F\u53F7=${stageRoot.lastLossSeq ?? "?"}\uFF09`);
  }
  lines.push(`  \xB7 \u53E3\u5F84\uFF1A${stageRoot.note}`);
  lines.push("");
  lines.push("\u2463 \u672A\u7ED3\u7B97\u5BA1\u6279");
  lines.push(
    approvals.available ? `  \xB7 \u6709 ${approvals.unsettledCount} \u9879 \`approval/asked\` \u6CA1\u6709\u5E94\u7B54\uFF08\u626B\u8FC7 ${approvals.scanned} \u6761\u4F1A\u8BDD\u4E8B\u4EF6\uFF09${approvals.unsettledCount > 0 ? "\uFF1A\u4F1A\u8BDD\u53EF\u80FD\u6B63\u5361\u5728\u7B49\u5F85\u51B3\u7B56\u4E0A" : ""}` : `  \xB7 \u8BFB\u4E0D\u5230\u4F1A\u8BDD\u4E8B\u4EF6\uFF08${approvals.reason ?? "unknown"}\uFF09\u2014\u2014\u8FD9\u4E00\u9762**\u672A\u77E5**\uFF0C\u4E0D\u662F"\u6CA1\u6709"\u3002`
  );
  for (const item of approvals.unsettled.slice(0, 5)) {
    lines.push(`    \xB7 ${item.id}${item.reason ? ` \u2014 ${item.reason}` : ""}`);
  }
  lines.push("");
  lines.push("\u2464 \u672A\u786E\u8BA4\u5199\u5165\uFF08staging_write_not_persisted\uFF09");
  lines.push(
    writes.available ? `  \xB7 \u6E05\u5355\u91CC\u8FD8\u7559\u7740 ${writes.count} \u6761\u672A\u786E\u8BA4\u5199\u5165${writes.last ? `\uFF1A\u6700\u8FD1 ${writes.last.at ?? "\uFF08\u65E0\u65F6\u95F4\u6233\uFF09"} \u7684 ${writes.last.path}` : ""}` : `  \xB7 \u8BFB\u4E0D\u5230\u6E05\u5355\uFF08${writes.reason ?? "unknown"}\uFF09\u2014\u2014\u8FD9\u4E00\u9762**\u672A\u77E5**\uFF0C\u4E0D\u662F"\u6CA1\u6709"\u3002`
  );
  if (writes.last?.problems?.length) {
    lines.push(`    \xB7 \u68C0\u67E5\u9879\uFF1A${writes.last.problems.map((p) => p.check).join("\u3001")}`);
  }
  if (writes.available) lines.push(`  \xB7 \u53E3\u5F84\uFF1A${writes.note}`);
  lines.push("");
  lines.push("\u2465 \u8BFB\u4FA7\u53EF\u89C1\u6027");
  lines.push(
    readVisibility.available ? `  \xB7 \u7B56\u7565=${readVisibility.policy ?? "?"}\uFF1B\u53BB\u91CD\u5BF9\u8C61 ${readVisibility.objects} \u4E2A\uFF1B\u8BFB\u53D6 ${readVisibility.reads} \u6B21${readVisibility.truncated ? "\uFF08\u5DF2\u8FBE\u6761\u76EE\u4E0A\u9650\uFF0C\u8BA1\u6570\u53EA\u7D2F\u8BA1\u4E0D\u518D\u65B0\u589E\uFF09" : ""}${readVisibility.topMaskIds.length > 0 ? `\uFF1B\u6309\u7C7B\uFF1A${readVisibility.topMaskIds.map((x) => `${x.maskId}\xD7${x.count}`).join("\u3001")}` : ""}` : '  \xB7 \u8FD8\u6CA1\u6709\u5DF2\u53D1\u5E03\u7684\u5FEB\u7167\uFF0C\u8FD9\u4E00\u9762\u6682\u65E0\u6570\u636E\uFF08**\u4E0D\u662F**"\u6CA1\u6709\u654F\u611F\u8BFB"\uFF09\u3002'
  );
  lines.push("");
  lines.push("  \u8BF4\u660E\uFF1A\u672C\u5361\u7247\u53EA\u8D70**\u7528\u6237\u4FA7**\u901A\u9053\uFF08/winstage status \u6587\u672C\u3001\u9762\u677F\uFF09\uFF1B\u547D\u4EE4\u81EA\u8EAB\u7684 stdout/stderr \u4E0E\u5DE5\u5177\u8F93\u51FA**\u9010\u5B57\u8282\u4E0D\u53D8**\uFF0C\u4E0D\u542B\u672C\u5361\u4EFB\u4F55\u5185\u5BB9\u3002");
  return lines.join("\n");
}
var PANEL_ROUTE_PREFIX = "/winstage-panel";
var PANEL_SNAPSHOT_PATH = `${PANEL_ROUTE_PREFIX}/snapshot`;
var PANEL_TRUST_PATH = `${PANEL_ROUTE_PREFIX}/trust`;
function panelStoreIdentity(dir, sessionId) {
  const scope = typeof sessionId === "string" && sessionId.trim().length > 0 ? "session" : "shared";
  return { scope, label: scope === "session" ? "\u4F1A\u8BDD\u5DE5\u4F5C\u6839\uFF08Windows \u7F13\u5B58\uFF09" : "\u5171\u4EAB\u5DE5\u4F5C\u6839\uFF08Windows \u7F13\u5B58\uFF09", hash: storeHash(dir) };
}
function panelStoreDir({ workspaceRoot, sessionId, env } = {}) {
  return resolveReviewStoreDir({ workspaceRoot, sessionId, env });
}
function readPublishedSnapshot({ workspaceRoot, sessionId, env } = {}) {
  const dir = panelStoreDir({ workspaceRoot, sessionId, env });
  const file = join3(dir, REVIEW_BASENAME);
  if (!existsSync3(file)) return { ok: false, code: "no-snapshot", dir };
  try {
    return { ok: true, dir, snapshot: JSON.parse(readFileSync3(file, "utf8")) };
  } catch (error) {
    return { ok: false, code: "snapshot-unreadable", dir, detail: String(error?.message ?? error) };
  }
}
function panelStagingFaces({ configEnabled, env = process.env, snapshot: snapshot2 } = {}) {
  const snap = snapshot2 && typeof snapshot2.staging === "object" && snapshot2.staging !== null ? snapshot2.staging : null;
  const configValue = configEnabled === true;
  const effective = snap && typeof snap.effective === "boolean" ? snap.effective : configValue;
  const raw = env && env.WINSTAGE_SHELL !== void 0 && env.WINSTAGE_SHELL !== null ? String(env.WINSTAGE_SHELL) : null;
  const forced = raw === "1" || raw === "0";
  const shellOverride = raw === null ? null : {
    value: raw,
    forced,
    text: raw === "1" ? "WINSTAGE_SHELL=1\uFF08\u5F3A\u5236 WinStage \u63A5\u7BA1\uFF09" : raw === "0" ? "WINSTAGE_SHELL=0\uFF08\u5F3A\u5236\u4EA4\u8FD8\u5E73\u53F0 shell\uFF09" : `WINSTAGE_SHELL=${raw}`
  };
  const shellFace = forced ? raw === "1" ? "win-stage" : "platform" : configValue ? "win-stage" : "platform";
  return {
    effective,
    configValue,
    source: snap && typeof snap.source === "string" ? snap.source : "config",
    shellOverride,
    mismatch: snap && snap.mismatch && typeof snap.mismatch === "object" ? snap.mismatch : null,
    faces: {
      file: effective === true ? "on" : "off",
      shell: shellFace,
      shellForcedByEnv: forced
    }
  };
}
function buildPanelPayload({ pathname, query, workspaceRoot, sessionId, env, isEnabled = () => true, session, now } = {}) {
  const read = (key) => {
    if (query instanceof Map) return query.get(key) ?? void 0;
    if (query && typeof query.get === "function") return query.get(key) ?? void 0;
    return void 0;
  };
  if (pathname !== PANEL_SNAPSHOT_PATH && pathname !== PANEL_TRUST_PATH) {
    return { status: 404, body: { ok: false, code: "unknown-route", route: pathname } };
  }
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    if (!isEnabled()) {
      return {
        status: 503,
        body: { ok: false, code: "disabled", route: pathname, staging: panelStagingFaces({ configEnabled: false, env }) }
      };
    }
    return { status: 500, body: { ok: false, code: "no-workspace-root", route: pathname } };
  }
  const sid = read("session");
  let enabled = isEnabled();
  let probeSnapshot = null;
  if (!enabled) {
    try {
      const probe = readPublishedSnapshot({ workspaceRoot, sessionId: sid, env });
      if (probe.ok && probe.snapshot) {
        probeSnapshot = probe.snapshot;
        if (probe.snapshot.staging && probe.snapshot.staging.effective === true) {
          enabled = true;
        }
      }
    } catch {
    }
  }
  if (!enabled) {
    return {
      status: 503,
      body: {
        ok: false,
        code: "disabled",
        route: pathname,
        staging: panelStagingFaces({ configEnabled: false, env, snapshot: probeSnapshot })
      }
    };
  }
  const published = readPublishedSnapshot({ workspaceRoot, sessionId: sid, env });
  const store = panelStoreIdentity(published.dir, sid);
  if (pathname === PANEL_SNAPSHOT_PATH) {
    if (!published.ok) {
      return { status: published.code === "no-snapshot" ? 404 : 500, body: { ok: false, code: published.code, store, detail: published.detail } };
    }
    return { status: 200, body: { ok: true, store, snapshot: published.snapshot, source: "host-route" } };
  }
  const card = buildTrustCard({
    service: void 0,
    // 面板侧**不实例化审阅服务**（那会建目录、触发认领/自愈），所以把宿主解析出的
    // 存储根**显式**交给状态卡：①②③⑤ 四个面照样齐 —— 面板看到的与 `/winstage status`
    // 是同一份判据、同一份数据。
    storeDir: published.dir,
    session,
    // 面⑥要靠已发布快照（这里**不**写盘）
    snapshot: published.ok ? published.snapshot : void 0,
    now
  });
  return { status: 200, body: { ok: true, store, card, source: "host-route" } };
}
function createPanelHandler(options = {}) {
  const isEnabled = typeof options.isEnabled === "function" ? options.isEnabled : () => true;
  const log = typeof options.log === "function" ? options.log : () => {
  };
  return async function winStagePanelHandler(req, res) {
    let url;
    try {
      url = new URL(String(req?.url ?? "/"), "http://localhost");
    } catch {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, code: "bad-url" }));
      return;
    }
    let session;
    try {
      session = typeof options.sessionOf === "function" ? options.sessionOf() : void 0;
    } catch {
      session = void 0;
    }
    const payload = buildPanelPayload({
      pathname: url.pathname,
      query: url.searchParams,
      workspaceRoot: options.workspaceRoot,
      sessionId: url.searchParams.get("session") ?? void 0,
      env: options.env,
      isEnabled,
      session
    });
    try {
      res.writeHead(payload.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(payload.body));
    } catch (error) {
      log(`\u9762\u677F\u8DEF\u7531\u5199\u54CD\u5E94\u5931\u8D25\uFF1A${error?.message ?? error}`);
    }
  };
}
function registerCommands(scope, serviceOrResolver, log, options = {}) {
  const isEnabled = typeof options.isEnabled === "function" ? options.isEnabled : () => true;
  const serviceOf = typeof serviceOrResolver === "function" ? serviceOrResolver : () => serviceOrResolver;
  const DISABLED_TEXT = "WinStage \u6C99\u7BB1\u5DF2\u5728\u8BBE\u7F6E\u4E2D\u5173\u95ED\uFF1A\u6682\u5B58\u4E0E\u5BA1\u9605\u9762\u672A\u63A5\u7BA1\uFF08\u5199\u5165\u8D70\u5E73\u53F0\u6C99\u7BB1/\u5BA1\u6279\u6A21\u5F0F\uFF09\uFF0C\u547D\u4EE4\u4E0D\u4F1A\u6267\u884C\u3002";
  const handlers = {
    list({ service }) {
      return { kind: "success", text: formatList(service) };
    },
    /**
     * `/winstage status`（含 `winstage-status`）：暂存清单 + **WP3 可信性状态卡**。
     *
     * 状态卡把六个面合并成一张（档位 / 首次掉档 / 失根 / 未结算审批 / 未确认写入 /
     * 读侧可见性），机读字段与人读结论同源。**只在用户侧**：命令文本 + 面板路由；
     * 命令自身的 stdout/stderr 与工具输出一个字节都不变（下面的 `text` 只回到命令面）。
     */
    status(context) {
      const service = context?.service;
      let snapshot2;
      if (service && typeof service.snapshot === "function") {
        try {
          snapshot2 = service.snapshot();
        } catch (error) {
          return { kind: "error", text: `\u8BFB\u53D6\u6682\u5B58\u5FEB\u7167\u5931\u8D25\uFF1A${error?.message ?? error}` };
        }
      }
      const listed = snapshot2 ? { kind: "success", text: formatList(service, snapshot2) } : handlers.list(context);
      const card = buildTrustCard({
        service,
        // 面④要读会话事件（`approval/asked` 有没有配对）。命令面拿得到 agent/session，
        // 拿不到就如实标"未知"——**不猜**。
        session: context?.invocation?.agent?.session,
        snapshot: snapshot2
      });
      const alarming = card.trust.level === "lost" || card.trust.level === "degraded";
      return {
        kind: alarming ? "error" : listed.kind,
        text: `${listed.text}

${formatTrustCard(card)}`
      };
    },
    refresh({ service }) {
      const snapshot2 = service.publish();
      return { kind: "success", text: `\u5DF2\u5237\u65B0\u5BA1\u9605\u5FEB\u7167\uFF1A${snapshot2.counts.files} \u4E2A\u5F85\u5BA1\u6587\u4EF6` };
    },
    rebase({ args, service }) {
      const result = service.rebase(args.length > 0 ? args : void 0);
      const lines = [result.message];
      for (const path of result.rebased) lines.push(`  \u21BB ${path}`);
      if (result.rebased.length > 0) lines.push(`  \u73B0\u5728\u53EF\u6279\u51C6 ${result.remaining} \u9879\uFF08/winstage list \u67E5\u770B\uFF09`);
      const failures = Array.isArray(result.failures) ? result.failures : [];
      if (failures.length > 0) {
        lines.push(`  \u26A0 \u6709 ${failures.length} \u9879\u6E05\u7406\u5931\u8D25\uFF08\u6CA1\u6E05\u5E72\u51C0\uFF09\uFF1A`);
        for (const failure of failures) {
          lines.push(`    \xB7 ${failure.path ?? failure.candidateId ?? "?"}: ${failure.code} \u2014 ${failure.message}`);
        }
        return { kind: "error", text: lines.join("\n") };
      }
      return { kind: "success", text: lines.join("\n") };
    },
    diff({ args, service }) {
      return { kind: "success", text: formatDiff(service, args) };
    },
    approve({ args, service }) {
      const flags = new Set(args.filter((arg) => arg.startsWith("--")));
      const names = args.filter((arg) => !arg.startsWith("--"));
      const unknown2 = [...flags].filter((flag) => flag !== "--rebase" && flag !== "--force" && flag !== "--confirm-mask");
      if (unknown2.length > 0) {
        return { kind: "error", text: `\u672A\u77E5\u5F00\u5173\uFF1A${unknown2.join(" ")}\uFF1B\u53EF\u7528\uFF1A--rebase\u3001--force\u3001--confirm-mask` };
      }
      const ws = service.reload();
      const changes = ws.diffEntries();
      if (changes.length === 0) {
        const live = typeof ws.listReviews === "function" ? ws.listReviews() : [];
        const frozen = live.reduce((n, c) => n + (c.changes || []).length, 0);
        if (live.length > 0) {
          return {
            kind: "error",
            text: `\u6CA1\u6709\u53EF\u6279\u51C6\u7684\u51C0\u53D8\u5316\uFF1A\u961F\u5217\u91CC\u8FD8\u6709 ${live.length} \u4EFD\u5019\u9009\uFF08\u5171 ${frozen} \u6761\u51BB\u7ED3\u8DEF\u5F84\uFF09\u5DF2\u4E0D\u5728\u51C0 diff\uFF0C\u5C5E"\u4EC5\u5B58\u6863\u3001\u4E0D\u53EF\u6279\u51C6"\u3002\u7528 /winstage reject \u6E05\u9664\u5B83\u4EEC\uFF0C\u6216 /winstage rebase \u91CD\u65B0\u5BF9\u9F50\u57FA\u7EBF\u3002`
          };
        }
        return { kind: "success", text: "\u6CA1\u6709\u5F85\u5BA1\u6587\u4EF6" };
      }
      const paths = names.length > 0 ? matchPaths(changes, names).map((c) => c.path) : void 0;
      if (names.length > 0 && paths.length === 0) {
        return { kind: "error", text: `\u6CA1\u6709\u5339\u914D\u7684\u5F85\u5BA1\u8DEF\u5F84\uFF1A${names.join(" ")}` };
      }
      const result = service.approve(paths, {
        rebase: flags.has("--rebase"),
        force: flags.has("--force"),
        // `--confirm-mask` = 用户已经看到过后果并确认。给了路径就确认这些路径；
        // "批准全部"没给路径 ⇒ `true`（确认本次全部遮蔽项）。
        ...flags.has("--confirm-mask") ? { confirmedMasks: paths && paths.length > 0 ? paths : true } : {}
      });
      const lines = [result.message];
      if (result.rebased?.length) lines.push(`  \u5DF2\u5148\u4EE5\u771F\u5B9E\u6587\u4EF6\u4E3A\u57FA\u7EBF\u91CD\u65B0\u6682\u5B58\uFF1A${result.rebased.join(", ")}`);
      const clearFailures = Array.isArray(result.failures) ? result.failures : [];
      if (clearFailures.length > 0) {
        lines.push(`  \u26A0 \u6709 ${clearFailures.length} \u9879\u6E05\u7406\u5931\u8D25\uFF08\u6CA1\u6E05\u5E72\u51C0\uFF09\uFF1A`);
        for (const failure of clearFailures) {
          lines.push(`    \xB7 ${failure.path ?? failure.candidateId ?? "?"}: ${failure.code} \u2014 ${failure.message}`);
        }
      }
      for (const failure of result.failed) {
        lines.push(`  \u2717 ${failure.path}: ${failure.code} \u2014 ${failure.message}`);
      }
      if (result.remaining?.length) lines.push(`  \u4ECD\u5728\u5F85\u5BA1\uFF1A${result.remaining.join(", ")}`);
      if (result.failed.some((f) => f.code === "STALE_BASELINE")) {
        lines.push("  \u8BF4\u660E\uFF1A\u771F\u5B9E\u6587\u4EF6\u5728\u6682\u5B58\u4E4B\u540E\u88AB\u5916\u90E8\u6539\u52A8\u8FC7\uFF0C\u56E0\u6B64\u9ED8\u8BA4\u62D2\u7EDD\u8986\u76D6\uFF08\u624B\u518C #12.1\uFF09\u3002");
        const shapes = [...new Set(result.failed.filter((f) => f.code === "STALE_BASELINE").map((f) => staleShapeText(f.baselineStaleCode ?? f.driftReason)))].filter((text) => text.length > 0);
        if (shapes.length > 0) lines.push(`  \u5F62\u72B6\uFF1A${shapes.join("\uFF1B")}\u3002\u771F\u5B9E\u78C1\u76D8\u4E0A\u7684\u90A3\u4EFD\u5185\u5BB9**\u6CA1\u6709\u88AB\u8986\u76D6**\u3002`);
        lines.push("  \u5904\u7406\uFF1A/winstage rebase [\u8DEF\u5F84\u2026] \u4EE5\u771F\u5B9E\u6587\u4EF6\u4E3A\u57FA\u7EBF\u91CD\u65B0\u6682\u5B58\uFF08\u4E4B\u540E\u9762\u677F\u4F1A\u663E\u793A before/after\uFF0C\u4F60\u786E\u8BA4\u7684\u5C31\u662F\u5C06\u8981\u66FF\u6362\u7684\u5185\u5BB9\uFF09\uFF1B\u6216 /winstage approve --rebase [\u8DEF\u5F84\u2026] \u4E00\u6B65\u5B8C\u6210\uFF1B\u4E0D\u60F3\u8981\u8FD9\u4EFD\u6682\u5B58\u5C31 /winstage reject [\u8DEF\u5F84\u2026]\u3002");
      }
      if (result.approved === 0 && result.failed.length === 0) {
        lines.push("  \u6CA1\u6709\u6761\u76EE\u88AB\u5E94\u7528\uFF1A\u9009\u4E2D\u7684\u8DEF\u5F84\u4E0D\u5728\u6700\u65B0\u5019\u9009\u91CC\uFF08\u53EF\u80FD\u5DF2\u88AB\u540E\u6765\u7684\u5199\u5165\u53D6\u4EE3\uFF09\u3002");
        lines.push("  \u5904\u7406\uFF1A/winstage refresh \u91CD\u65B0\u53D1\u5E03\u5FEB\u7167\u540E\u91CD\u8BD5\u3002");
        return { kind: "error", text: lines.join("\n") };
      }
      if (clearFailures.length > 0) return { kind: "error", text: lines.join("\n") };
      const needConfirm = result.failed.filter((f) => f.code === "SANDBOX_PATH_MASKED_CONFIRM");
      if (needConfirm.length > 0) {
        lines.push("  \u9700\u8981\u4E8C\u6B21\u786E\u8BA4\uFF08\u672C\u6B21**\u672A**\u5199\u5165\uFF09\uFF1A\u4EE5\u4E0B\u8DEF\u5F84\u547D\u4E2D\u654F\u611F\u7B56\u7565\uFF0C\u6279\u51C6\u4F1A\u628A\u6682\u5B58\u5185\u5BB9\u5199\u5230\u771F\u5B9E\u78C1\u76D8\u4E14\u4E0D\u53EF\u64A4\u9500\u3002");
        for (const failure of needConfirm) {
          lines.push(`    \xB7 ${failure.path} \u2014 ${failure.message}${failure.hard ? "\uFF3B\u6C99\u7BB1\u81EA\u8EAB\u5B58\u50A8\xB7\u5F3A\u8B66\u544A\uFF3D" : ""}`);
        }
        lines.push(
          `  \u786E\u8BA4\u540E\u91CD\u53D1\uFF1A/winstage approve --confirm-mask ${needConfirm.map((f) => `"${f.path}"`).join(" ")}`
        );
      }
      return { kind: result.ok ? "success" : "error", text: lines.join("\n") };
    },
    reject({ args, service }) {
      const ws = service.reload();
      const changes = ws.diffEntries();
      const live = typeof ws.listReviews === "function" ? ws.listReviews() : [];
      if (changes.length === 0 && live.length === 0) return { kind: "success", text: "\u6CA1\u6709\u5F85\u5BA1\u6587\u4EF6" };
      const paths = args.length > 0 ? matchPaths(changes, args).map((c) => c.path) : void 0;
      if (args.length > 0 && paths.length === 0) {
        return {
          kind: "error",
          text: `\u6CA1\u6709\u5339\u914D\u7684\u5F85\u5BA1\u8DEF\u5F84\uFF1A${args.join(" ")}\uFF08\u82E5\u5B83\u53EA\u662F"\u4EC5\u5B58\u6863\u884C"\uFF0C\u8BF7\u7528\u4E0D\u5E26\u8DEF\u5F84\u7684 /winstage reject \u6E05\u9664\uFF09`
        };
      }
      const result = service.reject(paths);
      const discarded = Array.isArray(result.discarded) ? result.discarded : [];
      const clearFailures = Array.isArray(result.failures) ? result.failures : [];
      if (result.rejected === 0 && discarded.length === 0 && clearFailures.length === 0) {
        return {
          kind: "error",
          text: `\u6CA1\u6709\u4EFB\u4F55\u6761\u76EE\u88AB\u6E05\u6389\uFF1A${result.message ?? "\u6240\u9009\u8DEF\u5F84\u65E2\u4E0D\u5728\u51C0 diff\u3001\u4E5F\u6CA1\u6709\u5BF9\u5E94\u7684\u6D3B\u5019\u9009\u3002"}`
        };
      }
      const lines = [
        `\u5DF2\u9000\u56DE ${result.rejected} \u4E2A\u6587\u4EF6\uFF1A${result.paths.join(", ") || "\uFF08\u65E0\u51C0 diff \u6761\u76EE\uFF09"}${discarded.length > 0 ? `\uFF1B\u5DF2\u7EC8\u7ED3 ${discarded.length} \u4E2A\u5019\u9009` : ""}\uFF08\u771F\u5B9E\u5DE5\u4F5C\u533A\u672A\u88AB\u6539\u52A8\uFF09`
      ];
      if (clearFailures.length > 0) {
        lines.push(`  \u26A0 \u6709 ${clearFailures.length} \u9879\u6E05\u7406\u5931\u8D25\uFF08\u6CA1\u6E05\u5E72\u51C0\uFF09\uFF1A`);
        for (const failure of clearFailures) {
          lines.push(`    \xB7 ${failure.path ?? failure.candidateId ?? "?"}: ${failure.code} \u2014 ${failure.message}`);
        }
        return { kind: "error", text: lines.join("\n") };
      }
      return { kind: "success", text: lines.join("\n") };
    }
  };
  const registered = [];
  const SPECS = [
    { name: "winstage", sub: null, description: "\u67E5\u770B WinStage \u6682\u5B58\u5F85\u5BA1\u6587\u4EF6\uFF08/winstage list|diff|approve|reject|rebase|refresh\uFF09" },
    { name: "winstage-status", sub: "status", description: "WinStage \u6682\u5B58\uFF1A\u67E5\u770B\u5F85\u5BA1\u6E05\u5355" },
    { name: "winstage-refresh", sub: "refresh", description: "WinStage \u6682\u5B58\uFF1A\u91CD\u65B0\u53D1\u5E03\u5BA1\u9605\u5FEB\u7167" },
    { name: "winstage-rebase", sub: "rebase", description: "WinStage \u6682\u5B58\uFF1A\u4EE5\u771F\u5B9E\u6587\u4EF6\u4E3A\u57FA\u7EBF\u91CD\u65B0\u6682\u5B58\uFF08\u57FA\u7EBF\u8FC7\u671F\u65F6\uFF09" },
    { name: "winstage-diff", sub: "diff", description: "WinStage \u6682\u5B58\uFF1A\u663E\u793A\u6539\u52A8\uFF08\u53EF\u7ED9\u8DEF\u5F84\uFF0C\u7A7A\u683C\u7528\u5F15\u53F7\u5305\u4F4F\uFF09" },
    { name: "winstage-approve", sub: "approve", description: "WinStage \u6682\u5B58\uFF1A\u628A\u6539\u52A8\u5199\u5165\u771F\u5B9E\u5DE5\u4F5C\u533A\uFF08\u53EF\u7ED9\u8DEF\u5F84\uFF09" },
    { name: "winstage-reject", sub: "reject", description: "WinStage \u6682\u5B58\uFF1A\u628A\u6539\u52A8\u9000\u56DE\u771F\u5B9E\u78C1\u76D8\uFF08\u53EF\u7ED9\u8DEF\u5F84\uFF09" }
  ];
  for (const spec of SPECS) {
    registered.push(
      scope.commands.register({
        definitionId: `winstage-sandbox/${spec.name}`,
        name: spec.name,
        description: spec.description,
        // ⚠ 字段名必须是 `hint`，不能用 `placeholder`：
        // `dsh-commands/lib/index.js:154-163 normalizeDefinition()` 在 `input` 存在时
        // 要求 `"hint" in input && typeof input.hint === "string"`，否则抛
        // `TypeError: command "<name>" input hint must be a string`。
        // 该异常会让整个 `ctx.inject(['commands'], …)` 回调失败 ⇒ **线上 0 条命令注册**，
        // 而进程内直接调 `registerCommands()`（绕过该校验）会「看起来注册了 6 条」。
        input: { hint: "\u6587\u4EF6\u8DEF\u5F84\uFF08\u53EF\u7701\u7565\uFF1B\u542B\u7A7A\u683C\u65F6\u7528\u53CC\u5F15\u53F7\uFF09" },
        handler: (invocation) => {
          try {
            if (!isEnabled()) return { kind: "error", text: DISABLED_TEXT };
            const service = serviceOf(invocation);
            const raw = String(invocation?.rawInput ?? "");
            let sub;
            let args;
            if (spec.sub === null) {
              const parsed = parseInvocation(raw);
              sub = parsed.subcommand;
              args = parsed.args;
            } else {
              sub = spec.sub;
              args = splitArgs(raw);
            }
            const handler = handlers[sub];
            if (!handler) {
              return {
                kind: "error",
                text: `\u672A\u77E5\u5B50\u547D\u4EE4 "${sub}"\uFF1B\u53EF\u7528\uFF1Alist\u3001status\u3001diff\u3001approve\u3001reject\u3001rebase\u3001refresh`
              };
            }
            return handler({ args, invocation, raw, service });
          } catch (error) {
            log.warn(`/${spec.name} \u5931\u8D25\uFF1A${error?.message ?? error}`);
            return { kind: "error", text: `/${spec.name} \u5931\u8D25\uFF1A${error?.message ?? error}` };
          }
        }
      })
    );
  }
  return registered;
}
function installRunCapture(ctx, options = {}) {
  const { workspaceRoot, serviceFor, log = () => {
  }, logError = () => {
  }, env = process.env } = options;
  if (env.WINSTAGE_CAPTURE !== "1") {
    log("\u8FD0\u884C\u540E\u6355\u83B7\uFF1A\u672A\u542F\u7528\uFF08\u8BBE WINSTAGE_CAPTURE=1 \u6253\u5F00\uFF09\u3002");
    return { enabled: false, tools: [] };
  }
  if (typeof ctx?.on !== "function") {
    logError("\u8FD0\u884C\u540E\u6355\u83B7\uFF1A\u672C ctx \u6CA1\u6709\u4E8B\u4EF6\u603B\u7EBF\uFF08ctx.on \u7F3A\u5931\uFF09\uFF0C\u6355\u83B7\u9762**\u672A**\u88C5\u914D\u3002");
    return { enabled: false, tools: [], reason: "no-event-bus" };
  }
  const tools = new Set(
    String(env.WINSTAGE_CAPTURE_TOOLS || "pwsh,bash").split(",").map((name3) => name3.trim()).filter(Boolean)
  );
  const restore = env.WINSTAGE_CAPTURE_RESTORE !== "0";
  const exclude = String(env.WINSTAGE_CAPTURE_EXCLUDE || "").split(",").map((value) => value.trim()).filter(Boolean);
  const maxFileBytes = Number(env.WINSTAGE_CAPTURE_MAX_BYTES || "") || void 0;
  const maxFiles = Number(env.WINSTAGE_CAPTURE_MAX_FILES || "") || void 0;
  const pending = /* @__PURE__ */ new Map();
  const callKey = (exec) => typeof exec?.callId === "string" && exec.callId.length > 0 ? exec.callId : `${exec?.name}@${exec?.agent?.session?.id ?? "nosession"}`;
  const captureFor = (exec) => {
    const service = serviceFor?.({ agent: exec?.agent });
    if (!service) {
      logError(`\u8FD0\u884C\u540E\u6355\u83B7\uFF1A\u6309\u4F1A\u8BDD\u89E3\u6790\u6682\u5B58\u670D\u52A1\u5931\u8D25\uFF08tool=${exec?.name}\uFF09\uFF0C\u672C\u6B21\u4E0D\u6355\u83B7\u3002`);
      return void 0;
    }
    try {
      service.reload?.();
    } catch (error) {
      logError(`\u8FD0\u884C\u540E\u6355\u83B7\uFF1Areload \u6682\u5B58\u6E05\u5355\u5931\u8D25\uFF08${error?.message ?? error}\uFF09\uFF0C\u4ECD\u6309\u5F53\u524D\u5B9E\u4F8B\u7EE7\u7EED\u3002`);
    }
    const workspace = service.workspace;
    if (!workspace?.store) {
      logError(`\u8FD0\u884C\u540E\u6355\u83B7\uFF1A\u6682\u5B58\u670D\u52A1\u6CA1\u6709 Workspace/Store\uFF08tool=${exec?.name}\uFF09\uFF0C\u672C\u6B21\u4E0D\u6355\u83B7\u3002`);
      return void 0;
    }
    return createRunCapture({
      workspaceRoot,
      store: workspace.store,
      workspace,
      log: (message, level) => level === "error" ? logError(message) : log(message),
      ...exclude.length > 0 ? { exclude } : {},
      ...maxFileBytes ? { maxFileBytes } : {},
      ...maxFiles ? { maxFiles } : {}
    });
  };
  ctx.on("tools/pre-execute", async (exec, next) => {
    const decision = await next();
    if (decision?.kind !== "allow") return decision;
    if (!tools.has(exec?.name)) return decision;
    const key = callKey(exec);
    try {
      const cap = captureFor(exec);
      if (cap) {
        const primed = await cap.prime();
        pending.set(key, {
          before: primed?.before,
          name: exec.name,
          // prime 阶段**读失败**的路径 = "执行前是什么"未知。把它交给 capture()，
          // 让那些路径**不参与**删除式还原（否则"读不到"会被当成"执行前不存在"而删掉真文件）。
          unknownPaths: (Array.isArray(primed?.skipped) ? primed.skipped : []).map((entry) => entry?.path).filter(Boolean)
        });
        log(`\u8FD0\u884C\u540E\u6355\u83B7\uFF1A\u5DF2\u53D6\u6267\u884C\u524D\u955C\u50CF\uFF08${exec.name}\uFF0C${primed?.files ?? 0} \u4E2A\u6587\u4EF6 / ${primed?.bytes ?? 0} \u5B57\u8282\uFF09\u3002`);
      }
    } catch (error) {
      logError(`\u8FD0\u884C\u540E\u6355\u83B7\uFF1A\u6267\u884C\u524D\u53D6\u955C\u50CF\u5931\u8D25\uFF08${exec?.name}\uFF09\uFF1A${error?.message ?? error}`);
    }
    return decision;
  });
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    const key = callKey(exec);
    const record = pending.get(key);
    if (!record) return decision;
    pending.delete(key);
    const surfaced = [];
    try {
      const cap = captureFor(exec);
      if (!cap) return decision;
      const report = await cap.capture(record.before, { restore, unknownPaths: record.unknownPaths });
      const failures = Array.isArray(report?.failures) ? report.failures : [];
      const staged = report?.staged ?? 0;
      if (staged > 0 || failures.length > 0) {
        log(
          `\u8FD0\u884C\u540E\u6355\u83B7\uFF1A${record.name} \u51C0\u53D8\u5316 ${report?.changes?.length ?? 0} \u6761\u3001\u843D\u6682\u5B58 ${staged} \u6761\u3001\u8FD8\u539F ${report?.restored ?? 0} \u6761\u3001\u5931\u8D25 ${failures.length} \u6761\u3002`
        );
      }
      for (const failure of failures) {
        const line = `\u8FD0\u884C\u540E\u6355\u83B7\u5931\u8D25[${failure?.phase ?? "?"}] ${failure?.path ?? "?"}\uFF1A${failure?.message ?? "\uFF08\u65E0\u6D88\u606F\uFF09"}`;
        logError(line);
        surfaced.push(`- ${line}`);
      }
    } catch (error) {
      const line = `\u8FD0\u884C\u540E\u6355\u83B7\uFF1A\u6267\u884C\u540E\u6355\u83B7\u629B\u9519\uFF08${exec?.name}\uFF09\uFF1A${error?.message ?? error}`;
      logError(line);
      surfaced.push(`- ${line}`);
    }
    if (surfaced.length === 0) return decision;
    if (decision?.kind === "accept" && Array.isArray(decision.content)) {
      return {
        ...decision,
        content: [
          ...decision.content,
          {
            type: "text",
            text: `[WinStage \u8FD0\u884C\u540E\u6355\u83B7] ${record.name}\uFF1A\u6709 ${surfaced.length} \u5904**\u6CA1\u6709**\u6309\u9884\u671F\u5904\u7406\u5B8C\uFF0C\u771F\u5B9E\u4E3B\u673A\u4E0A\u53EF\u80FD\u4ECD\u4FDD\u7559\u7740\u547D\u4EE4\u5199\u5165\u7684\u5185\u5BB9\u3002
${surfaced.join("\n")}
\u8BF7\u4E0D\u8981\u628A\u672A\u5217\u51FA\u7684\u90E8\u5206\u5F53\u6210\u5DF2\u88AB\u56DE\u6EDA\uFF1B\u5DF2\u6355\u83B7\u7684\u6539\u52A8\u4ECD\u53EF\u4EE5\u5728 WinStage \u9762\u677F\u4E0A\u6279\u51C6\u3002`
          }
        ]
      };
    }
    logError(
      "\u8FD0\u884C\u540E\u6355\u83B7\uFF1A\u8BE5\u5DE5\u5177\u7684\u8FD4\u56DE\u4E0D\u662F content \u5F62\u6001\uFF08`accept.value` \u4E0E `content` \u4E92\u65A5\uFF09\uFF0C\u5931\u8D25\u660E\u7EC6\u53EA\u80FD\u7559\u5728 error \u7EA7\u65E5\u5FD7\u91CC\uFF0C\u65E0\u6CD5\u968F\u7ED3\u679C\u56DE\u7ED9\u6A21\u578B\u3002"
    );
    return decision;
  });
  log(`\u8FD0\u884C\u540E\u6355\u83B7\uFF1A\u5DF2\u542F\u7528\uFF1B\u5DE5\u5177=${[...tools].join(",")}\uFF1B\u8FD8\u539F=${restore ? "\u5F00" : "\u5173"}\u3002`);
  return { enabled: true, tools: [...tools], restore };
}
function apply(ctx, config = {}) {
  const log = makeLog(ctx);
  const logError = (message) => {
    const logger = ctx?.logger;
    if (logger && typeof logger.error === "function") logger.error(message);
    else log.warn(message);
  };
  const workspaceRoot = config.workspaceRoot || new URL("..", import.meta.url).pathname.replace(/^\//, "");
  const isEnabled = () => config.enabled !== false;
  if (isEnabled()) {
    log.info(`\u5DF2\u542F\u7528\uFF1B\u5DE5\u4F5C\u533A\u6839 = ${workspaceRoot}`);
  } else {
    log.info("\u8BBE\u7F6E\u91CC\u5F53\u524D\u4E3A\u5173\u95ED\uFF1A\u6682\u5B58\u9762\u5DF2\u4EA4\u56DE\u5E73\u53F0\u6C99\u7BB1\uFF08\u539F\u5BA1\u6279\u6A21\u5F0F\uFF09\uFF1B/winstage* \u547D\u4EE4\u4ECD\u53EF\u89C1\u4F46\u4F1A\u5982\u5B9E\u62D2\u7EDD\u6267\u884C\u3002");
  }
  const skipEnvGate = process.env.WINSTAGE_SKIP_ENV_GATE === "1" || config.probeOnStart === false;
  let startupProbe;
  if (isEnabled() && !skipEnvGate) {
    startupProbe = probeRuntime();
    const report = evaluateEnvironment({ enabled: true, platform: process.platform, probeResult: startupProbe, skip: false });
    if (!report.ok) {
      const message = environmentFailureMessage(report);
      const error = new Error(message);
      error.code = report.code;
      error.winstage = { code: report.code, checks: report.checks, failures: report.failures };
      logError(`\u73AF\u5883\u76D1\u6D4B\u672A\u901A\u8FC7\uFF0CWinStage \u63D2\u4EF6\u62D2\u7EDD\u542F\u52A8\uFF1A${message}`);
      throw error;
    }
    if (config.verboseLog) log.info(environmentFailureMessage(report));
  }
  const serviceFor = (invocation) => {
    const sessionId = invocation?.agent?.session?.id;
    const sessionOf = () => invocation?.agent?.session;
    const audit = createAuditMirror({ sessionOf, log, logError });
    const service = getReviewService({
      workspaceRoot,
      ...typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : {},
      // T3d：**必须在这里就把开关传进去**。`getReviewService()` 内部自己也会认领一次
      // （`review-service.ts:1143`），只在下面那行加判断是**无效**的 —— 认领在函数里就已经发生了。
      claimShared: isEnabled(),
      log: (message) => log.info(message),
      audit
    });
    if (isEnabled()) service.absorbSharedStore?.();
    return service;
  };
  ctx.inject(["commands"], (scope) => {
    try {
      const registered = registerCommands(scope, serviceFor, log, { isEnabled });
      log.info(`\u5DF2\u6CE8\u518C ${registered.length} \u4E2A /winstage* \u547D\u4EE4\uFF08\u6682\u5B58\u4E0E\u5FEB\u7167\u6309\u4F1A\u8BDD\u9694\u79BB\uFF09`);
    } catch (error) {
      const logger = ctx?.logger;
      const message = `\u547D\u4EE4\u6CE8\u518C\u5931\u8D25\uFF1A${error?.message ?? error}\uFF08/winstage* \u5C06\u4E0D\u53EF\u7528\uFF09`;
      if (logger && typeof logger.error === "function") logger.error(message);
      log.warn(message);
    }
  });
  ctx.inject(["webServer"], (webScope) => {
    if (!webScope?.webServer || typeof webScope.webServer.register !== "function") {
      log.info("\u672C\u88C5\u914D\u6CA1\u6709 webServer\uFF1A\u9762\u677F\u8BFB\u4FA7\u8DEF\u7531\u672A\u6CE8\u518C\uFF1B\u9762\u677F\u5C06\u9000\u56DE\u517C\u5BB9\u65E7\u5E03\u5C40\u7684\u8BFB\u6CD5\uFF08\u547D\u4EE4\u9762\u4E0D\u53D7\u5F71\u54CD\uFF09\u3002");
      return;
    }
    try {
      const handler = createPanelHandler({
        workspaceRoot,
        isEnabled,
        log: (message) => log.warn(message)
        // 面④（未结算审批）需要"当前会话"的事件流。本路由没有 command invocation，
        // 拿不到就如实标"未知" —— 绝不用"最近一次命令的会话"冒充当前会话。
      });
      const route = { kind: "prefix", path: PANEL_ROUTE_PREFIX, handler };
      if (typeof webScope.effect === "function") {
        webScope.effect(() => webScope.webServer.register(route), "winstage-sandbox: panel routes");
      } else {
        webScope.webServer.register(route);
      }
      log.info(`\u9762\u677F\u8BFB\u4FA7\u8DEF\u7531\u5DF2\u6CE8\u518C\uFF1A${PANEL_ROUTE_PREFIX}\uFF08\u5B58\u50A8\u6839\u5728\u5BBF\u4E3B\u4FA7\u89E3\u6790\uFF1B\u5BA2\u6237\u7AEF\u4E0D\u518D\u62FC\u65E7\u5E03\u5C40\uFF09`);
    } catch (error) {
      const message = `\u9762\u677F\u8BFB\u4FA7\u8DEF\u7531\u6CE8\u518C\u5931\u8D25\uFF1A${error?.message ?? error}\uFF08\u9762\u677F\u4F1A\u9000\u56DE\u517C\u5BB9\u8BFB\u6CD5\uFF09`;
      const logger = ctx?.logger;
      if (logger && typeof logger.error === "function") logger.error(message);
      log.warn(message);
    }
  });
  installRunCapture(ctx, {
    workspaceRoot,
    serviceFor,
    log: (message) => log.info(message),
    // 复用 apply 作用域里那个具名 logError（`serviceFor` 也要用同一个，别再内联一份）
    logError
  });
  if (isEnabled()) {
    installBaselineWatch(ctx, {
      workspaceRoot,
      log: (message) => log.info(message),
      // 漂移诊断走**人工侧**通道（error 级日志），绝不进模型可见的 stdout/stderr
      logError
    });
    log.info("\u57FA\u7EBF\u6F02\u79FB\u590D\u6838\u5DF2\u88C5\u914D\uFF08\u53EA\u8BFB\u8F6E\u8BE2\uFF1B\u5916\u90E8\u5199\u5165\u4F1A\u5728\u4E00\u4E2A\u8282\u62CD\u5185\u51FA\u73B0\u5728\u9762\u677F\u4E0A\uFF09\u3002");
  }
  if (config.probeOnStart === false) {
    log.info("probeOnStart=false\uFF0C\u8DF3\u8FC7\u542F\u52A8\u63A2\u6D4B\u3002");
    return;
  }
  const probe = startupProbe ?? probeRuntime();
  if (probe.ready) {
    log.info(`\u80FD\u529B\u63A2\u6D4B\u901A\u8FC7\uFF1A${probe.detail}`);
  } else {
    log.warn(`\u80FD\u529B\u63A2\u6D4B\u672A\u901A\u8FC7\uFF1A${probe.detail}`);
  }
}

// plugin/policy/engine.ts
var engine_exports = {};
__export(engine_exports, {
  REASON: () => REASON,
  builtinRules: () => builtinRules,
  evaluate: () => evaluate,
  intersectConstraints: () => intersectConstraints,
  normalizeResult: () => normalizeResult
});
var REASON = Object.freeze({
  TOOL_HARD_DENIED: "TOOL_HARD_DENIED",
  NETWORK_OFFLINE: "NETWORK_OFFLINE",
  PROCESS_UNAVAILABLE: "PROCESS_UNAVAILABLE",
  PRIVILEGE_TIER_EXCEEDS_MAX: "PRIVILEGE_TIER_EXCEEDS_MAX",
  POLICY_EVALUATION_FAILED: "POLICY_EVALUATION_FAILED",
  POLICY_INVALID_RESULT: "POLICY_INVALID_RESULT",
  POLICY_INVALID_DECISION: "POLICY_INVALID_DECISION"
});
var DECISIONS = /* @__PURE__ */ new Set(["ALLOW", "NEEDS_CONFIRMATION", "DENY"]);
function normalizeResult(res) {
  if (res === null || typeof res !== "object") {
    return { decision: "DENY", reasonCodes: [REASON.POLICY_INVALID_RESULT], constraints: {}, requiredGrants: [] };
  }
  const record = res;
  if (typeof record.decision !== "string" || !DECISIONS.has(record.decision)) {
    return { decision: "DENY", reasonCodes: [REASON.POLICY_INVALID_DECISION], constraints: {}, requiredGrants: [] };
  }
  return {
    decision: record.decision,
    reasonCodes: Array.isArray(record.reasonCodes) ? record.reasonCodes.map(String) : [],
    constraints: record.constraints && typeof record.constraints === "object" ? record.constraints : {},
    requiredGrants: Array.isArray(record.requiredGrants) ? record.requiredGrants.slice() : []
  };
}
function intersectConstraints(list) {
  let out;
  for (const c of list) {
    if (c === null || typeof c !== "object") continue;
    if (out === void 0) {
      out = { ...c };
      continue;
    }
    for (const [key, value] of Object.entries(c)) {
      const prev = out[key];
      if (typeof value === "number" && typeof prev === "number") {
        out[key] = Math.min(prev, value);
      } else if (Array.isArray(value) && Array.isArray(prev)) {
        const allow = new Set(value);
        out[key] = prev.filter((item) => allow.has(item));
      } else {
        out[key] = value;
      }
    }
  }
  return out ?? {};
}
function builtinRules(facts, config) {
  const out = [];
  const denyTools = Array.isArray(config.denyTools) ? config.denyTools : [];
  if (typeof facts.tool === "string" && denyTools.includes(facts.tool)) {
    out.push({ decision: "DENY", reasonCodes: [REASON.TOOL_HARD_DENIED], constraints: {}, requiredGrants: [] });
  }
  if (facts.effect === "network" && config.offline === true) {
    out.push({ decision: "DENY", reasonCodes: [REASON.NETWORK_OFFLINE], constraints: {}, requiredGrants: [] });
  }
  const tier = typeof facts.privilege?.tier === "number" ? facts.privilege.tier : 0;
  const maxTier = typeof config.maxTier === "number" ? config.maxTier : 0;
  if (facts.privilege !== void 0 && tier > maxTier) {
    out.push({ decision: "DENY", reasonCodes: [REASON.PRIVILEGE_TIER_EXCEEDS_MAX], constraints: {}, requiredGrants: [] });
  }
  return out;
}
function evaluate(facts, config = {}) {
  const results = builtinRules(facts, config);
  const rules = Array.isArray(config.rules) ? config.rules : [];
  for (const rule of rules) {
    if (typeof rule !== "function") continue;
    try {
      results.push(normalizeResult(rule(facts)));
    } catch {
      results.push({ decision: "DENY", reasonCodes: [REASON.POLICY_EVALUATION_FAILED], constraints: {}, requiredGrants: [] });
    }
  }
  const constraintsList = [];
  const reasonCodes = [];
  const requiredGrants = [];
  let hardDeny = false;
  let needsConfirmation = false;
  for (const r of results) {
    if (r.constraints !== void 0 && Object.keys(r.constraints).length > 0) constraintsList.push(r.constraints);
    for (const g of r.requiredGrants) requiredGrants.push(g);
    if (r.decision === "DENY") {
      hardDeny = true;
      for (const c of r.reasonCodes) reasonCodes.push(c);
    } else if (r.decision === "NEEDS_CONFIRMATION") {
      needsConfirmation = true;
      for (const c of r.reasonCodes) reasonCodes.push(c);
    }
  }
  const constraints = intersectConstraints(constraintsList);
  if (hardDeny) return { decision: "DENY", reasonCodes, constraints, requiredGrants };
  if (needsConfirmation || requiredGrants.length > 0) {
    return { decision: "NEEDS_CONFIRMATION", reasonCodes, constraints, requiredGrants };
  }
  return { decision: "ALLOW", reasonCodes, constraints, requiredGrants };
}

// plugin/risk.ts
var risk_exports = {};
__export(risk_exports, {
  LEVEL: () => LEVEL,
  RISK_REASON: () => RISK_REASON,
  actionFor: () => actionFor,
  assess: () => assess,
  decide: () => decide
});
var LEVEL = Object.freeze({ LOW: 0, MODERATE: 1, HIGH: 2, CRITICAL: 3 });
var RISK_REASON = Object.freeze({
  SYSTEM_PATH: "RISK_SYSTEM_PATH",
  USER_PATH: "RISK_USER_PATH",
  NETWORK: "RISK_NETWORK",
  PACKAGE_INSTALL: "RISK_PACKAGE_INSTALL",
  PRIVILEGE_TIER: "RISK_PRIVILEGE_TIER",
  SECRET_SCOPE: "RISK_SECRET_SCOPE",
  DANGEROUS_COMMAND: "RISK_DANGEROUS_COMMAND",
  SELF_STORE: "RISK_SELF_STORE"
});
var NAME_OF = { 0: "L0", 1: "L1", 2: "L2", 3: "L3" };
function assess(facts) {
  let level = LEVEL.LOW;
  const reasonCodes = [];
  let hardDeny = false;
  const raise = (target, code) => {
    if (target > level) level = target;
    reasonCodes.push(code);
  };
  switch (facts.pathScope) {
    case "system":
      raise(LEVEL.CRITICAL, RISK_REASON.SYSTEM_PATH);
      break;
    case "user":
      raise(LEVEL.MODERATE, RISK_REASON.USER_PATH);
      break;
    default:
      break;
  }
  if (facts.effect === "network") raise(LEVEL.MODERATE, RISK_REASON.NETWORK);
  if (facts.packageInstall === true) raise(LEVEL.HIGH, RISK_REASON.PACKAGE_INSTALL);
  if (typeof facts.tier === "number" && facts.tier >= 2) raise(LEVEL.HIGH, RISK_REASON.PRIVILEGE_TIER);
  if (facts.secret === true) raise(LEVEL.HIGH, RISK_REASON.SECRET_SCOPE);
  if (facts.dangerousCommand === true) {
    raise(LEVEL.CRITICAL, RISK_REASON.DANGEROUS_COMMAND);
    hardDeny = true;
  }
  if (facts.selfStore === true) {
    raise(LEVEL.CRITICAL, RISK_REASON.SELF_STORE);
    hardDeny = true;
  }
  const action = actionFor(level, hardDeny);
  return { level, levelName: NAME_OF[level], action, reasonCodes, hardDeny };
}
function actionFor(level, hardDeny) {
  if (hardDeny) return "block";
  if (level >= LEVEL.CRITICAL) return "block";
  if (level === LEVEL.HIGH) return "review";
  if (level === LEVEL.MODERATE) return "record";
  return "auto";
}
function decide(input) {
  const { verdict, confirmed = false, sessionAuto = false } = input;
  if (verdict.hardDeny) return false;
  if (verdict.action === "auto") return true;
  if (verdict.action === "record") return true;
  const neverAutoSkip = verdict.reasonCodes.includes(RISK_REASON.SECRET_SCOPE) || verdict.reasonCodes.includes(RISK_REASON.PACKAGE_INSTALL);
  if (sessionAuto && !neverAutoSkip) return true;
  if (verdict.action === "block") return false;
  return confirmed === true;
}

// plugin/approval-hub.ts
var approval_hub_exports = {};
__export(approval_hub_exports, {
  PAGES: () => PAGES,
  createApprovalHub: () => createApprovalHub
});
var PAGES = Object.freeze([
  { id: "files", label: "\u5F85\u4FEE\u6539", kind: "review" },
  { id: "behavior", label: "\u5DE5\u5177\u884C\u4E3A", kind: "blocking" },
  { id: "resource", label: "\u8D44\u6E90\u8BBF\u95EE", kind: "blocking" },
  { id: "network", label: "\u7F51\u7EDC\u8BF7\u6C42", kind: "blocking" },
  { id: "anomaly", label: "\u8D8A\u754C/\u5F02\u5E38", kind: "observe" }
]);
var PAGE_IDS = new Set(PAGES.map((p) => p.id));
function createApprovalHub(onChange) {
  let seq = 0;
  const entries = /* @__PURE__ */ new Map();
  const order = [];
  const providers = /* @__PURE__ */ new Map();
  const emit = (page) => {
    if (typeof onChange === "function") {
      try {
        onChange(page);
      } catch {
      }
    }
  };
  return {
    submit(page, entry) {
      if (!PAGE_IDS.has(page)) throw new Error(`approval-hub: unknown page ${String(page)}`);
      seq += 1;
      const id = entry?.id ?? `ah_${seq}_${Date.now()}`;
      const record = {
        id,
        page,
        seq,
        title: String(entry?.title ?? ""),
        detail: Array.isArray(entry?.detail) ? entry.detail : [],
        decisions: entry?.decisions,
        onDecision: entry?.onDecision,
        meta: entry?.meta,
        createdAt: Date.now()
      };
      if (!entries.has(id)) order.push(id);
      entries.set(id, record);
      emit(page);
      return id;
    },
    resolve(id, value) {
      const record = entries.get(id);
      if (record === void 0) return false;
      entries.delete(id);
      const at = order.indexOf(id);
      if (at >= 0) order.splice(at, 1);
      if (typeof record.onDecision === "function") {
        try {
          record.onDecision(value);
        } catch {
        }
      }
      emit(record.page);
      return true;
    },
    clear(id) {
      const record = entries.get(id);
      if (record === void 0) return false;
      entries.delete(id);
      const at = order.indexOf(id);
      if (at >= 0) order.splice(at, 1);
      emit(record.page);
      return true;
    },
    get(id) {
      return entries.get(id);
    },
    list(page) {
      const out = [];
      for (const id of order) {
        const record = entries.get(id);
        if (record !== void 0 && record.page === page) out.push(record);
      }
      return out;
    },
    registerProvider(page, fn) {
      if (fn === void 0) providers.delete(page);
      else providers.set(page, fn);
    },
    observe(page) {
      const fn = providers.get(page);
      if (typeof fn !== "function") return [];
      try {
        const items = fn();
        return Array.isArray(items) ? items : [];
      } catch {
        return [];
      }
    },
    pendingCount(page) {
      let n = 0;
      for (const record of entries.values()) {
        if (page === void 0 || record.page === page) n += 1;
      }
      return n;
    },
    reset() {
      seq = 0;
      entries.clear();
      order.length = 0;
      providers.clear();
    }
  };
}

// plugin/review-state.ts
var review_state_exports = {};
__export(review_state_exports, {
  APPLY: () => APPLY,
  REVIEW: () => REVIEW,
  canTransitionApply: () => canTransitionApply,
  canTransitionReview: () => canTransitionReview,
  hasNetChange: () => hasNetChange,
  isApplicable: () => isApplicable,
  resolveCurrent: () => resolveCurrent,
  selectForApply: () => selectForApply,
  supersedeByPaths: () => supersedeByPaths
});
var REVIEW = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
  SUPERSEDED: "SUPERSEDED"
});
var APPLY = Object.freeze({
  NOT_REQUESTED: "NOT_REQUESTED",
  APPLYING: "APPLYING",
  APPLIED: "APPLIED",
  REVERTED: "REVERTED",
  CONFLICT: "CONFLICT",
  FAILED: "FAILED",
  RECONCILING: "RECONCILING",
  NEEDS_ROOT: "NEEDS_ROOT"
});
var REVIEW_TRANSITIONS = {
  PENDING: /* @__PURE__ */ new Set([REVIEW.APPROVED, REVIEW.REJECTED, REVIEW.EXPIRED, REVIEW.SUPERSEDED]),
  APPROVED: /* @__PURE__ */ new Set([REVIEW.SUPERSEDED]),
  REJECTED: /* @__PURE__ */ new Set([]),
  EXPIRED: /* @__PURE__ */ new Set([]),
  SUPERSEDED: /* @__PURE__ */ new Set([])
};
var APPLY_TRANSITIONS = {
  NOT_REQUESTED: /* @__PURE__ */ new Set([APPLY.APPLYING, APPLY.NEEDS_ROOT]),
  NEEDS_ROOT: /* @__PURE__ */ new Set([APPLY.APPLYING, APPLY.FAILED]),
  APPLYING: /* @__PURE__ */ new Set([APPLY.APPLIED, APPLY.CONFLICT, APPLY.FAILED, APPLY.RECONCILING]),
  RECONCILING: /* @__PURE__ */ new Set([APPLY.APPLIED, APPLY.FAILED]),
  APPLIED: /* @__PURE__ */ new Set([APPLY.REVERTED]),
  REVERTED: /* @__PURE__ */ new Set([APPLY.APPLYING]),
  CONFLICT: /* @__PURE__ */ new Set([APPLY.APPLYING, APPLY.RECONCILING]),
  FAILED: /* @__PURE__ */ new Set([APPLY.APPLYING, APPLY.RECONCILING])
};
function canTransitionReview(from2, to) {
  return from2 === to || REVIEW_TRANSITIONS[from2].has(to);
}
function canTransitionApply(from2, to) {
  return from2 === to || APPLY_TRANSITIONS[from2].has(to);
}
function isApplicable(unit) {
  return (unit.reviewState === REVIEW.PENDING || unit.reviewState === REVIEW.APPROVED) && (unit.applyState === APPLY.NOT_REQUESTED || unit.applyState === APPLY.NEEDS_ROOT);
}
function selectForApply(units, paths) {
  const wanted = paths === void 0 ? void 0 : new Set(paths);
  const selected = [];
  const remaining = [];
  for (const unit of units) {
    const applicable = isApplicable(unit);
    const matches = wanted === void 0 ? true : unit.paths.some((p) => wanted.has(p));
    if (applicable && matches) selected.push(unit);
    else remaining.push(unit);
  }
  return { selected, remaining };
}
function resolveCurrent(units, id) {
  const seen = /* @__PURE__ */ new Set();
  let current = units.get(id);
  while (current !== void 0 && current.supersededBy !== void 0) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    const next = units.get(current.supersededBy);
    if (next === void 0) break;
    current = next;
  }
  return current;
}
function supersedeByPaths(units, next) {
  const superseded = [];
  const nextPaths = new Set(next.paths);
  for (const unit of units.values()) {
    if (unit.id === next.id) continue;
    if (unit.reviewState !== REVIEW.PENDING) continue;
    if (!unit.paths.some((p) => nextPaths.has(p))) continue;
    unit.reviewState = REVIEW.SUPERSEDED;
    unit.supersededBy = next.id;
    superseded.push(unit.id);
  }
  return superseded;
}
function hasNetChange(before, after) {
  return before !== after;
}

// plugin/commands.ts
function renderUnit(unit, verdict) {
  const paths = unit.paths.join(", ");
  return `  ${verdict.levelName} ${verdict.action.padEnd(6)} ${paths}  [${unit.reviewState}/${unit.applyState}]`;
}
function renderReview(deps) {
  const units = deps.units().filter((u) => u.reviewState === REVIEW.PENDING || u.reviewState === REVIEW.APPROVED);
  if (units.length === 0) return { kind: "success", text: "\u6682\u5B58\u533A\u6CA1\u6709\u5F85\u5BA1\u6539\u52A8\u3002" };
  const lines = units.map((u) => renderUnit(u, assess(deps.riskOf(u))));
  const header = `\u5F85\u5BA1\u6539\u52A8\uFF08${units.length}\uFF09\uFF1A`;
  const hard = units.filter((u) => assess(deps.riskOf(u)).hardDeny).length;
  const footer = hard > 0 ? `
\u5176\u4E2D ${hard} \u9879\u4E3A\u786C\u62D2\u7EDD\uFF08\u4E0D\u53EF\u786E\u8BA4\u8986\u76D6\uFF09\u3002` : "";
  return { kind: hard > 0 ? "error" : "success", text: `${header}
${lines.join("\n")}${footer}` };
}
function applyWithGuard(deps, input = {}) {
  const { selected, remaining } = selectForApply(deps.units(), input.paths);
  if (selected.length === 0) return { kind: "error", text: "\u6CA1\u6709\u53EF\u5E94\u7528\u7684\u6682\u5B58\u6539\u52A8\uFF08\u6216\u6240\u9009\u8DEF\u5F84\u4E0D\u5B58\u5728\uFF09\u3002" };
  const hardDenied = selected.filter((u) => assess(deps.riskOf(u)).hardDeny);
  if (hardDenied.length > 0) {
    const paths = hardDenied.flatMap((u) => u.paths).join(", ");
    return { kind: "error", text: `\u62D2\u7EDD\u5E94\u7528\uFF1A\u4EE5\u4E0B\u6539\u52A8\u4E3A\u786C\u62D2\u7EDD\uFF08\u4E0D\u53EF\u88AB\u786E\u8BA4\u8986\u76D6\uFF09\uFF1A${paths}` };
  }
  const needsConfirm = selected.filter((u) => {
    const verdict = assess(deps.riskOf(u));
    return !decide({ verdict, confirmed: input.force === true, sessionAuto: input.sessionAuto === true });
  });
  if (needsConfirm.length > 0) {
    const paths = needsConfirm.flatMap((u) => u.paths).join(", ");
    return {
      kind: "error",
      text: `\u9700\u8981\u786E\u8BA4\uFF1A${paths}
\u518D\u6B21\u6267\u884C /winstage-apply --force \u4EE5\u786E\u8BA4\u3002`
    };
  }
  const result = deps.apply(selected);
  const kept = remaining.length;
  const text = `\u5DF2\u5E94\u7528 ${result.applied.length} \u4E2A\u6587\u4EF6` + (result.failed.length > 0 ? `\uFF0C\u5931\u8D25 ${result.failed.length}\uFF1A${result.failed.join(", ")}` : "") + (kept > 0 ? `\uFF1B\u4FDD\u7559 ${kept} \u4E2A\u672A\u9009\u4E2D\u9879\u3002` : "\u3002");
  return { kind: result.failed.length > 0 ? "error" : "success", text };
}
function discardAll(deps) {
  deps.discard();
  return { kind: "success", text: "\u5DF2\u4E22\u5F03\u6682\u5B58\u6539\u52A8\uFF08\u771F\u5B9E\u5DE5\u4F5C\u533A\u672A\u6539\u52A8\uFF09\u3002" };
}
function parseApplyArgs(rawInput) {
  const raw = String(rawInput ?? "");
  const force = /(^|\s)--force(\s|$)/.test(raw);
  const fileMatch = /--file(?:=|\s+)(\S+)/.exec(raw);
  const paths = fileMatch?.[1] !== void 0 ? [fileMatch[1]] : void 0;
  return { force, ...paths === void 0 ? {} : { paths } };
}
function registerAlignedCommands(ctx, deps) {
  const commands = ctx.commands;
  if (commands === void 0) return;
  const specs = [
    { name: "winstage-review", description: "WinStage \u6682\u5B58\uFF1A\u5217\u51FA\u5F85\u5BA1\u6539\u52A8\u4E0E\u98CE\u9669\u6863\uFF08\u5BF9\u9F50 NeoAI \u5206\u7EA7\uFF09", handler: () => renderReview(deps) },
    {
      name: "winstage-apply",
      description: "WinStage \u6682\u5B58\uFF1A\u6309\u5206\u7EA7\u786E\u8BA4\u5E94\u7528\uFF08--force \u786E\u8BA4\uFF1B\u786C\u62D2\u7EDD\u4E0D\u53EF\u8986\u76D6\uFF09",
      handler: () => applyWithGuard(deps, { force: true })
    },
    { name: "winstage-discard", description: "WinStage \u6682\u5B58\uFF1A\u4E22\u5F03\u5168\u90E8\u6682\u5B58\uFF08\u771F\u5B9E\u5DE5\u4F5C\u533A\u4E0D\u6539\uFF09", handler: () => discardAll(deps) }
  ];
  try {
    for (const spec of specs) {
      const registration = () => commands.register({
        name: spec.name,
        description: spec.description,
        input: { hint: "\u53EF\u9009\uFF1A--force \u786E\u8BA4 / --file <\u8DEF\u5F84>" },
        handler: () => spec.handler()
      });
      if (typeof ctx.effect === "function") ctx.effect(registration, `winstage-sandbox: command ${spec.name}`);
      else registration();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger?.error?.(`WinStage \u5BF9\u9F50\u547D\u4EE4\u6CE8\u518C\u5931\u8D25\uFF1A${message}`);
  }
}

// plugin/wire.ts
var DEFAULT_UNIT_REVIEW = REVIEW.PENDING;
var DEFAULT_UNIT_APPLY = APPLY.NOT_REQUESTED;
function riskFactsOf(file) {
  const facts = { effect: "filesystem" };
  if (file.kind === "registry") {
    facts.effect = "registry";
    facts.pathScope = "system";
  }
  if (file.risk === "sensitive") facts.secret = true;
  else if (file.risk === "outside") facts.pathScope = "other";
  if (file.safety === "danger") facts.selfStore = false;
  return facts;
}
function unitOf(file) {
  return {
    id: file.path,
    reviewState: DEFAULT_UNIT_REVIEW,
    applyState: DEFAULT_UNIT_APPLY,
    paths: [file.path],
    createdAt: 0
  };
}
function buildAlignedDeps(service) {
  return {
    units() {
      const files = service.snapshot().files ?? [];
      return files.map(unitOf);
    },
    riskOf(unit) {
      const files = service.snapshot().files ?? [];
      const file = files.find((f) => f.path === unit.paths[0]);
      return file === void 0 ? { effect: "filesystem" } : riskFactsOf(file);
    },
    apply(units) {
      const paths = units.flatMap((u) => u.paths);
      const result = service.approve(paths);
      const applied = paths.slice(0, typeof result.approved === "number" ? result.approved : paths.length);
      const failed = Array.isArray(result.failed) ? result.failed.map(String) : [];
      return { applied, failed };
    },
    discard() {
      const files = service.snapshot().files ?? [];
      service.reject(files.map((f) => f.path));
    }
  };
}

// plugin/index.ts
var name2 = name;
var inject2 = inject;
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  return {
    enabled: boolOf(source.enabled, true),
    workspaceRoot: stringOf(source.workspaceRoot, ""),
    probeOnStart: boolOf(source.probeOnStart, true),
    verboseLog: boolOf(source.verboseLog, false)
  };
}
function apply2(ctx, config) {
  apply(ctx, normalizeConfig(config));
}
var plugin_default = { name: name2, inject: inject2, Config, apply: apply2 };
export {
  Config,
  apply2 as apply,
  applyWithGuard,
  approval_hub_exports as approvalHub,
  buildAlignedDeps,
  plugin_default as default,
  discardAll,
  inject2 as inject,
  name2 as name,
  normalizeConfig,
  parseApplyArgs,
  engine_exports as policy,
  probeRuntime,
  registerAlignedCommands,
  renderReview,
  review_state_exports as reviewState,
  risk_exports as risk,
  riskFactsOf,
  unitOf
};
