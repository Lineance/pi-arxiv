/**
 * The rule pipeline. Order matters:
 *   figures → math → tables → captions → headings → refs → text → structure
 * (structure adds the header last so no other rule rewrites it.)
 */

import { captionsRule } from "./captions.ts";
import { figuresRule } from "./figures.ts";
import { headingsRule } from "./headings.ts";
import { mathRule } from "./math.ts";
import { refsRule } from "./refs.ts";
import { structureRule } from "./structure.ts";
import { tablesRule } from "./tables.ts";
import { textRule } from "./text.ts";
import type { Rule } from "./types.ts";

export const rules: Rule[] = [figuresRule, mathRule, tablesRule, captionsRule, headingsRule, refsRule, textRule, structureRule];

export { lintMarkdown } from "./text.ts";
export type { Rule } from "./types.ts";
