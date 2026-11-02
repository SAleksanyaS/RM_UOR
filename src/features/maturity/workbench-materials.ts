import bundle from '../../../data/reference/maturity-2026-10-30.json';
import { maturityMaterialBundleSchema,maturitySnapshotSchema,type MaturityMaterialBundle,type MaturityDefinition,type MaturitySnapshot } from './workbench-contracts';
import { evaluateMaturity } from './workbench-evaluate';
export function loadMaturityMaterials():MaturityMaterialBundle{return maturityMaterialBundleSchema.parse(bundle);}
export function makeMaturityDefinitions(materials:MaturityMaterialBundle):MaturityDefinition{return {id:materials.id,revision:1,period:materials.period,policyVersion:'strict-unapproved-applicability-v1',teamIds:materials.teams.map(t=>t.id),metrics:structuredClone(materials.metrics),teamSuccess:'all_expected_metrics_met',authority:'application_conservative'};}
export function createMaturitySnapshot(materials:MaturityMaterialBundle,period=materials.period):MaturitySnapshot{
 const definition=makeMaturityDefinitions(materials);definition.period=period;
 return maturitySnapshotSchema.parse({schemaVersion:1,kind:'dit-maturity-2026-10-v1',period,definition,teams:materials.teams,metrics:materials.metrics,leaders:materials.leaders,evaluation:evaluateMaturity({definition,observations:materials.observations,reportedClaims:materials.reportedClaims}),reportedClaims:materials.reportedClaims,sources:materials.sources,limitations:materials.limitations,comparableHistory:false});
}
