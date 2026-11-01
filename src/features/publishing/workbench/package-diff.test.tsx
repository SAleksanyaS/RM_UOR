// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { PackageDiff, packageDraftLabels } from './PackageDiff';
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
it('uses exact package names only for proposed references, without inventing historical names', () => {
 const reference = {entityType:'method_version',id:fixtureId(2),revision:3};
 const labels = packageDraftLabels([{entityRef:{entityType:reference.entityType,id:reference.id},versionRef:reference,definition:{title:'Методика из пакета'}}]);
 render(<PackageDiff labels={labels} changes={[{objectRef:{entityType:'core_goal_definition',id:fixtureId(1)},field:'methodRef',before:reference,main:reference,proposed:reference,conflict:false}]}/>);
 expect(screen.getAllByText('Методика из пакета')).toHaveLength(1);
 expect(screen.getAllByText('Название не включено в пакет')).toHaveLength(2);
 const proposed = screen.getByText('Предлагается').parentElement!;
 expect(within(proposed).getByText(reference.id,{exact:false})).toBeTruthy();
 expect(within(proposed).getByText(/3/)).toBeTruthy();
 expect(within(proposed).getByText('Точная ссылка')).toBeTruthy();
});
it('does not label a different reference revision with the proposed latest name', () => {
 const reference = {entityType:'method_version',id:fixtureId(2),revision:3};
 const labels = packageDraftLabels([{entityRef:{entityType:reference.entityType,id:reference.id},versionRef:reference,definition:{title:'Новая методика'}}]);
 render(<PackageDiff labels={labels} changes={[{objectRef:{entityType:'core_goal_definition',id:fixtureId(1)},field:'methodRef',before:null,main:null,proposed:{...reference,revision:2},conflict:false}]}/>);
 expect(screen.queryByText('Новая методика')).toBeNull();
 expect(screen.getByText('Название не включено в пакет')).toBeTruthy();
});
it('preserves business properties when an object also contains reference-like fields', () => {
 render(<PackageDiff changes={[{objectRef:{entityType:'work',id:fixtureId(1)},field:'responsibility',before:null,main:null,proposed:{entityType:'directory_entity',id:fixtureId(2),request:'Согласовать состав команды',revision:2},conflict:false}]}/>);
 expect(screen.getByText('Согласовать состав команды')).toBeTruthy();
 expect(screen.getByText(fixtureId(2))).toBeTruthy();
});
