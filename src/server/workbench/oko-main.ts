import { createOkoApplication } from './oko-application';

const instance = await createOkoApplication({ projectRoot: process.cwd() });
await instance.app.listen({ host: '127.0.0.1', port: instance.config.port });
console.log(`ОКО · локальный API и интерфейс: http://127.0.0.1:${instance.config.port}/oko.html`);
let closing = false;
async function close() { if (closing) return; closing = true; await instance.close(); process.exit(0); }
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
process.on('disconnect', () => void close());
process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'uor.shutdown') void close(); });
process.send?.({ type: 'uor.oko.ready', port: instance.config.port });
