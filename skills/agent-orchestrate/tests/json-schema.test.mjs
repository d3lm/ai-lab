/**
 * These tests pin the semantics where a hand-written validator tends to go wrong, namely
 * inherited properties, type boundaries, code-point lengths, structural equality, recursive
 * references, and keywords the validator does not support, which must fail compilation
 * instead of accepting every value.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { GENERIC_RESULT_SCHEMA, SCHEMA_DIR } from '../scripts/lib/contracts.mjs';
import { SchemaError, compileSchema } from '../scripts/lib/json-schema.mjs';
import { claudeProfile, codexProfile } from './helpers.mjs';

const errorsOf = (schema, value) => compileSchema(schema)(value);
const isValid = (schema, value) => errorsOf(schema, value).length === 0;
const messages = (schema, value) => errorsOf(schema, value).map((error) => `${error.instancePath} ${error.message}`);

function assertCompileError(schema, pattern) {
  assert.throws(
    () => compileSchema(schema),
    (error) => error instanceof SchemaError && pattern.test(error.message),
    `expected ${JSON.stringify(schema)} to fail compilation with ${pattern}`,
  );
}

test('type boundaries follow JSON, not JavaScript', () => {
  assert.equal(isValid({ type: 'integer' }, JSON.parse('1.0')), true, '1.0 is the same JSON number as 1');
  assert.equal(isValid({ type: 'integer' }, -0), true);
  assert.equal(isValid({ type: 'integer' }, 1.5), false);
  assert.equal(isValid({ type: 'number' }, Number.NaN), false, 'NaN is not a JSON number');
  assert.equal(isValid({ type: 'number' }, Number.POSITIVE_INFINITY), false);
  assert.equal(isValid({ type: 'object' }, null), false, 'typeof null is object, but null is not an object');
  assert.equal(isValid({ type: 'object' }, []), false, 'arrays are not objects');
  assert.equal(isValid({ type: 'array' }, { length: 0 }), false);
  assert.equal(isValid({ type: ['string', 'null'] }, null), true);
  assert.equal(isValid({ type: ['string', 'null'] }, 0), false);
  assert.deepEqual(messages({ type: ['string', 'null'] }, 0), [' must be string or null']);
});

test('required and properties see own properties only, never inherited ones', () => {
  // a naive `name in value` or `value[name] !== undefined` check would accept these from Object.prototype
  assert.deepEqual(messages({ required: ['constructor', 'toString'] }, {}), [
    " must have required property 'constructor'",
    " must have required property 'toString'",
  ]);

  assert.equal(isValid({ required: ['constructor'] }, JSON.parse('{"constructor": 1}')), true);

  // the inherited constructor function must not be validated as if it were a property of the value
  assert.equal(isValid({ properties: { constructor: { type: 'string' } } }, {}), true);

  // JSON.parse makes "__proto__" an own key, so it must be validated and counted like any other key
  const polluted = JSON.parse('{"__proto__": {"admin": true}}');

  assert.deepEqual(messages({ additionalProperties: false }, polluted), [
    ' must NOT have additional properties (found "__proto__")',
  ]);

  // a "__proto__" key in an object literal would set the prototype, so this schema has to come from JSON as well
  const prototypeSchema = JSON.parse('{"properties": {"__proto__": {"type": "string"}}}');

  assert.deepEqual(messages(prototypeSchema, polluted), ['/__proto__ must be string']);
  assert.equal(isValid(prototypeSchema, {}), true, 'the prototype of a plain object is not a "__proto__" property');
});

test('additionalProperties reports every undeclared key and validates extra values in schema form', () => {
  const closed = { properties: { a: {} }, additionalProperties: false };

  assert.equal(isValid(closed, { a: 1 }), true);

  assert.deepEqual(messages(closed, { a: 1, b: 2, c: 3 }), [
    ' must NOT have additional properties (found "b")',
    ' must NOT have additional properties (found "c")',
  ]);

  const typed = { properties: { name: { type: 'string' } }, additionalProperties: { type: 'integer' } };

  assert.equal(isValid(typed, { name: 'x', n: 1 }), true, 'declared properties are not checked against it');
  assert.deepEqual(messages(typed, { name: 'x', n: 'one' }), ['/n must be integer']);
});

test('all errors are reported, each with an escaped JSON pointer to the failing value', () => {
  const schema = {
    type: 'object',
    properties: {
      'a/b': { type: 'object', properties: { 'c~d': { type: 'array', items: { type: 'integer' } } } },
      plain: { type: 'string' },
    },
    required: ['missing'],
  };

  const errors = errorsOf(schema, { 'a/b': { 'c~d': [1, 'x', 2.5] }, plain: 3 });

  assert.deepEqual(
    errors.map(({ instancePath, keyword }) => [instancePath, keyword]),
    [
      ['/a~1b/c~0d/1', 'type'],
      ['/a~1b/c~0d/2', 'type'],
      ['/plain', 'type'],
      ['', 'required'],
    ],
    'errors follow the order of the keywords in the schema',
  );

  assert.equal(errors[0].schemaPath, '#/properties/a~1b/properties/c~0d/items/type');
});

test('string lengths count code points, not UTF-16 units', () => {
  assert.equal('😀'.length, 2, 'precondition: one emoji is two UTF-16 units');
  assert.equal(isValid({ maxLength: 1 }, '😀'), true);
  assert.equal(isValid({ minLength: 2 }, '😀'), false);
  assert.equal(isValid({ minLength: 2 }, '😀😀'), true);
  assert.equal(isValid({ minLength: 1 }, ''), false);
});

test('pattern searches anywhere in the string unless anchored, with unicode semantics', () => {
  assert.equal(isValid({ pattern: 'b' }, 'abc'), true, 'patterns are not implicitly anchored');
  assert.equal(isValid({ pattern: '^b' }, 'abc'), false);
  assert.equal(isValid({ pattern: '^.$' }, '😀'), true, 'with the u flag . matches a whole astral character');
  assert.equal(isValid({ pattern: String.raw`^\p{Lu}+$` }, 'ÄB'), true, 'unicode property escapes work');

  // the same compiled expression runs many times, and a stateful (global) regex would alternate results
  const validate = compileSchema({ pattern: 'a' });

  assert.deepEqual(
    [validate('a'), validate('a'), validate('a')].map((errors) => errors.length),
    [0, 0, 0],
  );
});

test('enum and const compare JSON structure: key order is irrelevant, array order and types are not', () => {
  const schema = { const: { a: 1, b: [1, { c: null }] } };

  assert.equal(isValid(schema, { b: [1, { c: null }], a: 1 }), true);
  assert.equal(isValid(schema, { a: 1, b: [{ c: null }, 1] }), false, 'array order matters');
  assert.equal(isValid(schema, { a: 1, b: [1, { c: null }], extra: 0 }), false, 'an extra key is a difference');
  assert.equal(isValid(schema, { a: '1', b: [1, { c: null }] }), false, '"1" is not 1');
  assert.equal(isValid(schema, { a: 1, b: [1, {}] }), false, 'a missing key is not the same as a null value');

  assert.equal(isValid({ enum: [1, 'two', null] }, null), true);
  assert.equal(isValid({ enum: [1, 'two', null] }, '1'), false);
  assert.equal(isValid({ enum: [1, 'two', null] }, true), false, 'true is not 1');
  assert.deepEqual(messages({ enum: ['a', 'b'] }, 'c'), [' must be one of "a", "b"']);
});

test('uniqueItems compares items structurally', () => {
  assert.deepEqual(messages({ uniqueItems: true }, [{ a: 1, b: 2 }, 'x', { b: 2, a: 1 }]), [
    ' must NOT have duplicate items (0 and 2)',
  ]);

  assert.equal(
    isValid({ uniqueItems: true }, [
      [1, 2],
      [2, 1],
    ]),
    true,
  );

  assert.equal(isValid({ uniqueItems: true }, [1, '1', true]), true);
  assert.equal(isValid({ uniqueItems: false }, [1, 1]), true);
});

test('numeric bounds treat exclusive limits as excluded and accept fractional divisors', () => {
  assert.equal(isValid({ exclusiveMinimum: 0 }, 0), false);
  assert.equal(isValid({ exclusiveMinimum: 0 }, 0.001), true);
  assert.equal(isValid({ minimum: 1 }, 1), true);
  assert.equal(isValid({ maximum: 16 }, 16), true);
  assert.equal(isValid({ exclusiveMaximum: 16 }, 16), false);
  assert.equal(isValid({ multipleOf: 0.5 }, 1.5), true);
  assert.equal(isValid({ multipleOf: 0.5 }, 1.25), false);
  assert.deepEqual(messages({ minimum: 1, maximum: 0 }, 0.5), [' must be >= 1', ' must be <= 0']);
});

test('keywords for one type ignore values of other types', () => {
  const cases = [
    [{ minLength: 5 }, 3],
    [{ pattern: '^x$' }, 42],
    [{ minimum: 10 }, 'small'],
    [{ multipleOf: 3 }, [1]],
    [{ required: ['a'] }, ['a']],
    [{ required: ['a'] }, 'a'],
    [{ additionalProperties: false }, [1, 2]],
    [{ properties: { a: { type: 'string' } } }, null],
    [{ propertyNames: { maxLength: 1 } }, 'long'],
    [{ minProperties: 3 }, []],
    [{ items: { type: 'string' } }, { 0: 1 }],
    [{ minItems: 1 }, ''],
    [{ uniqueItems: true }, { a: 1, b: 1 }],
  ];

  for (const [schema, value] of cases) {
    assert.equal(isValid(schema, value), true, `${JSON.stringify(schema)} should ignore ${JSON.stringify(value)}`);
  }
});

test('object and array size bounds count keys and elements', () => {
  assert.equal(isValid({ minProperties: 1 }, {}), false);
  assert.equal(isValid({ maxProperties: 1 }, { a: 1, b: 2 }), false);
  assert.equal(isValid({ minItems: 1, maxItems: 2 }, []), false);
  assert.equal(isValid({ minItems: 1, maxItems: 2 }, [1, 2]), true);
  assert.deepEqual(messages({ maxItems: 2 }, [1, 2, 3]), [' must have at most 2 items']);
});

test('propertyNames reports the offending name at the path of the object', () => {
  const schema = { properties: { profiles: { propertyNames: { pattern: '^[a-z]+$' } } } };

  assert.deepEqual(messages(schema, { profiles: { ok: 1, 'Not OK': 2 } }), [
    '/profiles property name "Not OK" must match pattern "^[a-z]+$"',
  ]);
});

test('anyOf passes on the first matching branch and otherwise reports what every branch rejected', () => {
  const schema = { anyOf: [{ type: 'null' }, { type: 'object', required: ['reason'] }] };

  assert.equal(isValid(schema, null), true);
  assert.equal(isValid(schema, { reason: 'x' }), true);

  assert.deepEqual(messages(schema, {}), [
    ' must be null',
    " must have required property 'reason'",
    ' must match a schema in anyOf',
  ]);
});

test('oneOf fails when no branch matches and when more than one does', () => {
  const schema = { oneOf: [{ type: 'number' }, { type: 'integer' }] };

  assert.equal(isValid(schema, 1.5), true, 'only the number branch matches');
  assert.deepEqual(messages(schema, 2), [' must match exactly one schema in oneOf (matched 0, 1)']);

  assert.deepEqual(messages(schema, 'x'), [
    ' must be number',
    ' must be integer',
    ' must match exactly one schema in oneOf',
  ]);
});

test('allOf requires every branch and not inverts its schema', () => {
  const schema = { allOf: [{ type: 'string' }, { minLength: 2 }], not: { const: 'no' } };

  assert.equal(isValid(schema, 'yes'), true);
  assert.deepEqual(messages(schema, 'no'), [' must NOT be valid']);
  assert.deepEqual(messages(schema, 'x'), [' must have at least 2 characters']);
});

test('boolean schemas: true accepts anything and false rejects any present value', () => {
  const schema = { properties: { gone: false, anything: true } };

  assert.equal(isValid(schema, {}), true, 'false only rejects a value that exists');
  assert.equal(isValid(schema, { anything: [{ deep: null }] }), true);
  assert.deepEqual(messages(schema, { gone: null }), ['/gone must not exist']);
  assert.equal(isValid(true, Symbol.for('anything')), true);
  assert.equal(isValid(false, null), false);
});

test('annotations are accepted and never constrain the value', () => {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://local/example.json',
    $comment: 'ignored',
    title: 'Example',
    description: 'ignored',
    default: 'not a number',
    examples: ['also not a number'],
    readOnly: true,
    deprecated: false,
    type: 'number',
  };

  assert.equal(isValid(schema, 1), true);
  assert.equal(isValid(schema, 'not a number'), false, 'default does not make its own value valid');
});

test('$ref resolves definitions, $defs, the root, and escaped or percent-encoded pointer tokens', () => {
  const schema = {
    definitions: { 'with space': { type: 'integer' } },
    $defs: { 'a/b': { type: 'string' }, 'm~n': { type: 'boolean' } },
    properties: {
      spaced: { $ref: '#/definitions/with%20space' },
      slashed: { $ref: '#/$defs/a~1b' },
      tilded: { $ref: '#/$defs/m~0n' },
      self: { $ref: '#' },
    },
  };

  assert.equal(isValid(schema, { spaced: 1, slashed: 's', tilded: true, self: { spaced: 2 } }), true);

  assert.deepEqual(messages(schema, { spaced: 'x', slashed: 1, tilded: 'y', self: { slashed: false } }), [
    '/spaced must be integer',
    '/slashed must be string',
    '/tilded must be boolean',
    '/self/slashed must be string',
  ]);

  assert.equal(errorsOf(schema, { spaced: 'x' })[0].schemaPath, '#/definitions/with space/type');

  // "~01" is the escaped form of the literal key "~1", and decoding ~0 before ~1 would turn it into "/"
  const literal = { $defs: { '~1': { const: 'tilde-one' }, '/': { const: 'slash' } }, $ref: '#/$defs/~01' };

  assert.equal(isValid(literal, 'tilde-one'), true);
  assert.equal(isValid(literal, 'slash'), false);

  // the target's schema path does not depend on whether $ref or definitions compiled it first
  const refFirst = {
    properties: { spaced: { $ref: '#/definitions/with%20space' } },
    definitions: { 'with space': { type: 'integer' } },
  };

  assert.equal(errorsOf(refFirst, { spaced: 'x' })[0].schemaPath, '#/definitions/with space/type');
});

test('recursive references validate deep trees and point at the failing node', () => {
  const schema = {
    $ref: '#/definitions/node',
    definitions: {
      node: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: {
          value: { type: 'integer' },
          children: { type: 'array', items: { $ref: '#/definitions/node' } },
        },
      },
    },
  };

  let tree = { value: 0 };

  for (let depth = 1; depth <= 200; depth += 1) {
    tree = { value: depth, children: [{ value: -depth }, tree] };
  }

  assert.equal(isValid(schema, tree), true);

  const broken = { value: 1, children: [{ value: 2, children: [{ value: 'three' }, { value: 4, extra: true }] }] };

  assert.deepEqual(messages(schema, broken), [
    '/children/0/children/0/value must be integer',
    '/children/0/children/1 must NOT have additional properties (found "extra")',
  ]);
});

test('keywords next to $ref still apply', () => {
  const schema = { definitions: { text: { type: 'string' } }, $ref: '#/definitions/text', maxLength: 3 };

  assert.equal(isValid(schema, 'abc'), true);
  assert.deepEqual(messages(schema, 'abcd'), [' must have at most 3 characters']);
  assert.deepEqual(messages(schema, 4), [' must be string']);
});

test('unsupported or misspelled keywords fail compilation instead of accepting every value', () => {
  // each of these would make a lenient validator silently skip a constraint the author meant to enforce
  assertCompileError({ type: 'object', requried: ['a'] }, /^#: unsupported keyword "requried"$/);
  assertCompileError({ properties: { a: { minlength: 1 } } }, /^#\/properties\/a: unsupported keyword "minlength"$/);
  assertCompileError({ type: 'string', format: 'uri' }, /unsupported keyword "format"/);
  assertCompileError({ patternProperties: { '^x': {} } }, /unsupported keyword "patternProperties"/);
  assertCompileError(JSON.parse('{"if": {"type": "string"}, "then": {"minLength": 1}}'), /unsupported keyword "if"/);
  assertCompileError({ items: [{ type: 'string' }] }, /tuple form of items is not supported/);
  assertCompileError({ $ref: 'other.json#/definitions/x' }, /only references inside the same document/);
  assertCompileError({ $ref: '#/definitions/missing' }, /reference #\/definitions\/missing does not resolve/);
  assertCompileError({ $ref: '#definitions' }, /is not a JSON pointer/);
  assertCompileError({ $ref: '#/%E0%A4%A' }, /not a valid URI fragment/);
});

test('malformed keyword values fail compilation with the path of the bad keyword', () => {
  const cases = [
    [{ type: 'str' }, /^#\/type: must be a type name/],
    [{ type: ['string', 'string'] }, /^#\/type: .*distinct/],
    [{ type: [] }, /^#\/type:/],
    [{ required: 'a' }, /^#\/required: must be an array of distinct strings/],
    [{ required: [1] }, /^#\/required:/],
    [{ required: ['a', 'a'] }, /^#\/required:/],
    [{ minLength: -1 }, /^#\/minLength: must be a non-negative integer/],
    [{ maxItems: 1.5 }, /^#\/maxItems: must be a non-negative integer/],
    [{ minimum: '1' }, /^#\/minimum: must be a number/],
    [{ exclusiveMinimum: true }, /^#\/exclusiveMinimum: must be a number/],
    [{ multipleOf: 0 }, /^#\/multipleOf: must be greater than 0/],
    [{ pattern: '(' }, /^#\/pattern: invalid regular expression/],
    [{ pattern: 1 }, /^#\/pattern: must be a string/],
    [{ enum: [] }, /^#\/enum: must be a non-empty array/],
    [{ anyOf: [] }, /^#\/anyOf: must be a non-empty array of schemas/],
    [{ oneOf: [1] }, /^#\/oneOf\/0: must be a schema/],
    [{ properties: [] }, /^#\/properties: must be an object of schemas/],
    [{ properties: { a: 'string' } }, /^#\/properties\/a: must be a schema/],
    [{ uniqueItems: 'yes' }, /^#\/uniqueItems: must be a boolean/],
    [[], /^#: a schema must be an object or a boolean/],
  ];

  for (const [schema, pattern] of cases) {
    assertCompileError(schema, pattern);
  }
});

test('an error in an unused definition still fails compilation', () => {
  assertCompileError(
    { type: 'string', definitions: { unused: { type: 'strng' } } },
    /^#\/definitions\/unused\/type: must be a type name/,
  );
});

test('a reference cycle that never reaches a child value fails compilation instead of recursing forever', () => {
  assertCompileError({ $ref: '#' }, /reference cycle never reaches a child value/);
  assertCompileError({ not: { $ref: '#' } }, /reference cycle/);

  assertCompileError(
    {
      $ref: '#/definitions/a',
      definitions: {
        a: { anyOf: [{ type: 'string' }, { $ref: '#/definitions/b' }] },
        b: { allOf: [{ $ref: '#/definitions/a' }] },
      },
    },
    /reference cycle/,
  );

  // the same cycle through a child value is ordinary recursion
  assert.equal(isValid({ properties: { next: { $ref: '#' } }, required: ['v'] }, { v: 1, next: { v: 2 } }), true);
});

test('compiling leaves the schema unchanged and validators keep no state between calls', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'run.schema.json'), 'utf8'));
  const before = structuredClone(schema);
  const validate = compileSchema(schema);

  assert.deepEqual(schema, before);

  const first = validate({});
  const second = validate({});

  assert.ok(first.length > 0);
  assert.notEqual(first, second, 'each call returns a fresh array');
  assert.deepEqual(first, second);
  assert.deepEqual(compileSchema({ type: 'string' })(1).length, 1);
  assert.deepEqual(compileSchema({ type: 'string' })('ok'), []);
});

test('the manifest schema accepts a complete manifest and names the bad field when a profile is wrong', () => {
  const validate = compileSchema(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'run.schema.json'), 'utf8')));

  const manifest = {
    version: 1,
    label: 'demo run',
    input: { root: 'repo', snapshot: 'working-tree' },
    limits: { concurrency: 2, spendThresholdUsd: null },
    profiles: { claude: claudeProfile(), codex: codexProfile() },
    tasks: [
      {
        id: 'a',
        profile: 'claude',
        prompt: 'prompt.md',
        retry: { maxAttempts: 2, on: ['transient'], safeToRepeat: true },
      },
      {
        id: 'b',
        profile: 'codex',
        prompt: { text: 'Do it.' },
        dependsOn: ['a'],
        verify: [{ name: 'unit', argv: ['true'] }],
      },
    ],
    integration: { order: ['a', 'b'], checks: [{ name: 'all', argv: ['true'] }] },
  };

  assert.deepEqual(validate(manifest), []);

  const typo = structuredClone(manifest);

  typo.profiles.claude.permisionMode = typo.profiles.claude.permissionMode;
  delete typo.profiles.claude.permissionMode;

  const errors = validate(typo).map((error) => `${error.instancePath} ${error.message}`);

  assert.ok(errors.includes('/profiles/claude must NOT have additional properties (found "permisionMode")'), errors);
  assert.ok(errors.includes("/profiles/claude must have required property 'permissionMode'"), errors);
  assert.ok(errors.includes('/profiles/claude must match exactly one schema in oneOf'), errors);

  const duplicate = structuredClone(manifest);

  duplicate.tasks[1].dependsOn = ['a', 'a'];
  duplicate.limits.spendThresholdUsd = 0;

  assert.deepEqual(
    validate(duplicate).map((error) => `${error.instancePath} ${error.message}`),
    ['/limits/spendThresholdUsd must be > 0', '/tasks/1/dependsOn must NOT have duplicate items (0 and 1)'],
  );
});

test('the generic result schema compiles and requires its fields', () => {
  const generic = compileSchema(JSON.parse(fs.readFileSync(GENERIC_RESULT_SCHEMA, 'utf8')));

  assert.ok(generic({}).length > 0, 'an empty object is rejected');

  const done = { taskId: 't', attemptId: 'a', status: 'done', summary: 's', blocker: null, files: [], checks: [] };

  assert.deepEqual(generic(done), []);
  assert.deepEqual(generic({ ...done, status: 'blocked', blocker: { reason: 'r', needs: 'n' } }), []);
  assert.ok(generic({ ...done, blocker: { reason: 'r' } }).length > 0, 'a blocker needs both fields');
});
