export class SchemaError extends Error {
  constructor(message) {
    super(message);

    this.name = 'SchemaError';
  }
}

const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);

const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'readOnly',
  'writeOnly',
  'deprecated',
]);

export function compileSchema(schema) {
  const context = { root: schema, compiled: new Map(), inPlace: new Map() };
  const check = compileNode(schema, '#', context);

  assertNoInPlaceCycle(context.inPlace);

  return (value) => {
    const errors = [];

    check(value, '', errors);

    return errors;
  };
}

const PASS = () => {};

function compileNode(node, at, context) {
  if (node === true) {
    return PASS;
  }

  if (node === false) {
    return (value, instancePath, errors) => errors.push(failure(instancePath, at, 'false', 'must not exist'));
  }

  if (!isObject(node)) {
    throw new SchemaError(`${at}: a schema must be an object or a boolean`);
  }

  if (context.compiled.has(node)) {
    return context.compiled.get(node);
  }

  const checks = [];

  const check = (value, instancePath, errors) => {
    for (const keywordCheck of checks) {
      keywordCheck(value, instancePath, errors);
    }
  };

  // the check is registered before the keywords compile so a recursive reference finds it
  context.compiled.set(node, check);
  context.inPlace.set(node, { at, targets: [] });

  for (const [keyword, value] of Object.entries(node)) {
    if (ANNOTATIONS.has(keyword)) {
      continue;
    }

    const compileKeyword = KEYWORDS.get(keyword);

    if (!compileKeyword) {
      // the spec ignores unknown keywords, but then a typo such as `requried` would silently accept any result
      throw new SchemaError(`${at}: unsupported keyword "${keyword}"`);
    }

    const keywordCheck = compileKeyword(value, { node, at: `${at}/${escapePointer(keyword)}`, context });

    if (keywordCheck) {
      checks.push(keywordCheck);
    }
  }

  return check;
}

/**
 * $ref, allOf, anyOf, oneOf, and not evaluate a subschema against the same value. A cycle made
 * only of those edges would recurse forever on any input, so it is rejected at compile time.
 * Cycles through properties or items are fine because each step descends into a smaller value.
 */
function assertNoInPlaceCycle(inPlace) {
  const done = new Set();
  const active = new Set();

  const visit = (node) => {
    if (done.has(node)) {
      return;
    }

    if (active.has(node)) {
      throw new SchemaError(`${inPlace.get(node).at}: reference cycle never reaches a child value`);
    }

    active.add(node);

    for (const target of inPlace.get(node).targets) {
      visit(target);
    }

    active.delete(node);
    done.add(node);
  };

  for (const node of inPlace.keys()) {
    visit(node);
  }
}

function subschema(value, at, context) {
  if (value !== true && value !== false && !isObject(value)) {
    throw new SchemaError(`${at}: must be a schema`);
  }

  return compileNode(value, at, context);
}

function schemaList(value, at, context) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SchemaError(`${at}: must be a non-empty array of schemas`);
  }

  return value.map((item, index) => subschema(item, `${at}/${index}`, context));
}

function recordInPlace(context, node, targets) {
  context.inPlace.get(node).targets.push(...targets.filter((target) => isObject(target)));
}

function count(value, at) {
  if (!Number.isInteger(value) || value < 0) {
    throw new SchemaError(`${at}: must be a non-negative integer`);
  }

  return value;
}

function limit(value, at) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SchemaError(`${at}: must be a number`);
  }

  return value;
}

