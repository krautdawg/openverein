import { z } from 'zod';

export const RETENTION_LABEL = { document: 'Dokument', voucher: 'Beleg (8 Jahre aufbewahren)', temporary: 'Vorübergehend (7 Tage)' } as const;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const folder = z.object({ id: z.uuid(), parentId: z.uuid().nullable(), name: z.string(), groupIds: z.array(z.uuid()).nullable(), restricted: z.boolean() });
export type Folder = z.infer<typeof folder>;
export const folderInput = z.object({
  name: z.string().trim().min(1, 'Bitte einen Namen angeben.').max(100).refine((n) => !/[/\\]/.test(n), 'Bitte ohne Schrägstrich.'),
  parentId: z.uuid().nullish(),
  groupIds: z.array(z.uuid()).max(50).nullish(),
});

export const fileDto = z.object({
  id: z.uuid(),
  folderId: z.uuid().nullable(),
  memberId: z.uuid().nullable(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  sha256: z.string(),
  retentionClass: z.enum(['document', 'voucher', 'temporary']),
  retainUntil: z.string().nullable(),
  legalHold: z.boolean(),
  version: z.number(),
  uploadedBy: z.string().nullable(),
  createdAt: z.string(),
});
export type FileDto = z.infer<typeof fileDto>;
export const filePatch = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  folderId: z.uuid().nullable().optional(),
  retentionClass: z.enum(['document', 'voucher', 'temporary']).optional(),
  legalHold: z.boolean().optional(),
});
