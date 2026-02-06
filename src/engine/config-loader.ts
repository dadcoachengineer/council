import * as yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { CouncilConfigSchema, validateAgentReferences, type ValidatedCouncilConfig } from '../shared/schemas.js';

export class ConfigLoadError extends Error {
  constructor(
    message: string,
    public details: string[] = [],
  ) {
    super(message);
    this.name = 'ConfigLoadError';
  }
}

/**
 * Parse and validate a council YAML config string.
 */
export function parseConfig(yamlContent: string): ValidatedCouncilConfig {
  let raw: unknown;
  try {
    raw = yaml.load(yamlContent);
  } catch (err) {
    throw new ConfigLoadError(`Invalid YAML: ${(err as Error).message}`);
  }

  const result = CouncilConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new ConfigLoadError('Config validation failed', details);
  }

  const refErrors = validateAgentReferences(result.data);
  if (refErrors.length > 0) {
    throw new ConfigLoadError('Invalid agent references in config', refErrors);
  }

  // Resolve env vars in string values (e.g. "${GITHUB_WEBHOOK_SECRET}")
  return resolveEnvVars(result.data);
}

/**
 * Load and validate a council config from a file path.
 */
export function loadConfigFile(filePath: string): ValidatedCouncilConfig {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new ConfigLoadError(`Cannot read config file: ${(err as Error).message}`);
  }
  return parseConfig(content);
}

/**
 * Recursively resolve ${ENV_VAR} patterns in string values.
 */
function resolveEnvVars<T>(obj: T): T {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      return process.env[varName] ?? '';
    }) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars) as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = resolveEnvVars(val);
    }
    return result as T;
  }
  return obj;
}