function resolvePointer(root, reference, at) {
  if (typeof reference !== 'string' || !reference.startsWith('#')) {
    throw new SchemaError(`${at}: only references inside the same document ("#...") are supported`);
  }

  let pointer;

  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    throw new SchemaError(`${at}: reference ${reference} is not a valid URI fragment`);
  }

  if (pointer === '') {
    return { target: root, at: '#' };
  }

  if (!pointer.startsWith('/')) {
    throw new SchemaError(`${at}: reference ${reference} is not a JSON pointer`);
  }

  let target = root;

  const keys = pointer
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));

  for (const key of keys) {
    if (target === null || typeof target !== 'object' || !Object.hasOwn(target, key)) {
      throw new SchemaError(`${at}: reference ${reference} does not resolve`);
    }

    target = target[key];
  }

  // build the path from the decoded keys, so a target's schema path is the same whether $ref or definitions compiled it
  return { target, at: `#/${keys.map((key) => escapePointer(key)).join('/')}` };
}

const KEYWORDS = new Map(
  Object.entries({
    type(value, { at }) {
      const types = Array.isArray(value) ? value : [value];

      if (types.length === 0 || !types.every((type) => TYPES.has(type)) || new Set(types).size !== types.length) {
        throw new SchemaError(`${at}: must be a type name or an array of distinct type names`);
      }

      const message = `must be ${types.join(' or ')}`;

      return (data, instancePath, errors) => {
        if (!types.some((type) => hasType(data, type))) {
          errors.push(failure(instancePath, at, 'type', message));
        }
      };
    },

    enum(value, { at }) {
      if (!Array.isArray(value) || value.length === 0) {
        throw new SchemaError(`${at}: must be a non-empty array`);
      }

      const message = `must be one of ${value.map((item) => JSON.stringify(item)).join(', ')}`;

      return (data, instancePath, errors) => {
        if (!value.some((item) => jsonEqual(item, data))) {
          errors.push(failure(instancePath, at, 'enum', message));
        }
      };
    },

    const(value, { at }) {
      const message = `must be equal to ${JSON.stringify(value)}`;

      return (data, instancePath, errors) => {
        if (!jsonEqual(value, data)) {
          errors.push(failure(instancePath, at, 'const', message));
        }
      };
    },

    required(value, { at }) {
      if (
        !Array.isArray(value) ||
        !value.every((name) => typeof name === 'string') ||
        new Set(value).size !== value.length
      ) {
        throw new SchemaError(`${at}: must be an array of distinct strings`);
      }

      return (data, instancePath, errors) => {
        if (!isObject(data)) {
          return;
        }

        for (const name of value) {
          if (!Object.hasOwn(data, name)) {
            errors.push(failure(instancePath, at, 'required', `must have required property '${name}'`));
          }
        }
      };
    },

    properties(value, { at, context }) {
      if (!isObject(value)) {
        throw new SchemaError(`${at}: must be an object of schemas`);
      }

      const checks = new Map(
        Object.entries(value).map(([name, schema]) => [
          name,
          subschema(schema, `${at}/${escapePointer(name)}`, context),
        ]),
      );

      return (data, instancePath, errors) => {
        if (!isObject(data)) {
          return;
        }

        for (const [name, check] of checks) {
          if (Object.hasOwn(data, name)) {
            check(data[name], `${instancePath}/${escapePointer(name)}`, errors);
          }
        }
      };
    },

    additionalProperties(value, { node, at, context }) {
      const check = subschema(value, at, context);

      if (value === true) {
        return null;
      }

      const declared = new Set(isObject(node.properties) ? Object.keys(node.properties) : []);

      return (data, instancePath, errors) => {
        if (!isObject(data)) {
          return;
        }

        for (const name of Object.keys(data)) {
          if (declared.has(name)) {
            continue;
          }

          if (value === false) {
            errors.push(
              failure(
                instancePath,
                at,
                'additionalProperties',
                `must NOT have additional properties (found "${name}")`,
              ),
            );
          } else {
            check(data[name], `${instancePath}/${escapePointer(name)}`, errors);
          }
        }
      };
    },

    propertyNames(value, { at, context }) {
      const check = subschema(value, at, context);

      return (data, instancePath, errors) => {
        if (!isObject(data)) {
          return;
        }

        for (const name of Object.keys(data)) {
          const nameErrors = [];

          check(name, '', nameErrors);

          for (const error of nameErrors) {
            errors.push(
              failure(instancePath, error.schemaPath, 'propertyNames', `property name "${name}" ${error.message}`),
            );
          }
        }
      };
    },

    minProperties: sizeBound('minProperties', isObject, (data) => Object.keys(data).length, '>=', 'properties'),
    maxProperties: sizeBound('maxProperties', isObject, (data) => Object.keys(data).length, '<=', 'properties'),

    items(value, { at, context }) {
      if (Array.isArray(value)) {
        throw new SchemaError(`${at}: the tuple form of items is not supported; use one schema for every element`);
      }

      const check = subschema(value, at, context);

      return (data, instancePath, errors) => {
        if (!Array.isArray(data)) {
          return;
        }

        for (const [index, item] of data.entries()) {
          check(item, `${instancePath}/${index}`, errors);
        }
      };
    },

    minItems: sizeBound('minItems', Array.isArray, (data) => data.length, '>=', 'items'),
    maxItems: sizeBound('maxItems', Array.isArray, (data) => data.length, '<=', 'items'),

    uniqueItems(value, { at }) {
      if (typeof value !== 'boolean') {
        throw new SchemaError(`${at}: must be a boolean`);
      }

      if (!value) {
        return null;
      }

      return (data, instancePath, errors) => {
        if (!Array.isArray(data)) {
          return;
        }

        for (let later = 1; later < data.length; later += 1) {
          const earlier = data.findIndex((item, index) => index < later && jsonEqual(item, data[later]));

          if (earlier !== -1) {
            errors.push(
              failure(instancePath, at, 'uniqueItems', `must NOT have duplicate items (${earlier} and ${later})`),
            );
          }
        }
      };
    },

    // lengths count code points, not UTF-16 units, as the specification requires
    minLength: sizeBound('minLength', isString, codePointLength, '>=', 'characters'),
    maxLength: sizeBound('maxLength', isString, codePointLength, '<=', 'characters'),

    pattern(value, { at }) {
      if (typeof value !== 'string') {
        throw new SchemaError(`${at}: must be a string`);
      }

      let expression;

      try {
        expression = new RegExp(value, 'u');
      } catch (error) {
        throw new SchemaError(`${at}: invalid regular expression: ${error.message}`);
      }

      const message = `must match pattern "${value}"`;

      return (data, instancePath, errors) => {
        if (typeof data === 'string' && !expression.test(data)) {
          errors.push(failure(instancePath, at, 'pattern', message));
        }
      };
    },

    minimum: numberBound('minimum', '>=', (data, bound) => data >= bound),
    maximum: numberBound('maximum', '<=', (data, bound) => data <= bound),
    exclusiveMinimum: numberBound('exclusiveMinimum', '>', (data, bound) => data > bound),
    exclusiveMaximum: numberBound('exclusiveMaximum', '<', (data, bound) => data < bound),

    multipleOf(value, { at }) {
      if (limit(value, at) <= 0) {
        throw new SchemaError(`${at}: must be greater than 0`);
      }

      return (data, instancePath, errors) => {
        if (typeof data === 'number' && !Number.isInteger(data / value)) {
          errors.push(failure(instancePath, at, 'multipleOf', `must be a multiple of ${value}`));
        }
      };
    },

    allOf(value, { node, at, context }) {
      const checks = schemaList(value, at, context);

      recordInPlace(context, node, value);

      return (data, instancePath, errors) => {
        for (const check of checks) {
          check(data, instancePath, errors);
        }
      };
    },

    anyOf(value, { node, at, context }) {
      const checks = schemaList(value, at, context);

      recordInPlace(context, node, value);

      return (data, instancePath, errors) => {
        const branchErrors = [];

        for (const check of checks) {
          const before = branchErrors.length;

          check(data, instancePath, branchErrors);

          if (branchErrors.length === before) {
            return;
          }
        }

        errors.push(...branchErrors, failure(instancePath, at, 'anyOf', 'must match a schema in anyOf'));
      };
    },

    oneOf(value, { node, at, context }) {
      const checks = schemaList(value, at, context);

      recordInPlace(context, node, value);

      return (data, instancePath, errors) => {
        const branchErrors = [];
        const matched = [];

        for (const [index, check] of checks.entries()) {
          const before = branchErrors.length;

          check(data, instancePath, branchErrors);

          if (branchErrors.length === before) {
            matched.push(index);
          }
        }

        if (matched.length === 0) {
          errors.push(...branchErrors, failure(instancePath, at, 'oneOf', 'must match exactly one schema in oneOf'));
        } else if (matched.length > 1) {
          errors.push(
            failure(
              instancePath,
              at,
              'oneOf',
              `must match exactly one schema in oneOf (matched ${matched.join(', ')})`,
            ),
          );
        }
      };
    },

    not(value, { node, at, context }) {
      const check = subschema(value, at, context);

      recordInPlace(context, node, [value]);

      return (data, instancePath, errors) => {
        const branchErrors = [];

        check(data, instancePath, branchErrors);

        if (branchErrors.length === 0) {
          errors.push(failure(instancePath, at, 'not', 'must NOT be valid'));
        }
      };
    },

    $ref(value, { node, at, context }) {
      const { target, at: targetAt } = resolvePointer(context.root, value, at);
      const check = subschema(target, targetAt, context);

      recordInPlace(context, node, [target]);

      return check;
    },

    definitions: compileDefinitions,
    $defs: compileDefinitions,
  }),
);

