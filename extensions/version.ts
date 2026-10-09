/**
 * The package version.
 *
 * Lives in its own module because two sides need it and must agree: the
 * extension (which reports it) and the converter (which records it in the
 * manifest and the conversion cache, so a rule change invalidates old output).
 * Keeping it out of `cfg.ts` avoids the converter importing anything that
 * depends on pi.
 */
export const LIB_VERSION = "0.1.0";
