import { it, expect } from 'vitest';
import { dashboardPreset, newBlock } from './dashboard-ui';
import { validateDashboardSettings } from '../../knowledge/workbench-dashboards';
it('starts from complete registered management blocks without guessed metric references', () => {
    const preset = dashboardPreset('management');
    expect(preset.blocks.map(b => b.typeId)).toEqual(['uor.dashboard.goal-comparison.v1', 'uor.dashboard.goal-matrix.v1', 'uor.dashboard.execution-table.v1', 'uor.dashboard.data-issues.v1']);
    expect(() => validateDashboardSettings(preset)).not.toThrow();
    const changed = structuredClone(preset);
    changed.blocks.reverse();
    expect(() => validateDashboardSettings(changed)).not.toThrow();
    expect(newBlock('goal-matrix').settings.value).toMatchObject({ limit: 20, attentionOnly: false });
});
