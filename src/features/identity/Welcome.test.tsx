// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {Welcome} from './Welcome';
import {WorkspaceContext,type ClientState} from '../../app/AppContext';
const accounts=[{id:'person-one',name:'Куратор Первый'},{id:'person-two',name:'Куратор Второй'}];
const mutate=vi.fn(async()=>({})),notify=vi.fn(),onClose=vi.fn();
function view(){return render(<WorkspaceContext value={{state:{} as ClientState,mutate,notify,refresh:async()=>{}}}><Welcome onClose={onClose}/></WorkspaceContext>);}
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({accounts})})));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('lets a curator choose their local account and submit its password without displaying it',async()=>{view();const account=await screen.findByLabelText('Учётная запись');fireEvent.change(account,{target:{value:'person-two'}});const password=screen.getByLabelText('Пароль');expect(password.getAttribute('type')).toBe('password');expect(password.getAttribute('autoComplete')).toBe('current-password');fireEvent.change(password,{target:{value:'synthetic-fixture-password'}});fireEvent.click(screen.getByRole('button',{name:'Войти как куратор'}));await waitFor(()=>expect(mutate).toHaveBeenCalledWith('/api/login',{role:'curator',accountId:'person-two',code:'synthetic-fixture-password'}));expect(screen.queryByText('synthetic-fixture-password')).toBeNull();expect(onClose).toHaveBeenCalled();});
it('shows a readable error when the local account list is unavailable and keeps reader entry available',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,json:async()=>({message:'Internal detail'})})));view();await screen.findByRole('alert');await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('учётные записи'));expect(screen.getByRole('button',{name:'Войти как куратор'})).toHaveProperty('disabled',true);fireEvent.click(screen.getByRole('button',{name:/продолжить просмотр/}));expect(onClose).toHaveBeenCalled();});
