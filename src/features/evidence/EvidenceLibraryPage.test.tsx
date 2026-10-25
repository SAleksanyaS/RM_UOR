// @vitest-environment jsdom
import React from 'react';
import {expect,it,vi,afterEach} from 'vitest';
import {render,screen,waitFor,cleanup} from '@testing-library/react';
import {WorkspaceContext,type ClientState} from '../../app/AppContext';
import {EvidenceLibraryPage} from './EvidenceLibraryPage';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('renders an HTML-looking filename as inert text and offers download without an inline preview',async()=>{const name='<img onerror=alert(1)>.html';vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>[{id:'proof',name,size:10,sha256:'f'.repeat(64),shared:true,downloadUrl:'/api/evidence/proof/download'}]})));const {container}=render(<WorkspaceContext value={{state:{session:{id:'reader',role:'reader'}} as ClientState,mutate:vi.fn(),notify:vi.fn(),refresh:vi.fn(async()=>{})}}><EvidenceLibraryPage/></WorkspaceContext>);await waitFor(()=>expect(screen.getByRole('link',{name})).toBeTruthy());expect(container.querySelector('img,iframe,object,embed')).toBeNull();expect(screen.getByRole('link',{name}).getAttribute('href')).toBe('/api/evidence/proof/download');expect(screen.queryByLabelText('Прикрепить доказательства')).toBeNull();});
