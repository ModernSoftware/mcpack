import { MCPackError } from './errors.js';

export interface ToolInputLimits {
  maxToolInputElements?: number;
  maxToolInputDepth?: number;
}

export function resolveToolInputLimits(options: ToolInputLimits) {
  const limits = {
    maxToolInputElements: options.maxToolInputElements ?? 10_000,
    maxToolInputDepth: options.maxToolInputDepth ?? 64,
  };

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }

  return limits;
}

/** Bound work before AJV validation, error allocation and worker serialization. */
export function assertToolInputLimits(input: unknown, limits: Required<ToolInputLimits>): void {
  const pending = [{ value: input, depth: 1 }];
  let elements = 0;

  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (value === null || typeof value !== 'object') continue;
    if (depth > limits.maxToolInputDepth) {
      throw new MCPackError('INVALID_ARGUMENTS', 'Tool arguments exceed the nesting depth limit');
    }

    if (Array.isArray(value)) {
      elements += value.length;
      if (elements > limits.maxToolInputElements) {
        throw new MCPackError('INVALID_ARGUMENTS', 'Tool arguments exceed the element limit');
      }
      for (const child of value) {
        if (child !== null && typeof child === 'object') {
          pending.push({ value: child, depth: depth + 1 });
        }
      }
      continue;
    }

    // Count while enumerating, rather than allocating a second array of all keys/values.
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++elements > limits.maxToolInputElements) {
        throw new MCPackError('INVALID_ARGUMENTS', 'Tool arguments exceed the element limit');
      }
      const child = (value as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') {
        pending.push({ value: child, depth: depth + 1 });
      }
    }
  }
}
