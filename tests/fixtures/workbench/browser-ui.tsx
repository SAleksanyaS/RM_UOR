import { createRoot } from 'react-dom/client';
import { WorkbenchClient } from '../../../src/app/workbench/api-client';
import { WorkbenchProvider } from '../../../src/app/workbench/context';
import { WorkbenchShell } from '../../../src/app/workbench/WorkbenchShell';
import { SharedBrowserScenarioWizard } from '../../../src/features/connectors/workbench/SharedBrowserScenarioWizard';
import '../../../src/app/workbench/workbench.css';

const props = JSON.parse(document.getElementById('t47-props')!.textContent!);
createRoot(document.getElementById('root')!).render(<WorkbenchProvider client={new WorkbenchClient()}><WorkbenchShell views={{ data: () => <SharedBrowserScenarioWizard sourceRef={props.sourceRef} draftId={null} onDraftSaved={() => {}} /> }} /></WorkbenchProvider>);
