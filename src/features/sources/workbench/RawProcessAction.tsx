import { useGlobalContext, useWorkbench } from '../../../app/workbench/context';
export function RawProcessAction({ id }: {
    id: string;
}) { const { navigate } = useGlobalContext(), { session } = useWorkbench(); return session?.allowedCommands.includes('raw.file.stageForImport') ? <button onClick={() => navigate('/data?raw=' + encodeURIComponent(id) + '#processing')}>Обработать</button> : null; }
