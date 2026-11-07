import { z } from 'zod';

/**
 * Zod schemas for the parts of Meta's WhatsApp Cloud API webhook we use.
 * Unknown fields are stripped (zod default), so e.g. `contacts[].profile.name` (the user's WhatsApp
 * name, PHI) is never even parsed. Levels are validated one at a time so a single malformed entry
 * cannot make us drop (or re-trigger via a non-200) the valid ones around it.
 */

export const envelopeSchema = z.object({ entry: z.array(z.unknown()) });

export const entrySchema = z.object({ changes: z.array(z.unknown()) });

export const changeSchema = z.object({ field: z.string(), value: z.unknown() });

export const valueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string() }),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
});

const mediaSchema = z.object({
  id: z.string().min(1),
  mime_type: z.string().optional(),
  sha256: z.string().optional(),
  filename: z.string().optional(),
  caption: z.string().optional(),
});

export const messageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  /** Unix seconds, as a string. */
  timestamp: z.string().regex(/^\d+$/),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  image: mediaSchema.optional(),
  document: mediaSchema.optional(),
  audio: mediaSchema.optional(),
  interactive: z
    .object({
      type: z.string(),
      button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
    })
    .optional(),
  /** Legacy quick-reply button (template button taps). */
  button: z.object({ payload: z.string().optional(), text: z.string() }).optional(),
});

export type WhatsAppMessage = z.infer<typeof messageSchema>;

export const statusSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  timestamp: z.string().regex(/^\d+$/).optional(),
  errors: z.array(z.object({ code: z.number().optional() })).optional(),
});
