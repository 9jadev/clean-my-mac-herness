// The cleanup plan: its schema, and the checks the harness applies on top of the model's labels.

import { z } from "zod";
import { sensitiveReason, userFilesFolder } from "./paths";
import type { ScanLog } from "./scan-tool";

export const PlanItem = z.object({
  title: z.string(),
  path: z.string(),
  size: z.string(),
  whatItIs: z.string(),
  safety: z.enum(["safe", "caution", "unsafe"]),
  safetyReason: z.string(),
  sensitive: z.boolean(),
  sensitiveNote: z.string(),
  command: z.string().nullable(),
  commandEffect: z.string(),
});
export type PlanItem = z.infer<typeof PlanItem>;

export const Plan = z.object({ items: z.array(PlanItem) });

/** Pulls the items out of the model's reply, skipping (and reporting) malformed ones. */
export function parsePlanItems(data: unknown): PlanItem[] {
  const items = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error(`cleanup plan has no "items" array:\n${JSON.stringify(data)}`);

  const valid: PlanItem[] = [];
  for (const item of items) {
    const parsed = PlanItem.safeParse(item);
    if (parsed.success) valid.push(parsed.data);
    else console.error(`  (skipping a malformed plan item: ${JSON.stringify(item).slice(0, 120)})`);
  }
  return valid;
}

export interface Dropped {
  item: PlanItem;
  reason: string;
}

/**
 * Applies the harness's own rules:
 *  - drops items whose path never appeared in a scan result (the model may not invent paths);
 *  - marks known credential / personal-data locations as sensitive;
 *  - downgrades the user's own files (Documents, Downloads, …) from "safe" to "caution".
 */
export function reviewPlan(items: PlanItem[], scanned: ScanLog): { kept: PlanItem[]; dropped: Dropped[] } {
  const kept: PlanItem[] = [];
  const dropped: Dropped[] = [];

  for (const original of items) {
    if (!scanned.has(original.path)) {
      dropped.push({ item: original, reason: "path was not in any scan result" });
      continue;
    }
    const item = { ...original };

    const sensitive = sensitiveReason(item.path);
    if (sensitive) {
      item.sensitive = true;
      item.sensitiveNote = [item.sensitiveNote, `Contains ${sensitive} (flagged by the harness).`]
        .filter(Boolean)
        .join(" ");
    }

    const userFolder = userFilesFolder(item.path);
    if (userFolder && item.safety === "safe") {
      item.safety = "caution";
      item.safetyReason = `${item.safetyReason} These are your own files in ~/${userFolder}, so review them yourself.`;
    }

    kept.push(item);
  }
  return { kept, dropped };
}
