import {z} from 'zod';
import {privateProfileSchema} from './private-profile-schema';
import type {BrowserOwner} from './workbench-browser-runtime';
const selector=z.string().trim().min(1).max(1000).refine(v=>!/password|secret|token|otp|saml|credential/i.test(v),'Не используйте поля входа');
const url=z.string().url().refine(v=>{const u=new URL(v);return !u.username&&!u.password&&![...u.searchParams.keys()].some(k=>/token|password|secret|credential|authorization|saml|code/i.test(k));});
export const gigaBindingSchema=z.strictObject({url,profile:privateProfileSchema,authenticatedSelector:selector,conversationSelector:selector,conversationAttribute:z.string().regex(/^[a-zA-Z][\w-]*$/).nullable(),inputSelector:selector,sendSelector:selector,messageSelector:selector,userSelector:selector,assistantSelector:selector,completedSelector:selector,allowedKinds:z.array(z.enum(['fact','change','quality','work','decision','comment','material'])).min(1),maxCharacters:z.number().int().min(100).max(1000000)});
export type GigaBinding=z.infer<typeof gigaBindingSchema>;
export type GigaConversation={url:string;key:string;bindingHash:string};
export interface GigaChatBrowserPort {
 configuration(owner:BrowserOwner):Promise<{binding:GigaBinding|null;revision:string|null}>;
 configure(owner:BrowserOwner,binding:GigaBinding,expectedRevision:string|null):Promise<{revision:string}>;
 open(owner:BrowserOwner,conversation?:GigaConversation):Promise<{opened:true}>;
 inspect(owner:BrowserOwner):Promise<GigaConversation>;
 send(owner:BrowserOwner,input:{conversation:GigaConversation;requestId:string;text:string}):Promise<string>;
 reconcile(owner:BrowserOwner,input:{conversation:GigaConversation;requestId:string}):Promise<string|null>;
 closeOwned(owner:BrowserOwner):Promise<void>;
 assertIdle():void;
 shutdown():Promise<void>;
}
