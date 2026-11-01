import { z } from 'zod';
import { restoreCodeUpdateWorkspace } from '../src/server/workbench/bootstrap';

// Private launcher child. Restores a checked server-owned archive, never accepts a path or HTTP token.
const backupId = z.string().uuid().parse(process.argv[2]);
await restoreCodeUpdateWorkspace(process.cwd(), backupId);
