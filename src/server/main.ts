import './log-capture-bootstrap';
import { createWorkbenchRuntime } from './workbench/bootstrap';
import { createWorkbenchApp } from './workbench/app';
import { attachWorkbenchLauncher } from './workbench/launcher';

const candidate = process.env.UOR_UPDATE_BOOTSTRAP === '1';
const runtime = await createWorkbenchRuntime({ projectRoot: process.cwd(), candidate });
const app = await createWorkbenchApp(runtime.deps, { configure: runtime.configure, deferActivation: true });
const detach = attachWorkbenchLauncher(runtime, app, candidate);
let closing = false;
async function close() { if (closing) return; closing = true; detach(); await app.close(); await runtime.close(); process.exit(0); }
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
process.on('disconnect', () => void close());
process.on('message',message=>{if(message&&typeof message==='object'&&'type' in message&&message.type==='uor.shutdown')void close();});
if (!candidate) await runtime.activate();
await app.listen({ host: '127.0.0.1', port: runtime.config.port });
process.send?.({ type: 'uor.child-ready', bootstrap: candidate, blocked: candidate });
console.log(`УОР ДИТ Operations: локальная служба http://127.0.0.1:${runtime.config.port}`);
