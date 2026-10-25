import { createApp } from './app';
import { loadSite } from './workspace/context';

const root = process.cwd();
const site = await loadSite(root);
const app = await createApp({ projectRoot: root });
await app.listen({ host: '127.0.0.1', port: site.port });
console.log(`УОР ДИТ Operations: локальная служба http://127.0.0.1:${site.port}`);
let closing = false;
async function close() { if (closing) return; closing = true; await app.close(); process.exit(0); }
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
process.on('message',message=>{if(message&&typeof message==='object'&&'type' in message&&message.type==='uor.shutdown')void close();});
