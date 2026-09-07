import { parseEnv } from './env.schema';

export type { Env } from './env.schema';
export { parseEnv } from './env.schema';

/**
 * The app's single, frozen, parsed-once config object. Importing this
 * module parses process.env immediately and throws a readable aggregated
 * error if anything is missing/invalid — fail fast at boot.
 */
export const env = Object.freeze(parseEnv(process.env));
