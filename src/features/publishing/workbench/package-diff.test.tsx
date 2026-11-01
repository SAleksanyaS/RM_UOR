// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PackageDiff } from './PackageDiff';
import { fixtureId } from '../../../../tests/fixtures/workbench/factories';
afterEach(cleanup);
it('shows the three field values and explicit conflict without claiming a recalculated impact',()=>{
 render(<PackageDiff changes={[{objectRef:{entityType:'core_goal_definition',id:fixtureId(1)},field:'title',before:'Прежнее название',main:'Название в main',proposed:'Новое название',conflict:true}]} />);
 expect(screen.getByText('Название цели')).toBeTruthy();
 expect(screen.getByText('Прежнее название')).toBeTruthy();expect(screen.getByText('Название в main')).toBeTruthy();expect(screen.getByText('Новое название')).toBeTruthy();
 expect(screen.getByText(/Конфликт/)).toBeTruthy();expect(screen.getByText(/Описание цели/)).toBeTruthy();
});
it('labels an intentionally empty field value explicitly',()=>{
 render(<PackageDiff changes={[{objectRef:{entityType:'core_goal_definition',id:fixtureId(1)},field:'description',before:'',main:'',proposed:'Текст',conflict:false}]}/>);expect(screen.getAllByText('Пустое значение')).toHaveLength(2);
});
