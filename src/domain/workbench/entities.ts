export type * from './entities/goals';
export type * from './entities/methods';
export type * from './entities/directory';
export type * from './entities/sources';
export type * from './entities/states';
export type * from './entities/execution';
export type * from './entities/extensions';
export type * from './entities/evaluation';
export type * from './entities/notifications';
import type { CoreGoalDefinition, GoalAssignment, Template } from './entities/goals';
import type { MetricDefinition, MethodVersion } from './entities/methods';
import type { DirectoryEntity, DirectoryLink } from './entities/directory';
import type { SourceFieldMapping, SourceDefinition, Capture, ObservedFact } from './entities/sources';
import type { Applicability, ManualCorrection, ManualStatusEvent } from './entities/states';
import type { Work, WorkDependency, Decision } from './entities/execution';
import type { CustomFieldDef, CustomFieldValue, Commentary, Evidence, DashboardDef } from './entities/extensions';
import type { BusinessCalendar, ReminderSettings } from './entities/notifications';
import type { EvaluationBasis, CalculationResult, Attestation, AgreedSnapshot } from './entities/evaluation';

export type WorkbenchEntityMap = {
  core_goal_definition: CoreGoalDefinition; goal_assignment: GoalAssignment; template: Template; metric_definition: MetricDefinition; method_version: MethodVersion;
  directory_entity: DirectoryEntity; directory_link: DirectoryLink; source_field_mapping: SourceFieldMapping; source_definition: SourceDefinition;
  capture: Capture; observed_fact: ObservedFact; applicability: Applicability; manual_correction: ManualCorrection; manual_status_event: ManualStatusEvent;
  work: Work; work_dependency: WorkDependency; decision: Decision; custom_field_def: CustomFieldDef; custom_field_value: CustomFieldValue;
  commentary: Commentary; evidence: Evidence; dashboard_def: DashboardDef; business_calendar: BusinessCalendar; reminder_settings: ReminderSettings;
  evaluation_basis: EvaluationBasis; calculation_result: CalculationResult; attestation: Attestation; agreed_snapshot: AgreedSnapshot;
};
export type WorkbenchEntityType = keyof WorkbenchEntityMap;
export type WorkbenchEntity = WorkbenchEntityMap[WorkbenchEntityType];
