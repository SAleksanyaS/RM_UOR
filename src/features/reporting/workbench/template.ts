/** Version one remains stable so saved report templates can be reproduced exactly. */
export const goalReportTemplateText = JSON.stringify({ id: 'goal-management-v1', version: 1, style: { background: 'F6F7FB', accent: '6741BD', font: 'Arial' }, sections: ['summary', 'matrix', 'comparison', 'quality'] });
export const goalReportTemplateBytes = () => Buffer.from(goalReportTemplateText, 'utf8');
