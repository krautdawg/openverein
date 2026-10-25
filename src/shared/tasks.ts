import { z } from 'zod';

export const taskInput = z.object({
  title: z.string().trim().min(1, 'Pflichtfeld.').max(200),
  note: z.string().trim().max(2000).nullish(),
  dueOn: z.iso.date().nullish(),
  assigneeUserId: z.uuid().nullish(),
  memberId: z.uuid().nullish(),
});
export const taskPatch = taskInput.omit({ memberId: true }).partial().extend({ done: z.boolean().optional() });
export const task = z.object({
  id: z.uuid(),
  title: z.string(),
  note: z.string().nullable(),
  dueOn: z.string().nullable(),
  overdue: z.boolean(),
  assignee: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  /** only when the viewer may read that member */
  member: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  done: z.boolean(),
  doneAt: z.string().nullable(),
  createdBy: z.string(),
  /** creator, assignee or administrator */
  canEdit: z.boolean(),
  /** creator or administrator */
  canDelete: z.boolean(),
});
export type Task = z.infer<typeof task>;
