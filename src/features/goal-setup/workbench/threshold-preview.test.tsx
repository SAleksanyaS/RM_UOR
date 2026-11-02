// @vitest-environment jsdom
import { it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { MethodEditor } from './MethodEditor';
afterEach(cleanup);
it('previews a threshold change through the same exact condition while separating data quality and UOR', () => {
    function Editor() { const [value, setValue] = useState<any>({ mode: 'numeric', rules: [{ metricRef: { id: 'metric' }, condition: { op: 'gte', target: '90' } }], formula: {} }); return <MethodEditor value={value} onChange={setValue} metrics={[]} onAddMetric={() => { }} problems={[]}/>; }
    render(<Editor />);
    fireEvent.change(screen.getByLabelText('Пример значения 1'), { target: { value: '92' } });
    expect(screen.getByText('Пример: условие выполнено')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Порог'), { target: { value: '95' } });
    expect(screen.getByText('Пример: условие не выполнено')).toBeTruthy();
    expect(screen.getByText(/не оценивает полноту.*не подтверждает УОР/)).toBeTruthy();
});
