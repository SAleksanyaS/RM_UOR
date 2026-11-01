export type PersonalWorkflowPrefix = 'source.browser' | 'oko.workflow';
export function personalWorkflowName(prefix: PersonalWorkflowPrefix, name: string): string {
  if (prefix === 'source.browser') return name;
  if (name === 'source.browser.role.set') return 'workbench.role.set';
  if (name === 'source.browser.workflow.open') return 'oko.workflow.open';
  return name.startsWith('source.browser.') ? 'oko.workflow.' + name.slice('source.browser.'.length) : name;
}
export function personalWorkflowAlias(prefix: PersonalWorkflowPrefix, name: string): string | null {
  if (prefix === 'source.browser') return name;
  if (name === 'workbench.role.set') return 'source.browser.role.set';
  if (name === 'oko.workflow.open') return 'source.browser.workflow.open';
  if (name.startsWith('oko.workflow.')) return 'source.browser.' + name.slice('oko.workflow.'.length);
  return name.startsWith('source.browser.') ? null : name;
}
