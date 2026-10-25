import type {CatalogSnapshot,DomainChangeEvent,LocalSnapshot,SourceDefinition} from '../../domain/contracts';
/** Reader data includes provenance, never automation settings or mapping editors. */
export function readerSource(source:SourceDefinition):SourceDefinition{
 const {collection,importProfile,...publicSource}=source;
 return {...publicSource,collectionConfigured:!!collection,interactiveLogin:collection?.adapter==='browser'};
}
export function readerCatalog(catalog:CatalogSnapshot):CatalogSnapshot{return {...catalog,sources:catalog.sources.map(readerSource)};}
export function readerSnapshot(snapshot:LocalSnapshot):LocalSnapshot{
 const {ownerInstallationId:_installation,ownerSessionId:_session,...publicSnapshot}=snapshot;
 const basis=snapshot.evaluationBasis;
 return {...publicSnapshot,...(basis?{evaluationBasis:{...basis,...(basis.organization?{organization:{...basis.organization,sources:basis.organization.sources?.map(readerSource)}}:{})}}:{})};
}
const hiddenFields=new Set(['collection','importProfile','ownerInstallationId','ownerSessionId','authProfileId','password','hash','salt']);
function publicValue(value:unknown):unknown{if(Array.isArray(value))return value.map(publicValue);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!hiddenFields.has(key)).map(([key,child])=>[key,publicValue(child)]));return value;}
export function readerChange(change:DomainChangeEvent):DomainChangeEvent{return {...change,fields:change.fields.filter(item=>!item.field.split(/[./]/).some(field=>hiddenFields.has(field))).map(item=>({...item,before:publicValue(item.before),after:publicValue(item.after)}))};}
