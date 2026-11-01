import { z } from 'zod';
import { uuidSchema, type UUIDv4 } from '../../domain/workbench/primitives';

/** Browser-safe public upload metadata; file storage and bytes remain server-owned. */
export type FileHandleView = { fileHandle: UUIDv4; name: string; mediaType: string; bytes: number; sha256: string };
export const fileHandleViewSchema = z.strictObject({ fileHandle: uuidSchema, name: z.string().min(1).max(255), mediaType: z.string().min(1).max(150), bytes: z.number().int().positive().safe(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