// definitions add no assertion, but they compile anyway so a mistake in an unused definition is still reported
function compileDefinitions(value, { at, context }) {
  if (!isObject(value)) {
    throw new SchemaError(`${at}: must be an object of schemas`);
  }

  for (const [name, schema] of Object.entries(value)) {
    subschema(schema, `${at}/${escapePointer(name)}`, context);
  }

  return null;
}

function sizeBound(keyword, applies, size, operator, unit) {
  return (value, { at }) => {
    const bound = count(value, at);
    const message = `must have ${operator === '>=' ? 'at least' : 'at most'} ${bound} ${unit}`;

    return (data, instancePath, errors) => {
      if (applies(data) && !(operator === '>=' ? size(data) >= bound : size(data) <= bound)) {
        errors.push(failure(instancePath, at, keyword, message));
      }
    };
  };
}

function numberBound(keyword, operator, holds) {
  return (value, { at }) => {
    const bound = limit(value, at);
    const message = `must be ${operator} ${bound}`;

    return (data, instancePath, errors) => {
      if (typeof data === 'number' && !holds(data, bound)) {
        errors.push(failure(instancePath, at, keyword, message));
      }
    };
  };
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value) {
  return typeof value === 'string';
}

function hasType(value, type) {
  switch (type) {
    case 'null': {
      return value === null;
    }
    case 'object': {
      return isObject(value);
    }
    case 'array': {
      return Array.isArray(value);
    }
    case 'number': {
      return typeof value === 'number' && Number.isFinite(value);
    }
    case 'integer': {
      return Number.isInteger(value);
    }
    default: {
      return typeof value === type;
    }
  }
}

function codePointLength(text) {
  return [...text].length;
}

function jsonEqual(left, right) {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left)) {
    return (
      Array.isArray(right) && left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]))
    );
  }

  if (isObject(left) && isObject(right)) {
    const keys = Object.keys(left);

    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
    );
  }

  return false;
}

function escapePointer(token) {
  return String(token).replaceAll('~', '~0').replaceAll('/', '~1');
}

function failure(instancePath, schemaPath, keyword, message) {
  return { instancePath, schemaPath, keyword, message };
}
