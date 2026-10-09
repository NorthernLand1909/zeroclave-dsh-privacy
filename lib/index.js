import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
//#region ../../../vendor/cosmokit/src/misc.ts
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
//#endregion
//#region ../../../vendor/cosmokit/src/types.ts
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
let Binary;
(function(_Binary) {
	_Binary.is = isArrayBufferLike;
	_Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	_Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	_Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	_Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	_Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	_Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result = [];
		refs.set(source, result);
		source.forEach((value, index) => {
			result[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result;
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
/** Deeply compare arrays, dates, regexps, buffers, and plain object fields. */
function deepEqual(a, b, strict) {
	if (a === b) return true;
	if (!strict && isNullable(a) && isNullable(b)) return true;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;
	if (!a || !b) return false;
	function check(test, then) {
		return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
	}
	return check(Array.isArray, (a, b) => a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
		if (a.byteLength !== b.byteLength) return false;
		const viewA = new Uint8Array(a);
		const viewB = new Uint8Array(b);
		for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
		return true;
	}) ?? Object.keys({
		...a,
		...b
	}).every((key) => deepEqual(a[key], b[key], strict));
}
//#endregion
//#region ../../../vendor/cosmokit/src/time.ts
let Time;
(function(_Time) {
	_Time.millisecond = 1;
	const second = _Time.second = 1e3;
	const minute = _Time.minute = second * 60;
	const hour = _Time.hour = minute * 60;
	const day = _Time.day = hour * 24;
	const week = _Time.week = day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	_Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	_Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / minute - offset) / 1440);
	}
	_Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * minute);
	}
	_Time.fromDateNumber = fromDateNumber;
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
		return (parseFloat(capture[1]) * week || 0) + (parseFloat(capture[2]) * day || 0) + (parseFloat(capture[3]) * hour || 0) + (parseFloat(capture[4]) * minute || 0) + (parseFloat(capture[5]) * second || 0);
	}
	_Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	_Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= day - hour / 2) return Math.round(ms / day) + "d";
		else if (abs >= hour - minute / 2) return Math.round(ms / hour) + "h";
		else if (abs >= minute - second / 2) return Math.round(ms / minute) + "m";
		else if (abs >= second) return Math.round(ms / second) + "s";
		return ms + "ms";
	}
	_Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	_Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	_Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region ../../../vendor/schemastery/src/index.ts
const kSchema = Symbol.for("schemastery");
const kValidationError = Symbol.for("ValidationError");
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
const Schema = function(options) {
	const schema = function(data, options = {}) {
		return Schema.resolve(data, schema, options)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options) => new Schema(options));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options = refs[key];
			options.sKey = getRef(options.sKey);
			options.inner = getRef(options.inner);
			options.list = options.list && options.list.map(getRef);
			options.dict = options.dict && mapValues(options.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
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
	const pattern = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
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
		value.forEach((value, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value) : value;
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
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role,
		extra
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
const resolvers = {};
Schema.extend = function extend(type, resolve) {
	resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
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
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
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
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date = new Date(value);
		if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
		return date;
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
		return schema.meta.default;
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
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name, keys, format) {
	formatters[name] = format;
	Object.assign(Schema, { [name](...args) {
		const schema = new Schema({ type: name });
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
					for (const key in args[index]) {
						if (typeof args[index][key] !== "number") continue;
						schema.bits[key] = args[index][key];
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
				default: schema[key] = args[index];
			}
		});
		if (name === "object" || name === "dict") schema.meta.default = {};
		else if (name === "array" || name === "tuple") schema.meta.default = [];
		else if (name === "bitset") schema.meta.default = 0;
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
//#endregion
//#region lib/types/proxy.js
const ZEROCLAVE_DETECT_PROXY_PATH = "/api/zeroclave-privacy/detect";
const MAX_DETECT_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
var RequestBodyTooLargeError = class extends Error {};
var RequestAbortedError = class extends Error {};
var ResponseBodyTooLargeError = class extends Error {};
var DetectorProxyTimeoutError = class extends Error {};
function isLoopback$1(hostname) {
	return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}
function upstreamDetectURL(gatewayBaseURL) {
	const base = new URL(gatewayBaseURL);
	if (base.protocol !== "https:" && (base.protocol !== "http:" || !isLoopback$1(base.hostname))) throw new Error("Gateway URL must use HTTPS unless it targets loopback");
	if (base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") throw new Error("Gateway URL must not contain credentials, query parameters, or a fragment");
	const pathname = base.pathname.replace(/\/+$/u, "");
	base.pathname = /\/pii\/detect$/u.test(pathname) ? pathname : /\/v1$/u.test(pathname) ? `${pathname}/pii/detect` : `${pathname}/v1/pii/detect`;
	return base.toString();
}
function requestID(header) {
	return typeof header === "string" && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
}
function isJSONContentType(header) {
	if (typeof header !== "string") return false;
	return header.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
function sendJSON$1(res, status, id, code, message, extraHeaders = {}) {
	res.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"x-content-type-options": "nosniff",
		"x-request-id": id,
		...extraHeaders
	});
	res.end(JSON.stringify({
		request_id: id,
		error: {
			code,
			message
		}
	}));
}
function declaredBodyTooLarge(header) {
	if (typeof header !== "string" || !/^\d+$/u.test(header)) return false;
	return Number(header) > MAX_DETECT_REQUEST_BODY_BYTES;
}
function readRequestBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let length = 0;
		const cleanup = () => {
			req.off("data", onData);
			req.off("end", onEnd);
			req.off("error", onError);
			req.off("aborted", onAborted);
		};
		const onData = (chunk) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			length += buffer.byteLength;
			if (length > 10485760) {
				cleanup();
				req.resume();
				reject(new RequestBodyTooLargeError());
				return;
			}
			chunks.push(buffer);
		};
		const onEnd = () => {
			cleanup();
			resolve(Buffer.concat(chunks, length));
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		const onAborted = () => {
			cleanup();
			reject(new RequestAbortedError());
		};
		req.on("data", onData);
		req.once("end", onEnd);
		req.once("error", onError);
		req.once("aborted", onAborted);
	});
}
async function readResponseBody(response) {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > 10485760) {
		await response.body?.cancel().catch(() => {});
		throw new ResponseBodyTooLargeError();
	}
	if (response.body === null) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks = [];
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > 10485760) {
			await reader.cancel().catch(() => {});
			throw new ResponseBodyTooLargeError();
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks, length);
}
function responseHeaders(response, fallbackRequestID) {
	const upstreamRequestID = response.headers.get("x-request-id");
	const headers = {
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"x-request-id": upstreamRequestID !== null && REQUEST_ID_PATTERN.test(upstreamRequestID) ? upstreamRequestID : fallbackRequestID
	};
	const contentType = response.headers.get("content-type");
	const retryAfter = response.headers.get("retry-after");
	if (contentType !== null) headers["content-type"] = contentType;
	if (retryAfter !== null) headers["retry-after"] = retryAfter;
	return headers;
}
function createDetectProxyHandler(config, fetchImpl = fetch) {
	const upstreamURL = upstreamDetectURL(config.gatewayBaseURL);
	return async (req, res) => {
		const id = requestID(req.headers["x-request-id"]);
		if (req.method !== "POST") {
			req.resume();
			sendJSON$1(res, 405, id, "method_not_allowed", "Use POST for this endpoint", { allow: "POST" });
			return;
		}
		const contentType = req.headers["content-type"];
		if (!isJSONContentType(contentType)) {
			req.resume();
			sendJSON$1(res, 415, id, "unsupported_media_type", "Use Content-Type: application/json");
			return;
		}
		const contentEncoding = req.headers["content-encoding"];
		if (contentEncoding !== void 0 && contentEncoding !== "identity") {
			req.resume();
			sendJSON$1(res, 415, id, "unsupported_media_type", "Use an uncompressed UTF-8 JSON request body");
			return;
		}
		if (declaredBodyTooLarge(req.headers["content-length"])) {
			req.resume();
			sendJSON$1(res, 413, id, "request_body_too_large", "Request body exceeds 10 MiB");
			return;
		}
		let body;
		try {
			body = await readRequestBody(req);
		} catch (error) {
			if (error instanceof RequestAbortedError || req.destroyed || res.destroyed) return;
			if (error instanceof RequestBodyTooLargeError) {
				sendJSON$1(res, 413, id, "request_body_too_large", "Request body exceeds 10 MiB");
				return;
			}
			sendJSON$1(res, 400, id, "invalid_request", "Unable to read request body");
			return;
		}
		const controller = new AbortController();
		const onRequestAborted = () => {
			controller.abort(new RequestAbortedError());
		};
		const onResponseClose = () => {
			if (res.writableEnded) return;
			controller.abort(new RequestAbortedError());
		};
		req.once("aborted", onRequestAborted);
		res.once("close", onResponseClose);
		const timer = setTimeout(() => {
			controller.abort(new DetectorProxyTimeoutError());
		}, config.timeoutMs);
		try {
			const response = await fetchImpl(upstreamURL, {
				method: "POST",
				headers: {
					"content-type": contentType,
					"x-request-id": id
				},
				body: Uint8Array.from(body),
				redirect: "manual",
				signal: controller.signal
			});
			const responseBody = await readResponseBody(response);
			if (controller.signal.aborted) throw controller.signal.reason;
			if (res.destroyed) return;
			res.writeHead(response.status, responseHeaders(response, id));
			res.end(responseBody);
		} catch (error) {
			const reason = controller.signal.reason;
			if (reason instanceof RequestAbortedError || res.destroyed) return;
			if (reason instanceof DetectorProxyTimeoutError) {
				sendJSON$1(res, 504, id, "detector_timeout", "Detection service timed out");
				return;
			}
			if (error instanceof ResponseBodyTooLargeError) {
				sendJSON$1(res, 502, id, "detector_response_invalid", "Detection service returned an invalid response");
				return;
			}
			sendJSON$1(res, 503, id, "detector_unavailable", "Detection service is unavailable");
		} finally {
			clearTimeout(timer);
			req.off("aborted", onRequestAborted);
			res.off("close", onResponseClose);
		}
	};
}
//#endregion
//#region lib/types/telemetry-proxy.js
const TELEMETRY_CONFIG_PATH = "/api/zeroclave-privacy/telemetry/config";
const TELEMETRY_EVENTS_PATH = "/api/zeroclave-privacy/telemetry/events";
const DAILY_ID = /^[A-Za-z0-9_-]{22}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;
const DETECTORS = new Set([
	"regex",
	"embedded",
	"zeroclave"
]);
const EVENTS = new Set([
	"privacy_active",
	"protected_send",
	"detector_used"
]);
const PLAUSIBLE_SITE = /^[A-Za-z0-9_.-]{1,128}$/u;
var BodyTooLargeError = class extends Error {};
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isLoopback(hostname) {
	return hostname === "127.0.0.1" || hostname === "[::1]";
}
function telemetryURL(value, provider) {
	const url = new URL(value);
	const hasQuery = url.href.includes("?");
	const hasFragment = url.href.includes("#");
	if (provider === "plausible") {
		if (url.protocol !== "https:" || url.pathname.replace(/\/+$/u, "") !== "/api/event") throw new Error("Plausible endpoint must be HTTPS /api/event");
		if (url.username !== "" || url.password !== "" || hasQuery || hasFragment) throw new Error("Telemetry endpoint must not contain credentials, query parameters, or a fragment");
		return url.toString();
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) throw new Error("Telemetry endpoint must use HTTPS unless it targets loopback");
	if (url.username !== "" || url.password !== "" || hasQuery || hasFragment) throw new Error("Telemetry endpoint must not contain credentials, query parameters, or a fragment");
	const path = url.pathname.replace(/\/+$/u, "");
	url.pathname = path.endsWith("/v1/events") ? path : `${path}/v1/events`;
	return url.toString();
}
function sendJSON(res, status, value, extra = {}) {
	res.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"x-content-type-options": "nosniff",
		...extra
	});
	res.end(JSON.stringify(value));
}
function sendEmpty(res, status, extra = {}) {
	res.writeHead(status, {
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		...extra
	});
	res.end();
}
function isJSON(header) {
	return typeof header === "string" && header.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		const cleanup = () => {
			req.off("data", data);
			req.off("end", end);
			req.off("error", error);
			req.off("aborted", aborted);
		};
		const data = (chunk) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.byteLength;
			if (size > 512) {
				cleanup();
				req.resume();
				reject(new BodyTooLargeError());
				return;
			}
			chunks.push(buffer);
		};
		const end = () => {
			cleanup();
			resolve(Buffer.concat(chunks, size));
		};
		const error = (cause) => {
			cleanup();
			reject(cause);
		};
		const aborted = () => {
			cleanup();
			reject(new DOMException("Aborted", "AbortError"));
		};
		req.on("data", data);
		req.once("end", end);
		req.once("error", error);
		req.once("aborted", aborted);
	});
}
function parseEvent(body) {
	let value;
	try {
		value = JSON.parse(body.toString("utf8"));
	} catch {
		throw new Error("invalid_json");
	}
	if (!isRecord$1(value)) throw new Error("invalid_payload");
	const allowed = new Set([
		"schema_version",
		"event",
		"daily_id",
		"value"
	]);
	if (Object.keys(value).some((key) => !allowed.has(key)) || value.schema_version !== 1 || typeof value.event !== "string" || !EVENTS.has(value.event) || typeof value.daily_id !== "string" || !DAILY_ID.test(value.daily_id) || value.value !== void 0 && typeof value.value !== "string") throw new Error("invalid_payload");
	if (Buffer.from(value.daily_id, "base64url").byteLength !== 16 || Buffer.from(value.daily_id, "base64url").toString("base64url") !== value.daily_id) throw new Error("invalid_payload");
	const event = value.event;
	if (event === "detector_used") {
		if (typeof value.value !== "string" || !DETECTORS.has(value.value)) throw new Error("invalid_payload");
		return {
			schema_version: 1,
			event,
			daily_id: value.daily_id,
			value: value.value
		};
	}
	if (value.value !== void 0) throw new Error("invalid_payload");
	return {
		schema_version: 1,
		event,
		daily_id: value.daily_id
	};
}
function createTelemetryHandlers(config, internals = { fetch }) {
	const provider = config.provider ?? "zeroclave";
	const site = config.site ?? "zeroclave-dsh-privacy";
	let endpoint;
	if (config.enabled && (provider !== "plausible" || PLAUSIBLE_SITE.test(site)) && VERSION.test(config.pluginVersion)) try {
		endpoint = telemetryURL(config.endpoint, provider);
	} catch {
		endpoint = void 0;
	}
	const destination = endpoint === void 0 ? void 0 : provider === "plausible" ? {
		provider,
		endpoint,
		site
	} : {
		provider,
		endpoint
	};
	const active = destination !== void 0;
	return {
		active,
		config: (req, res) => {
			req.resume();
			if (req.method !== "GET") {
				sendJSON(res, 405, { error: {
					code: "method_not_allowed",
					message: "Use GET for this endpoint"
				} }, { allow: "GET" });
				return;
			}
			sendJSON(res, 200, {
				enabled: active,
				...active && destination?.provider === "plausible" ? {
					provider: "plausible",
					endpoint: destination.endpoint,
					site: destination.site
				} : {}
			});
		},
		events: async (req, res) => {
			if (req.method !== "POST") {
				req.resume();
				sendJSON(res, 405, { error: {
					code: "method_not_allowed",
					message: "Use POST for this endpoint"
				} }, { allow: "POST" });
				return;
			}
			if (destination === void 0) {
				req.resume();
				sendEmpty(res, 204);
				return;
			}
			if (!isJSON(req.headers["content-type"]) || req.headers["content-encoding"] !== void 0 && req.headers["content-encoding"] !== "identity") {
				req.resume();
				sendJSON(res, 415, { error: {
					code: "unsupported_media_type",
					message: "Use uncompressed JSON"
				} });
				return;
			}
			const declared = req.headers["content-length"];
			if (typeof declared === "string" && /^\d+$/u.test(declared) && Number(declared) > 512) {
				req.resume();
				sendJSON(res, 413, { error: {
					code: "payload_too_large",
					message: "Telemetry payload is too large"
				} });
				return;
			}
			let event;
			try {
				event = parseEvent(await readBody(req));
			} catch (error) {
				if (req.destroyed || res.destroyed || error instanceof DOMException && error.name === "AbortError") return;
				if (error instanceof BodyTooLargeError) {
					sendJSON(res, 413, { error: {
						code: "payload_too_large",
						message: "Telemetry payload is too large"
					} });
					return;
				}
				const code = error instanceof Error && error.message === "invalid_json" ? "invalid_json" : "invalid_payload";
				sendJSON(res, code === "invalid_json" ? 400 : 422, { error: {
					code,
					message: "Telemetry payload is invalid"
				} });
				return;
			}
			const outbound = destination.provider === "plausible" ? JSON.stringify({
				domain: destination.site,
				name: event.event === "detector_used" ? `detector_used_${event.value}` : event.event,
				url: "app://zeroclave-dsh-privacy/"
			}) : JSON.stringify({
				schema_version: 1,
				product: "zeroclave-dsh-privacy",
				event: event.event,
				daily_id: event.daily_id,
				plugin_version: config.pluginVersion,
				...event.event === "detector_used" ? { value: event.value } : {}
			});
			const headers = { "content-type": "application/json" };
			if (destination.provider === "plausible") headers["user-agent"] = "ZeroClave-Telemetry/0.1";
			const controller = new AbortController();
			let timedOut = false;
			let disconnected = false;
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, config.timeoutMs);
			const close = () => {
				if (res.writableEnded) return;
				disconnected = true;
				controller.abort();
			};
			res.once("close", close);
			try {
				const response = await internals.fetch(destination.endpoint, {
					method: "POST",
					redirect: "manual",
					headers,
					body: outbound,
					signal: controller.signal
				});
				await response.body?.cancel().catch(() => void 0);
				if (res.destroyed) return;
				if (response.status === 202) {
					sendEmpty(res, 204);
					return;
				}
				const retryAfter = response.headers.get("retry-after");
				if (response.status === 429) {
					sendEmpty(res, 429, retryAfter === null ? {} : { "retry-after": retryAfter });
					return;
				}
				sendJSON(res, 503, { error: {
					code: "telemetry_unavailable",
					message: "Telemetry is unavailable"
				} });
			} catch {
				const clientDisconnected = () => disconnected || res.destroyed;
				const requestTimedOut = () => timedOut;
				if (clientDisconnected()) return;
				sendJSON(res, requestTimedOut() ? 504 : 503, { error: {
					code: requestTimedOut() ? "telemetry_timeout" : "telemetry_unavailable",
					message: "Telemetry is unavailable"
				} });
			} finally {
				clearTimeout(timer);
				res.off("close", close);
			}
		}
	};
}
//#endregion
//#region lib/types/detector.js
const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gu;
const PHONE = /(?:^|[^\d])(1[3-9]\d{9})(?!\d)/gu;
const API_KEY = /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"]?([a-z0-9_.-]{20,})['"]?/giu;
const KNOWN_TOKEN = /\b((?:sk|rk|pk)-(?:proj-)?[a-zA-Z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[a-zA-Z0-9]{20,})\b/gu;
const PASSWORD = /(?:password|passwd|pwd|密码)\s*[:=：]\s*['"]?([^\s'";,]{8,})['"]?/giu;
const PRIVATE_KEY = /-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----[\s\S]+?-----END \1-----/gu;
const NATIONAL_ID = /(?:身份证(?:号(?:码)?)?|公民身份号码)\s*[:：]?\s*([1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])/gu;
const CREDIT_CODE = /(?:统一社会信用代码|信用代码)\s*[:：]\s*([0-9A-HJ-NPQRTUWXY]{18})/giu;
const PERSON = /(?:联系人(?:\/授权代表)?|授权代表|经办人|法定代表人)\s*[:：]\s*([^\s,，;；]{2,32})/gu;
const ORGANIZATION = /(?:甲方(?:（买方）|\(买方\))?|乙方(?:（卖方）|\(卖方\))?|公司名称|单位名称)\s*[:：]\s*([^\r\n]{2,100})/gu;
const ADDRESS = /(?:通讯地址|通信地址|联系地址|签署地点|注册地址|收货地址)\s*[:：]\s*([^\r\n]{4,160})/gu;
const BANK_ACCOUNT = /(?:银行账号|银行账户|银行卡号|收款账号)\s*[:：]\s*([\d -]{12,32})/gu;
const BANK_NAME = /(?:开户银行|开户行)\s*[:：]\s*([^\r\n]{2,100})/gu;
const CONTRACT_ID = /(?:合同编号|协议编号)\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9._/-]{3,80})/gu;
const DATE_TIME = /(?:签署日期|签订日期|出生日期)\s*[:：]\s*([^\r\n]{4,40})/gu;
const FINANCIAL = /(?:合同含税金额|合同金额|交易金额|付款金额)\s*[:：]\s*([^\r\n]{2,60})/gu;
const IP_ADDRESS = /(?:^|[^\d])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?!\d)/gu;
const CREDIT_CARD = /(?:^|[^\d])((?:\d[ -]?){12,18}\d)(?!\d)/gu;
const IBAN = /\b([A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30})\b/giu;
const KYC = /\bKYC\b|客户资料|客戶資料|尽职调查|盡職調查/iu;
const PLACEHOLDER = /ZCPII-[A-Z][A-Z0-9_]*-[a-f0-9]{32}|__PII_[A-Z][A-Z0-9_]*_\d{8}__/gu;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(void 0, { granularity: "grapheme" });
function graphemeCount(value) {
	return Array.from(GRAPHEME_SEGMENTER.segment(value)).length;
}
function maskPerson(value) {
	const graphemes = Array.from(GRAPHEME_SEGMENTER.segment(value), (segment) => segment.segment);
	return `${graphemes[0] ?? ""}${"*".repeat(Math.max(1, graphemes.length - 1))}`;
}
function maskEmail(value) {
	const at = value.lastIndexOf("@");
	return at <= 0 ? "[REDACTED_EMAIL]" : `${value.slice(0, 1)}***${value.slice(at)}`;
}
function maskTail(value, visible = 4) {
	const compact = value.replace(/[ -]/g, "");
	return compact.length <= visible ? "*".repeat(compact.length) : `${"*".repeat(Math.min(12, compact.length - visible))}${compact.slice(-visible)}`;
}
function maskLabel(label) {
	return (value) => `[REDACTED_${label}:${String(graphemeCount(value))}]`;
}
function passesLuhn(value) {
	const digits = value.replace(/[ -]/gu, "");
	if (!/^\d{13,19}$/u.test(digits)) return false;
	let sum = 0;
	let double = false;
	for (let index = digits.length - 1; index >= 0; index -= 1) {
		let digit = Number(digits[index]);
		if (double) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		double = !double;
	}
	return sum % 10 === 0;
}
function passesIbanChecksum(value) {
	const compact = value.replace(/\s/gu, "").toUpperCase();
	if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(compact)) return false;
	const rearranged = compact.slice(4) + compact.slice(0, 4);
	let remainder = 0;
	for (const character of rearranged) {
		const expanded = /\d/u.test(character) ? character : String(character.charCodeAt(0) - 55);
		for (const digit of expanded) remainder = (remainder * 10 + Number(digit)) % 97;
	}
	return remainder === 1;
}
const RULES = [
	{
		regex: API_KEY,
		capture: 1,
		category: "SECRET",
		entityType: "API_KEY",
		severity: "critical",
		mask: () => "[REDACTED_API_KEY]"
	},
	{
		regex: KNOWN_TOKEN,
		capture: 1,
		category: "SECRET",
		entityType: "API_KEY",
		severity: "critical",
		mask: () => "[REDACTED_API_KEY]"
	},
	{
		regex: PASSWORD,
		capture: 1,
		category: "SECRET",
		entityType: "PASSWORD",
		severity: "critical",
		mask: () => "[REDACTED_PASSWORD]"
	},
	{
		regex: PRIVATE_KEY,
		category: "SECRET",
		entityType: "PRIVATE_KEY",
		severity: "critical",
		mask: () => "[REDACTED_PRIVATE_KEY]"
	},
	{
		regex: NATIONAL_ID,
		capture: 1,
		category: "DIRECT_PII",
		entityType: "NATIONAL_ID",
		severity: "critical",
		mask: (value) => `${value.slice(0, 3)}***********${value.slice(-4)}`
	},
	{
		regex: CREDIT_CODE,
		capture: 1,
		category: "BUSINESS",
		entityType: "CREDIT_CODE",
		severity: "high",
		mask: (value) => `${value.slice(0, 4)}**********${value.slice(-4)}`
	},
	{
		regex: BANK_ACCOUNT,
		capture: 1,
		category: "FINANCIAL",
		entityType: "BANK_ACCOUNT",
		severity: "critical",
		mask: (value) => maskTail(value)
	},
	{
		regex: CREDIT_CARD,
		capture: 1,
		category: "FINANCIAL",
		entityType: "CREDIT_CARD",
		severity: "critical",
		mask: (value) => maskTail(value),
		validate: passesLuhn
	},
	{
		regex: IBAN,
		capture: 1,
		category: "FINANCIAL",
		entityType: "IBAN_CODE",
		severity: "critical",
		mask: (value) => maskTail(value),
		validate: passesIbanChecksum
	},
	{
		regex: EMAIL,
		category: "DIRECT_PII",
		entityType: "EMAIL",
		severity: "high",
		mask: maskEmail
	},
	{
		regex: PHONE,
		capture: 1,
		category: "DIRECT_PII",
		entityType: "PHONE",
		severity: "high",
		mask: (value) => `${value.slice(0, 3)}****${value.slice(-4)}`
	},
	{
		regex: PERSON,
		capture: 1,
		category: "DIRECT_PII",
		entityType: "PERSON",
		severity: "high",
		mask: maskPerson
	},
	{
		regex: ADDRESS,
		capture: 1,
		category: "DIRECT_PII",
		entityType: "ADDRESS",
		severity: "high",
		mask: maskLabel("ADDRESS")
	},
	{
		regex: ORGANIZATION,
		capture: 1,
		category: "BUSINESS",
		entityType: "ORGANIZATION",
		severity: "medium",
		mask: maskLabel("ORGANIZATION")
	},
	{
		regex: BANK_NAME,
		capture: 1,
		category: "FINANCIAL",
		entityType: "BANK_NAME",
		severity: "medium",
		mask: maskLabel("BANK_NAME")
	},
	{
		regex: CONTRACT_ID,
		capture: 1,
		category: "BUSINESS",
		entityType: "CONTRACT_ID",
		severity: "medium",
		mask: (value) => `${value.slice(0, 2)}***${value.slice(-2)}`
	},
	{
		regex: DATE_TIME,
		capture: 1,
		category: "DIRECT_PII",
		entityType: "DATE_TIME",
		severity: "medium",
		mask: () => "[REDACTED_DATE]"
	},
	{
		regex: FINANCIAL,
		capture: 1,
		category: "FINANCIAL",
		entityType: "FINANCIAL",
		severity: "high",
		mask: () => "[REDACTED_AMOUNT]"
	},
	{
		regex: IP_ADDRESS,
		capture: 1,
		category: "DIRECT_PII",
		entityType: "IP_ADDRESS",
		severity: "medium",
		mask: (value) => `${value.split(".").slice(0, 2).join(".")}.*.*`
	}
];
const RULE_NAMES = [
	"API key field",
	"Known token",
	"Password field",
	"PEM private key",
	"Chinese national ID",
	"Social credit code",
	"Bank account",
	"Payment card",
	"IBAN",
	"Email address",
	"Mainland China phone",
	"Named person",
	"Labeled address",
	"Contract party",
	"Bank name",
	"Contract ID",
	"Labeled date",
	"Financial amount",
	"IPv4 address"
];
const DEFAULT_REGEX_RULES = RULES.map((rule, index) => ({
	id: `builtin-${String(index)}`,
	name: RULE_NAMES[index] ?? rule.entityType,
	pattern: rule.regex.source,
	flags: rule.regex.flags.replace("g", ""),
	capture: rule.capture ?? 0,
	entityType: rule.entityType,
	category: rule.category,
	severity: rule.severity,
	enabled: true
}));
function isDefaultPattern(rule) {
	const original = DEFAULT_REGEX_RULES.find((item) => item.id === rule.id);
	return original?.pattern === rule.pattern && original.flags === rule.flags && original.capture === rule.capture;
}
function addRuleMatches(candidates, text, rule, attribution) {
	rule.regex.lastIndex = 0;
	let match;
	while ((match = rule.regex.exec(text)) !== null) {
		const evidence = match[rule.capture ?? 0];
		if (evidence === void 0 || evidence.length === 0) continue;
		if (rule.validate?.(evidence) === false) continue;
		const relativeStart = rule.capture === void 0 ? 0 : match[0].lastIndexOf(evidence);
		const start = match.index + relativeStart;
		candidates.push({
			category: rule.category,
			entityType: rule.entityType,
			start,
			end: start + evidence.length,
			maskedEvidence: rule.mask(evidence),
			confidence: .99,
			severity: rule.severity,
			detector: "regex",
			...attribution === void 0 ? {} : {
				ruleId: attribution.id,
				ruleName: attribution.name
			}
		});
	}
}
function overlaps(left, right) {
	return left.start < right.end && right.start < left.end;
}
function severityRank(value) {
	return {
		medium: 1,
		high: 2,
		critical: 3
	}[value];
}
function finalizeScan(text, candidates, requested, used, fallback, model) {
	const protectedSpans = Array.from(text.matchAll(PLACEHOLDER), (match) => ({
		start: match.index,
		end: match.index + match[0].length
	}));
	const selected = [];
	for (const candidate of candidates.filter((candidate) => !protectedSpans.some((span) => overlaps(span, candidate))).sort((left, right) => left.start - right.start || severityRank(right.severity) - severityRank(left.severity) || right.end - right.start - (left.end - left.start) || (left.detector === "regex" ? -1 : 1))) {
		const previous = selected.at(-1);
		if (previous === void 0 || !overlaps(previous, candidate)) selected.push({ ...candidate });
		else if (candidate.end > previous.end) {
			previous.end = candidate.end;
			previous.maskedEvidence = `[REDACTED_${previous.entityType}]`;
			if (severityRank(candidate.severity) > severityRank(previous.severity)) previous.severity = candidate.severity;
		}
	}
	const replacements = /* @__PURE__ */ new Map();
	const findings = selected.map((candidate, index) => {
		const evidence = text.slice(candidate.start, candidate.end);
		const key = `${candidate.entityType}\u0000${evidence}`;
		let replacement = replacements.get(key);
		if (replacement === void 0) {
			replacement = `__PII_${candidate.entityType}_${String(replacements.size + 1).padStart(8, "0")}__`;
			replacements.set(key, replacement);
		}
		return {
			...candidate,
			id: `f_${String(index + 1).padStart(3, "0")}`,
			replacement
		};
	});
	const redactedText = [...findings].sort((left, right) => right.start - left.start).reduce((value, finding) => value.slice(0, finding.start) + finding.replacement + value.slice(finding.end), text);
	const hasKyc = KYC.test(text);
	const overallRisk = findings.some((item) => item.severity === "critical") ? "critical" : findings.some((item) => item.severity === "high") || hasKyc ? "high" : findings.length > 0 ? "medium" : "none";
	return {
		overallRisk,
		recommendedAction: overallRisk === "critical" ? "block" : findings.length > 0 ? "redact" : "allow",
		redactedText,
		findings,
		policySignals: hasKyc ? [{
			policyId: "CUSTOMER_KYC",
			severity: "high"
		}] : [],
		detector: {
			requested,
			used,
			fallback,
			...model === void 0 ? {} : { model }
		}
	};
}
function regexCandidates(text, rules = DEFAULT_REGEX_RULES) {
	const candidates = [];
	for (const rule of rules) {
		if (!rule.enabled || !isDefaultPattern(rule)) continue;
		const builtin = RULES[DEFAULT_REGEX_RULES.findIndex((item) => item.id === rule.id)];
		if (builtin !== void 0) addRuleMatches(candidates, text, {
			...builtin,
			entityType: rule.entityType,
			category: rule.category,
			severity: rule.severity
		}, rule);
	}
	return candidates;
}
function scanRegex(text, requested = "regex", rules = DEFAULT_REGEX_RULES) {
	return finalizeScan(text, regexCandidates(text, rules), requested, "regex", requested !== "regex");
}
var RegexDetector = class {
	id = "regex";
	label = "Local regex rules";
	locality = "browser";
	available() {
		return true;
	}
	scan(text) {
		return Promise.resolve(scanRegex(text));
	}
};
//#endregion
//#region lib/types/zeroclave-detector.js
const ZEROCLAVE_PROXY_PATH = "/api/zeroclave-privacy/detect";
const MAX_TEXTS = 64;
const MAX_CODEPOINTS = 1e5;
const MAX_RESPONSE_BYTES = 1048576;
const MAX_TOTAL_MS = 35e3;
const RETRYABLE_STATUS = new Set([
	429,
	503,
	504
]);
const CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const REQUEST_ID = /^[A-Za-z0-9_.-]{1,64}$/u;
const ENTITY_TYPE = /^[A-Z][A-Z0-9_]*$/u;
function randomUUID$1() {
	return globalThis.crypto.randomUUID();
}
var ZeroClaveDetectError = class extends Error {
	code;
	status;
	requestId;
	constructor(code, message, status, requestId) {
		super(message);
		this.code = code;
		this.status = status;
		this.requestId = requestId;
		this.name = "ZeroClaveDetectError";
	}
};
function abortError() {
	return new DOMException("The operation was aborted", "AbortError");
}
function defaultWait(milliseconds, signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortError());
			return;
		}
		const finish = () => {
			signal.removeEventListener("abort", cancel);
			resolve();
		};
		const timer = setTimeout(finish, milliseconds);
		const cancel = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			reject(abortError());
		};
		signal.addEventListener("abort", cancel, { once: true });
	});
}
function normalizeEndpoint(value) {
	if (value === "/api/zeroclave-privacy/detect") return value;
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new ZeroClaveDetectError("invalid_endpoint", "Enter a valid ZeroClave endpoint URL");
	}
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
	if (url.protocol !== "https:" && !(loopback && url.protocol === "http:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || value.length > 2048) throw new ZeroClaveDetectError("invalid_endpoint", "Use an HTTPS URL without credentials, query, or fragment");
	const path = url.pathname.replace(/\/+$/u, "");
	url.pathname = path.endsWith("/v1/pii/detect") ? path : path.endsWith("/v1") ? `${path}/pii/detect` : `${path}/v1/pii/detect`;
	return url.toString();
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseEntity(value) {
	if (!isRecord(value) || typeof value.start !== "number" || !Number.isInteger(value.start) || typeof value.end !== "number" || !Number.isInteger(value.end) || typeof value.type !== "string" || !ENTITY_TYPE.test(value.type)) throw new ZeroClaveDetectError("detector_response_invalid", "ZeroClave returned an invalid entity");
	return {
		start: value.start,
		end: value.end,
		type: value.type
	};
}
function parseResult(value) {
	if (!isRecord(value) || typeof value.id !== "string" || value.revision !== void 0 && typeof value.revision !== "string" || value.status !== "complete" && value.status !== "partial" || !Array.isArray(value.entities)) throw new ZeroClaveDetectError("detector_response_invalid", "ZeroClave returned an invalid result");
	return {
		id: value.id,
		...value.revision === void 0 ? {} : { revision: value.revision },
		status: value.status,
		entities: value.entities.map(parseEntity)
	};
}
function parseResponse(value) {
	if (!isRecord(value) || typeof value.request_id !== "string" || !REQUEST_ID.test(value.request_id) || typeof value.model_version !== "string" || !Array.isArray(value.results)) throw new ZeroClaveDetectError("detector_response_invalid", "ZeroClave returned an invalid response");
	return {
		request_id: value.request_id,
		model_version: value.model_version,
		results: value.results.map(parseResult)
	};
}
function parseErrorResponse(value, status, requestId) {
	if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string" || value.request_id !== void 0 && (typeof value.request_id !== "string" || !REQUEST_ID.test(value.request_id))) throw new ZeroClaveDetectError("invalid_response", "ZeroClave returned an invalid error response", status, requestId);
	return {
		...value.request_id === void 0 ? {} : { request_id: value.request_id },
		error: {
			code: value.error.code,
			message: value.error.message
		}
	};
}
function codepointBoundaries(text) {
	const boundaries = [0];
	let codeUnit = 0;
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		if (unit >= 55296 && unit <= 56319) {
			const next = text.charCodeAt(index + 1);
			if (!(next >= 56320 && next <= 57343)) throw new ZeroClaveDetectError("invalid_request", "Text contains an isolated UTF-16 surrogate");
			index += 1;
			codeUnit += 2;
		} else {
			if (unit >= 56320 && unit <= 57343) throw new ZeroClaveDetectError("invalid_request", "Text contains an isolated UTF-16 surrogate");
			codeUnit += 1;
		}
		boundaries.push(codeUnit);
	}
	return boundaries;
}
function validateInputs(inputs) {
	if (inputs.length < 1) throw new ZeroClaveDetectError("invalid_request", "At least one text is required");
	if (inputs.length > MAX_TEXTS) throw new ZeroClaveDetectError("too_many_texts", "Send no more than 64 texts at once");
	const seen = /* @__PURE__ */ new Set();
	const boundaries = /* @__PURE__ */ new Map();
	let total = 0;
	for (const input of inputs) {
		if (!CORRELATION_ID.test(input.id) || !CORRELATION_ID.test(input.revision) || seen.has(input.id)) throw new ZeroClaveDetectError("invalid_request", "Text IDs and revisions must be valid and unique");
		seen.add(input.id);
		const itemBoundaries = codepointBoundaries(input.text);
		total += itemBoundaries.length - 1;
		boundaries.set(input.id, itemBoundaries);
	}
	if (total > MAX_CODEPOINTS) throw new ZeroClaveDetectError("request_too_large", "Reduce the total text size to 100,000 codepoints");
	return boundaries;
}
function entityType(type) {
	return {
		AGE: "AGE",
		DATETIME: "DATE_TIME",
		DATE_TIME: "DATE_TIME",
		FINANCE: "FINANCIAL",
		LOCATION: "ADDRESS",
		NAME: "PERSON",
		PERSON: "PERSON",
		ORGANIZATION: "ORGANIZATION",
		EMAIL: "EMAIL",
		PHONE: "PHONE"
	}[type] ?? "OTHER";
}
function category(type) {
	if (type === "FINANCE") return "FINANCIAL";
	if (type === "ORGANIZATION" || type === "OCCUPATION" || type === "EDUCATION" || type === "CODE") return "BUSINESS";
	return "DIRECT_PII";
}
function severity(type) {
	if (type === "BELIEF" || type === "HEALTH" || type === "SEXUAL_ORIENTATION") return "critical";
	if (type === "NAME" || type === "PERSON" || type === "EMAIL" || type === "PHONE" || type === "LOCATION" || type === "FINANCE" || type === "DEMOGRAPHIC") return "high";
	return "medium";
}
function entityCandidates(entities, boundaries) {
	return entities.map((entity) => {
		const start = boundaries[entity.start];
		const end = boundaries[entity.end];
		if (start === void 0 || end === void 0 || entity.start < 0 || entity.end <= entity.start) throw new ZeroClaveDetectError("detector_response_invalid", "ZeroClave returned an invalid entity range");
		return {
			start,
			end,
			category: category(entity.type),
			entityType: entityType(entity.type),
			maskedEvidence: `[REDACTED_${entity.type}:${String(entity.end - entity.start)}]`,
			severity: severity(entity.type),
			detector: "zeroclave",
			sourceType: entity.type
		};
	});
}
function retryAfter(response, attempt, random, now) {
	const header = response.headers.get("retry-after");
	if (header !== null) {
		const seconds = Number(header);
		const base = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1e3 : Math.max(0, Date.parse(header) - now());
		if (Number.isFinite(base)) return base + random() * 100;
	}
	return Math.min(2e3, 250 * 2 ** attempt) * (.75 + random() * .5);
}
async function responseJSON(response, requestId) {
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new ZeroClaveDetectError("detector_response_invalid", "ZeroClave response is too large", response.status, requestId);
	const text = await response.text();
	if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new ZeroClaveDetectError("detector_response_invalid", "ZeroClave response is too large", response.status, requestId);
	try {
		return JSON.parse(text);
	} catch {
		throw new ZeroClaveDetectError("invalid_response", "ZeroClave returned a non-JSON response", response.status, requestId);
	}
}
var ZeroClaveDetector = class {
	timeoutMs;
	retries;
	id = "zeroclave";
	label = "ZeroClave API";
	locality = "remote";
	endpoint;
	internals;
	constructor(endpoint = ZEROCLAVE_PROXY_PATH, timeoutMs = MAX_TOTAL_MS, retries = 2, internals = {
		fetch,
		wait: defaultWait,
		random: Math.random
	}) {
		this.timeoutMs = timeoutMs;
		this.retries = retries;
		this.endpoint = normalizeEndpoint(endpoint);
		this.internals = {
			...internals,
			now: internals.now ?? Date.now
		};
	}
	configure(endpoint) {
		this.endpoint = normalizeEndpoint(endpoint);
	}
	get endpointURL() {
		return this.endpoint;
	}
	available() {
		return this.endpoint !== "";
	}
	async scan(text, signal) {
		const [result] = await this.scanBatch([{
			id: "text-0",
			revision: `r-${randomUUID$1()}`,
			text,
			regex: []
		}], signal);
		if (result === void 0) throw new ZeroClaveDetectError("detector_response_invalid", "ZeroClave result is missing");
		return result;
	}
	async scanBatch(inputs, signal) {
		const boundaries = validateInputs(inputs);
		const fetchImpl = this.internals.fetch;
		const callerSignal = signal ?? new AbortController().signal;
		callerSignal.throwIfAborted();
		const requestId = `dsh-${randomUUID$1()}`;
		const startedAt = this.internals.now();
		let response;
		let transportError;
		for (let attempt = 0; attempt <= this.retries; attempt += 1) {
			callerSignal.throwIfAborted();
			const remaining = MAX_TOTAL_MS - (this.internals.now() - startedAt);
			if (remaining <= 0) break;
			const timeout = AbortSignal.timeout(Math.max(1, Math.min(this.timeoutMs, remaining)));
			try {
				response = await fetchImpl(this.endpoint, {
					method: "POST",
					...this.endpoint.startsWith("/") ? {} : { mode: "cors" },
					credentials: this.endpoint.startsWith("/") ? "same-origin" : "omit",
					cache: "no-store",
					referrerPolicy: "no-referrer",
					headers: {
						"content-type": "application/json",
						"x-request-id": requestId
					},
					body: JSON.stringify({ texts: inputs.map(({ id, revision, text }) => ({
						id,
						revision,
						text
					})) }),
					signal: AbortSignal.any([callerSignal, timeout])
				});
				transportError = void 0;
			} catch {
				if (callerSignal.aborted) throw abortError();
				transportError = timeout.aborted ? new ZeroClaveDetectError("detector_timeout", "ZeroClave request timed out", 504, requestId) : new ZeroClaveDetectError("network_error", "ZeroClave could not be reached", void 0, requestId);
				if (attempt === this.retries) throw transportError;
				const delay = retryAfter(new Response(null, { status: 503 }), attempt, this.internals.random, this.internals.now);
				if (delay > MAX_TOTAL_MS - (this.internals.now() - startedAt)) throw transportError;
				await this.internals.wait(delay, callerSignal);
				continue;
			}
			if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt === this.retries) break;
			const delay = retryAfter(response, attempt, this.internals.random, this.internals.now);
			if (delay > MAX_TOTAL_MS - (this.internals.now() - startedAt)) break;
			await response.body?.cancel().catch(() => void 0);
			await this.internals.wait(delay, callerSignal);
			response = void 0;
		}
		if (response === void 0) throw transportError ?? new ZeroClaveDetectError("detector_timeout", "ZeroClave retry budget was exhausted", 504, requestId);
		const body = await responseJSON(response, requestId);
		if (!response.ok) {
			const failure = parseErrorResponse(body, response.status, requestId);
			const responseHeaderId = response.headers.get("x-request-id");
			if (failure.request_id !== void 0 && failure.request_id !== requestId || responseHeaderId !== null && responseHeaderId !== requestId) throw new ZeroClaveDetectError("detector_response_invalid", "ZeroClave error response correlation failed", 502, requestId);
			throw new ZeroClaveDetectError(failure.error.code, failure.error.message, response.status, requestId);
		}
		const parsed = parseResponse(body);
		const responseHeaderId = response.headers.get("x-request-id");
		if (parsed.request_id !== requestId || responseHeaderId !== null && responseHeaderId !== parsed.request_id || parsed.results.length !== inputs.length) throw new ZeroClaveDetectError("detector_response_invalid", "ZeroClave response correlation failed", 502, parsed.request_id);
		const byId = new Map(parsed.results.map((result) => [result.id, result]));
		if (byId.size !== parsed.results.length) throw new ZeroClaveDetectError("detector_response_invalid", "ZeroClave returned duplicate result IDs", 502, parsed.request_id);
		return inputs.map((input) => {
			const result = byId.get(input.id);
			const itemBoundaries = boundaries.get(input.id);
			if (result === void 0 || itemBoundaries === void 0 || result.revision !== input.revision) throw new ZeroClaveDetectError("detector_response_invalid", "ZeroClave returned a stale or missing revision", 502, parsed.request_id);
			const finalized = finalizeScan(input.text, [...input.regex, ...entityCandidates(result.entities, itemBoundaries)], "zeroclave", "zeroclave", false, parsed.model_version);
			return {
				...finalized,
				...result.status === "partial" ? { recommendedAction: "block" } : {},
				detector: {
					...finalized.detector,
					status: result.status,
					requestId: parsed.request_id
				}
			};
		});
	}
};
//#endregion
//#region lib/types/index.js
const { version } = createRequire(import.meta.url)("../package.json");
const name = "zeroclave-privacy";
const inject = ["webServer"];
const Config = Schema.object({
	gatewayBaseURL: Schema.string().default("https://zeroclave.com/v1"),
	timeoutMs: Schema.number().min(100).max(3e4).default(15e3),
	telemetryProvider: Schema.union(["zeroclave", "plausible"]).default("zeroclave"),
	telemetryEnabled: Schema.boolean().default(false),
	telemetryEndpoint: Schema.string().default("https://telemetry.zeroclave.ai"),
	telemetrySite: Schema.string().min(1).max(128).default("zeroclave-dsh-privacy"),
	telemetryTimeoutMs: Schema.number().min(100).max(1e4).default(2e3)
});
function apply(ctx, config) {
	const handler = createDetectProxyHandler(config);
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ZEROCLAVE_DETECT_PROXY_PATH,
		handler
	}), "zeroclave-privacy: anonymous detection proxy");
	const telemetry = createTelemetryHandlers({
		enabled: config.telemetryEnabled,
		provider: config.telemetryProvider,
		site: config.telemetrySite,
		endpoint: config.telemetryEndpoint,
		timeoutMs: config.telemetryTimeoutMs,
		pluginVersion: version
	});
	if (config.telemetryEnabled && !telemetry.active) ctx.logger.warn("zeroclave-privacy: telemetry is enabled but its Host configuration is invalid");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: TELEMETRY_CONFIG_PATH,
		handler: telemetry.config
	}), "zeroclave-privacy: telemetry availability");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: TELEMETRY_EVENTS_PATH,
		handler: telemetry.events
	}), "zeroclave-privacy: telemetry relay");
}
//#endregion
export { Config, RegexDetector, ZEROCLAVE_PROXY_PATH, ZeroClaveDetectError, ZeroClaveDetector, apply, inject, name, scanRegex };
