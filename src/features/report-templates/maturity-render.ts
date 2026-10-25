import type { Element, Document } from '@xmldom/xmldom';
import path from 'node:path';
import type { TemplateProfile } from './contracts';
import type { ReportSnapshot } from '../reporting/report-contracts';
import type { MaturityReportData, MaturityStats, MaturityTeam, MaturityPoint } from '../reporting/maturity-contracts';
import { maturityReportSchema } from '../reporting/maturity-contracts';
import { maturityStats } from '../reporting/maturity-data';
import { ActionError } from '../identity/role-service';
import { templatePackage as pkg, TEMPLATE_LIMITS } from './ooxml';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main', P = 'http://schemas.openxmlformats.org/presentationml/2006/main', R = 'http://schemas.openxmlformats.org/package/2006/relationships';
const colors = { met: '009E83', not_met: 'D97706', unknown: '78839D', excluded: '78839D', pending: 'A97700' };
const n = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value), pct = (value: number | null) => value === null ? 'Нет данных' : `${n(value)}%`, date = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString('ru-RU'), fail = (message: string): never => { throw new ActionError(message, 400); };
const ratio = (a: number, b: number) => b ? `${a}/${b}` : 'Нет данных';
export interface MaturityMapping {
    sourceSlide: number;
    outputSlide: number;
    shapeId: string;
    role: string;
    originalText: string;
    renderedText: string;
}
interface Geometry {
    x: number;
    y: number;
    w: number;
    h: number;
}
function geometry(node: Element): Geometry { const transform = pkg.all(node, A, 'xfrm')[0], off = transform && pkg.all(transform, A, 'off')[0], ext = transform && pkg.all(transform, A, 'ext')[0]; return { x: Number(off?.getAttribute('x')), y: Number(off?.getAttribute('y')), w: Number(ext?.getAttribute('cx')), h: Number(ext?.getAttribute('cy')) }; }
function color(node: Element, value: string) { for (const run of [...pkg.all(node, A, 'rPr'), ...pkg.all(node, A, 'defRPr'), ...pkg.all(node, A, 'endParaRPr')]) {
    let fill = pkg.all(run, A, 'solidFill')[0];
    if (!fill) {
        fill = run.ownerDocument!.createElementNS(A, 'a:solidFill');
        run.appendChild(fill);
    }
    while (fill.firstChild)
        fill.removeChild(fill.firstChild);
    const c = run.ownerDocument!.createElementNS(A, 'a:srgbClr');
    c.setAttribute('val', value);
    fill.appendChild(c);
} }
function isColoredBar(node: Element) { const value = pkg.all(pkg.all(node, P, 'spPr')[0], A, 'srgbClr')[0]?.getAttribute('val') ?? ''; if (!/^[a-f0-9]{6}$/i.test(value))
    return false; const parts = [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16)); return Math.max(...parts) - Math.min(...parts) > 45; }
function fill(node: Element, value: string) { const props = pkg.all(node, P, 'spPr')[0]; if (!props)
    return; for (const f of pkg.all(props, A, 'solidFill')) {
    while (f.firstChild)
        f.removeChild(f.firstChild);
    const c = f.ownerDocument!.createElementNS(A, 'a:srgbClr');
    c.setAttribute('val', value);
    f.appendChild(c);
} }
function box(node: Element, patch: Partial<Geometry>) { const t = pkg.all(node, A, 'xfrm')[0], off = t && pkg.all(t, A, 'off')[0], ext = t && pkg.all(t, A, 'ext')[0]; if (patch.x !== undefined)
    off?.setAttribute('x', String(Math.round(patch.x))); if (patch.y !== undefined)
    off?.setAttribute('y', String(Math.round(patch.y))); if (patch.w !== undefined)
    ext?.setAttribute('cx', String(Math.max(1, Math.round(patch.w)))); if (patch.h !== undefined)
    ext?.setAttribute('cy', String(Math.max(1, Math.round(patch.h)))); }
function textFit(node: Element, value: string, minPt = 9) { const g = geometry(node), old = Number(pkg.all(node, A, 'rPr')[0]?.getAttribute('sz') ?? 1200) / 100; const charsPerLine = Math.max(1, Math.floor(g.w / 12700 / (old * .52))); const lines = Math.max(1, Math.ceil(value.length / charsPerLine)); const maxPt = g.h / 12700 / (lines * 1.2), size = Math.max(minPt, Math.min(old, maxPt)); for (const r of [...pkg.all(node, A, 'rPr'), ...pkg.all(node, A, 'defRPr'), ...pkg.all(node, A, 'endParaRPr')])
    r.setAttribute('sz', String(Math.round(size * 100))); const body = pkg.all(node, A, 'bodyPr')[0]; if (body) {
    body.setAttribute('wrap', 'square');
    body.setAttribute('anchor', 'ctr');
} pkg.setText(node, value); }
function sourceFooter(data: MaturityReportData) { return `Период ${date(data.current.period)} · ${data.current.sourceText} · ${data.current.stale ? 'исторический срез' : 'актуальность по источнику'} · ${data.validation === 'confirmed' ? 'подтверждено УОР' : 'УОР не подтвердил'} · ${data.current.historicalBasis === 'legacy' ? 'правила и имена: текущий справочник' : 'сохранённая методика'}`; }
function failureText(team: MaturityTeam) { const unmet = team.metrics.filter(m => m.state === 'not_met' || m.state === 'unknown').map(m => m.state === 'not_met' ? `${m.name}: ${n(m.value)}${m.unit} / ${n(m.target)}${m.unit}` : `${m.name}: нет достоверного факта`); if (unmet.length)
    return unmet.join('; '); if (team.state === 'excluded')
    return 'Нет применимых метрик: исключения / нет событий'; return `Все ${team.stats.metricsEligible} доступные метрики выполнены${team.stats.metricsExcluded ? `; исключено ${team.stats.metricsExcluded}` : ''}`; }
function delta(value: number, previous: number | null, word = '') { if (previous === null)
    return 'Нет сравнения'; const d = value - previous; return `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)}${word ? ' ' + word : ''}`; }
function statusText(data: MaturityReportData) { return data.officialStatus === 'unknown' ? 'Недостаточно данных для вывода' : data.officialStatus === 'not_met' ? 'Официальная цель не выполнена' : data.validation === 'confirmed' ? 'Выполнение подтверждено УОР' : 'Выполнено по расчёту · проверка УОР'; }
function leaderStatus(stats: MaturityStats, target: number | null) { return stats.teamsUnknown ? 'Есть команды без достоверного факта' : target === null ? 'Официальный порог не задан' : stats.teamShare === null ? 'Нет применимых команд' : stats.teamShare < target ? `Ниже официальной цели ${pct(target)}` : `Порог ${pct(target)} достигнут · подтверждение УОР отдельно`; }
/** Complete editable OOXML mapping for the supplied maturity template family. */
export async function renderMaturityTemplate(bytes: Buffer, profile: TemplateProfile, report: ReportSnapshot, options: {
    mapping?: (items: MaturityMapping[]) => void;
} = {}): Promise<Buffer> {
    if (!profile.preset || !report.maturity)
        fail('Для пресета модели зрелости нужен сформированный подробный снимок');
    const preset = profile.preset!, data = maturityReportSchema.parse(report.maturity);
    if (data.goalId !== preset.goalId)
        fail('Цель шаблона и отчёта различается');
    const zip = await pkg.load(bytes), { presentation, rels, paths } = await pkg.orderedSlides(zip), types = pkg.xml(await zip.file('[Content_Types].xml')!.async('text')), list = pkg.all(presentation, P, 'sldIdLst')[0];
    if (!list)
        fail('Нет списка слайдов');
    while (list.firstChild)
        list.removeChild(list.firstChild);
    for (const rel of pkg.all(rels, R, 'Relationship').filter(r => r.getAttribute('Type')?.endsWith('/slide')))
        rel.parentNode!.removeChild(rel);
    const mapping: MaturityMapping[] = [], generatedPaths = new Map<string, string>();
    let count = 0, expanded = bytes.length;
    const originals = await Promise.all(paths.map(async (p) => pkg.xml(await zip.file(p)!.async('text'))));
    async function emit(source: number, mutate: (doc: Document, put: (node: Element, value: string, role: string, c?: string) => void) => void) {
        count++;
        if (count > TEMPLATE_LIMITS.outputSlides)
            fail('Превышен размер отчёта');
        const doc = originals[source - 1].cloneNode(true) as Document, records: MaturityMapping[] = [];
        const put = (node: Element, value: string, role: string, c?: string) => { const originalText = pkg.text(node); textFit(node, value); if (c)
            color(node, c); records.push({ sourceSlide: source, outputSlide: count, shapeId: pkg.shapeId(node), role, originalText, renderedText: value }); };
        const textNodes = pkg.shapeNodes(doc).filter(n => pkg.all(n, A, 't').length);
        const dateNode = textNodes.find(n => /^\d{2}\.\d{2}\.\d{4}$/.test(pkg.text(n)));
        if (dateNode)
            put(dateNode, date(data.current.period), 'header.period');
        const page = textNodes.find(n => /^\d{2}$/.test(pkg.text(n)) && geometry(n).x > 11 * 914400);
        if (page)
            put(page, String(count).padStart(2, '0'), 'header.page');
        const footer = textNodes.find(n => pkg.text(n).startsWith('Источник:'));
        if (footer) {
            box(footer, { h: 210000 });
            put(footer, sourceFooter(data), 'footer.provenance');
        }
        mutate(doc, put);
        for (const node of textNodes)
            if (!records.some(r => r.shapeId === pkg.shapeId(node)))
                records.push({ sourceSlide: source, outputSlide: count, shapeId: pkg.shapeId(node), role: 'static.methodology-or-brand', originalText: pkg.text(node), renderedText: pkg.text(node) });
        mapping.push(...records);
        const newName = `uor-maturity-${count}.xml`, newPath = `ppt/slides/${newName}`, content = pkg.serialize(doc);
        expanded += Buffer.byteLength(content);
        if (expanded > TEMPLATE_LIMITS.expanded)
            fail('Отчёт превышает64МБ');
        zip.file(newPath, content);
        if (!generatedPaths.has(paths[source - 1]))
            generatedPaths.set(paths[source - 1], newPath);
        const originalRels = zip.file(paths[source - 1].replace(/\/([^/]+)$/, '/_rels/$1.rels'));
        if (originalRels) {
            const rdoc = pkg.xml(await originalRels.async('text'));
            for (const n of pkg.all(rdoc, R, 'Relationship').filter(n => n.getAttribute('Type')?.endsWith('/notesSlide')))
                n.parentNode!.removeChild(n);
            zip.file(`ppt/slides/_rels/${newName}.rels`, pkg.serialize(rdoc));
        }
        const id = `rIdUorMaturity${count}`, relation = rels.createElementNS(R, 'Relationship');
        relation.setAttribute('Id', id);
        relation.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide');
        relation.setAttribute('Target', `slides/${newName}`);
        rels.documentElement!.appendChild(relation);
        const slide = presentation.createElementNS(P, 'p:sldId');
        slide.setAttribute('id', String(255 + count));
        slide.setAttribute('r:id', id);
        list.appendChild(slide);
        const override = types.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override');
        override.setAttribute('PartName', `/${newPath}`);
        override.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml');
        types.documentElement!.appendChild(override);
    }
    const texts = (doc: Document) => pkg.shapeNodes(doc).filter(n => pkg.all(n, A, 't').length), find = (nodes: Element[], value: string) => nodes.find(n => pkg.text(n) === value) ?? fail(`В шаблоне отсутствует блок «${value}»`);
    function card(nodes: Element[], label: string, stats: MaturityStats, old: MaturityStats | null, role: string, put: (node: Element, value: string, role: string, c?: string) => void, kind: 'teams' | 'metrics' | 'failures') {
        const at = nodes.indexOf(find(nodes, label)), group = nodes.slice(at + 1, at + (kind === 'failures' ? 4 : 5));
        if (kind === 'failures') {
            put(group[0], String(stats.teamsEligible - stats.teamsMet - stats.teamsUnknown), role + '.actual', stats.teamsEligible - stats.teamsMet - stats.teamsUnknown ? colors.not_met : colors.met);
            put(group[1], old ? `Было ${old.teamsEligible - old.teamsMet - old.teamsUnknown}` : 'Базовый период не выбран', role + '.baseline');
            put(group[2], delta(stats.teamsEligible - stats.teamsMet - stats.teamsUnknown, old ? old.teamsEligible - old.teamsMet - old.teamsUnknown : null), role + '.delta', colors.unknown);
            return;
        }
        const met = kind === 'teams' ? stats.teamsMet : stats.metricsMet, total = kind === 'teams' ? stats.teamsEligible : stats.metricsEligible, previous = old ? (kind === 'teams' ? old.teamsMet : old.metricsMet) : null;
        put(group[0], ratio(met, total), role + '.ratio');
        put(group[1], pct(kind === 'teams' ? stats.teamShare : stats.metricShare), role + '.percentage', stats.teamsUnknown || stats.metricsUnknown ? colors.unknown : kind === 'teams' && (stats.teamShare ?? 0) < (data.officialTarget ?? 101) ? colors.not_met : colors.met);
        put(group[2], old ? `Было ${kind === 'teams' ? ratio(old.teamsMet, old.teamsEligible) : ratio(old.metricsMet, old.metricsEligible)}` : 'Базовый период не выбран', role + '.baseline');
        put(group[3], delta(met, previous, kind === 'teams' ? 'команд' : 'метрик'), role + '.delta', colors.unknown);
    }
    await emit(1, (doc, put) => {
        const ns = texts(doc);
        put(find(ns, 'Модель зрелости ДИТ'), data.goalTitle, 'overview.goalTitle');
        const title = ns.find(n => pkg.text(n).includes('→') && pkg.text(n).includes('метрик'))!;
        put(title, `${date(data.current.period)} · ${data.current.teams.length} команд · ${data.metricIds.length} метрик${data.comparable ? ` · сравнение с ${date(data.baseline!.period)}` : ' · без сопоставимого базового периода'}`, 'overview.scope');
        const target = ns.find(n => pkg.text(n).startsWith('Цель IV квартала'))!;
        put(target, `Цель ${pct(data.officialTarget)} · ${statusText(data)}`, 'overview.officialStatus', data.validation === 'confirmed' ? colors.met : data.officialStatus === 'not_met' ? colors.not_met : colors.pending);
        card(ns, 'Команды: все доступные метрики выполнены', data.current.summary, data.comparable ? data.baseline!.summary : null, 'overview.teams', put, 'teams');
        card(ns, 'Метрики: выполнено / доступно', data.current.summary, data.comparable ? data.baseline!.summary : null, 'overview.metrics', put, 'metrics');
        const f = ns.indexOf(find(ns, 'Невыполненные метрики'));
        put(ns[f + 1], String(data.current.summary.metricsEligible - data.current.summary.metricsMet - data.current.summary.metricsUnknown), 'overview.unmetMetrics', colors.not_met);
        put(ns[f + 2], data.comparable ? `Было ${data.baseline!.summary.metricsEligible - data.baseline!.summary.metricsMet - data.baseline!.summary.metricsUnknown}` : 'Базовый период не выбран', 'overview.unmetBaseline');
        put(ns[f + 3], delta(data.current.summary.metricsEligible - data.current.summary.metricsMet - data.current.summary.metricsUnknown, data.comparable ? data.baseline!.summary.metricsEligible - data.baseline!.summary.metricsMet - data.baseline!.summary.metricsUnknown : null), 'overview.unmetDelta');
        const first = ns.indexOf(find(ns, 'Метрики в целеполагании')) + 1;
        for (let i = 0; i < 5; i++) {
            const slots = ns.slice(first + i * 4, first + i * 4 + 4), metric = data.current.metrics[i];
            if (!metric) {
                for (const slot of slots)
                    put(slot, '', 'overview.unusedMetric');
                continue;
            }
            put(slots[0], preset.metricLabels[i] ?? metric.name, `metric.${metric.id}.label`);
            put(slots[1], ratio(metric.met, metric.available), `metric.${metric.id}.ratio`);
            put(slots[2], pct(metric.share), `metric.${metric.id}.percentage`, metric.unknown ? colors.unknown : metric.met < metric.available ? colors.not_met : colors.met);
            put(slots[3], metric.unknown ? `Нет факта: ${metric.unknown}` : metric.met < metric.available ? `Не выполнено: ${metric.available - metric.met}` : 'Все доступные выполнены', `metric.${metric.id}.note`, metric.unknown ? colors.unknown : metric.met < metric.available ? colors.not_met : colors.met);
            const g = geometry(slots[0]);
            for (const node of pkg.shapeNodes(doc).filter(n => !pkg.all(n, A, 't').length)) {
                const b = geometry(node);
                if (b.x >= g.x - 10000 && b.x < g.x + g.w && b.y > g.y + 600000 && b.y < g.y + 1100000 && b.h < 80000 && b.w > 500000) {
                    if (isColoredBar(node)) {
                        box(node, { w: Math.max(1, g.w * (metric.share ?? 0) / 100) });
                        fill(node, metric.met < metric.available ? colors.not_met : colors.met);
                    }
                }
            }
        }
        const focus = ns.indexOf(find(ns, 'Где остаются просадки'));
        const failures = data.current.metrics.filter(m => m.unmetTeams.length);
        put(ns[focus + 1], failures[0] ? `${preset.metricLabels[data.metricIds.indexOf(failures[0].id)] ?? failures[0].name}: ${failures[0].unmetTeams.join(' · ')}` : 'Подтверждённых отклонений в полученных фактах нет', 'overview.focus1', failures.length ? colors.not_met : colors.unknown);
        put(ns[focus + 2], failures[1] ? `${preset.metricLabels[data.metricIds.indexOf(failures[1].id)] ?? failures[1].name}: ${failures[1].unmetTeams.join(' · ')}` : data.current.summary.metricsUnknown ? `Неизвестных значений: ${data.current.summary.metricsUnknown}` : '', 'overview.focus2', colors.not_met);
        put(ns[focus + 3], `Исключено метрик: ${data.current.summary.metricsExcluded}; неизвестных: ${data.current.summary.metricsUnknown}. ${data.current.historicalBasis === 'legacy' ? 'История правил не сохранена.' : ''}`, 'overview.coverageNote', colors.unknown);
    });
    const summaryNodes = texts(originals[1]), summaryBadges = summaryNodes.filter(n => /^Команды \d+\//.test(pkg.text(n))), summaryCapacity = summaryBadges.length;
    if(summaryCapacity<1||summaryCapacity>8)fail('В шаблоне не распознаны карточки ИТ-лидеров');
    for (let start = 0; start < Math.max(1, data.leaders.length); start += summaryCapacity)
        await emit(2, (doc, put) => { const ns = texts(doc), badges = ns.filter(n => /^Команды \d+\//.test(pkg.text(n))); const subtitle = ns.find(n => pkg.text(n).includes('оставшиеся невыполнения'))!; put(subtitle, `${date(data.current.period)} · ${data.comparable ? 'сопоставимые изменения' : 'сравнение не рассчитано'} · ${data.current.historicalBasis === 'legacy' ? 'имена из текущего справочника' : 'сохранённая организация'}`, 'leaders.subtitle'); for (let i = 0; i < badges.length; i++) {
            const at = ns.indexOf(badges[i]), leader = data.leaders[start + i], group = ns.slice(at - 1, at + 3);
            if (!leader) {
                for (const node of group)
                    put(node, '', 'leaders.emptySlot');
                continue;
            }
            put(group[0], leader.name, 'leaders.name');
            put(group[1], `Команды ${ratio(leader.current.teamsMet, leader.current.teamsEligible)} · ${pct(leader.current.teamShare)}`, 'leaders.teamRatio', leader.current.teamsUnknown ? colors.unknown : leader.current.teamShare !== null && leader.current.teamShare >= (data.officialTarget ?? 101) ? colors.met : colors.not_met);
            put(group[2], `Метрики ${ratio(leader.current.metricsMet, leader.current.metricsEligible)} · ${data.comparable ? delta(leader.current.teamsMet, leader.baseline?.teamsMet ?? null, 'команд') : 'Без сравнения'} · неизвестно ${leader.current.metricsUnknown}`, 'leaders.metricRatio');
            const problems = leader.teams.filter(t => t.state === 'not_met' || t.state === 'unknown');
            put(group[3], problems.length ? `${problems.length} команд требуют внимания · ${leaderStatus(leader.current,data.officialTarget)}` : 'Все доступные метрики выполнены · подтверждение УОР отдельно', 'leaders.unmet', problems.length ? colors.not_met : colors.met);
            const nameBox=geometry(group[0]),badgeBox=geometry(group[1]),tone=leader.current.teamsUnknown?colors.unknown:problems.length?colors.not_met:colors.met;
            for(const shape of pkg.shapeNodes(doc).filter(node=>!pkg.all(node,A,'t').length)){const g=geometry(shape);if(g.x<nameBox.x&&g.x>nameBox.x-250000&&g.y<nameBox.y+50000&&g.y+g.h>nameBox.y&&g.w<100000)fill(shape,tone);if(g.x<=badgeBox.x+100000&&g.x+g.w>=badgeBox.x+badgeBox.w-100000&&g.y<badgeBox.y+50000&&g.y+g.h>badgeBox.y&&g.w<2.5*914400)fill(shape,tone===colors.met?'E6F6F0':tone===colors.not_met?'FFF1DF':'EEF1F6');}
        } });
    for (let gigaStart = 0; gigaStart < Math.max(1, data.leaders.length); gigaStart += 8)
        await emit(3, (doc, put) => {
            const ns = texts(doc), unknownIndex = ns.indexOf(find(ns, 'Нет данных')), point = data.separate.point, stat = point?.summary, title = ns.find(n => pkg.text(n).includes('GigaCode') && geometry(n).y > 500000 && geometry(n).y < 1200000)!;
            put(title, data.separate.title, 'separate.title');
            const subtitle = ns.find(n => pkg.text(n).includes('отдельная метрика'))!;
            put(subtitle, `${date(data.current.period)} · отдельная цель · ${point ? 'факты загружены' : 'данные не загружены'}`, 'separate.scope');
            let at = ns.indexOf(find(ns, 'Команды достигли цели'));
            put(ns[at + 1], stat ? ratio(stat.teamsMet, stat.teamsEligible) : 'Нет данных', 'separate.met');
            put(ns[at + 2], stat ? pct(stat.teamShare) : '—', 'separate.share', colors.unknown);
            put(ns[at + 3], point ? 'По настроенному составу' : 'Исходные значения удалены', 'separate.coverage');
            put(ns[at + 4], `Цель: ${pct(data.separate.target)}`, 'separate.target');
            at = ns.indexOf(find(ns, 'Ниже целевого уровня'));
            put(ns[at + 1], stat ? String(stat.teamsEligible - stat.teamsMet - stat.teamsUnknown) : '—', 'separate.below');
            put(ns[at + 2], point ? 'Команды с отклонением' : 'Нужен отдельный снимок', 'separate.action');
            at = unknownIndex;
            put(ns[at + 1], stat ? String(stat.teamsUnknown) : '—', 'separate.unknown');
            put(ns[at + 2], point ? 'Проверить передачу данных' : 'Контур и факты не заданы', 'separate.unknownScope');
            const hundred = ns.find(n => pkg.text(n) === '100%');
            if (hundred)
                put(hundred, pct(data.separate.target), 'separate.targetLarge');
            const caption = ns.find(n => pkg.text(n).includes('пользуйтесь GigaCode'))!;
            put(caption, point ? 'Отдельная цель: не включена в метрики модели зрелости' : 'Выберите отдельную цель и загрузите её факты. Данные образца не используются.', 'separate.notice');
            const tableHeader = ns.findIndex(n => pkg.text(n) === 'Лидер');
            let body = tableHeader + 4;
            for (let i = 0; i < 8; i++) {
                const leader = data.leaders[gigaStart + i], t = point?.teams.filter(t => t.leaderId === leader?.id), s = t ? maturityStats(t) : null;
                const group = ns.slice(body + i * 4, body + i * 4 + 4);
                put(group[0], leader?.name ?? '', 'separate.leader');
                put(group[1], leader ? (s ? `${ratio(s.teamsMet, s.teamsEligible)} · ${pct(s.teamShare)}` : 'Нет данных') : '', 'separate.leaderRatio', colors.unknown);
                put(group[2], leader && s ? String(s.teamsEligible - s.teamsMet - s.teamsUnknown) : leader ? '—' : '', 'separate.leaderBelow', colors.unknown);
                put(group[3], leader ? (s ? String(s.teamsUnknown) : '—') : '', 'separate.leaderUnknown', colors.unknown);
            }
            const worst = point?.teams.flatMap(t => t.metrics.filter(m => m.value !== null && m.state !== 'excluded' && m.state !== 'unknown').map(m => ({ name: t.name, value: m.value! }))).sort((a, b) => a.value - b.value).slice(0, 5) ?? [];
            const slots = ns.filter(n => /^\d+\. /.test(pkg.text(n)));
            for (let i = 0; i < slots.length; i++) {
                const index = ns.indexOf(slots[i]), row = worst[i];
                put(slots[i], row ? `${i + 1}. ${row.name}` : i === 0 ? 'Нет загруженных значений' : '', `separate.worst.${i}.name`);
                put(ns[index + 1], row ? pct(row.value) : '', `separate.worst.${i}.value`, colors.unknown);
                const b = geometry(slots[i]);
                for (const node of pkg.shapeNodes(doc).filter(n => !pkg.all(n, A, 't').length)) {
                    const g = geometry(node);
                    if (g.y >= b.y && g.y < b.y + 300000 && g.x > 7 * 914400 && g.h < 100000 && g.w > 100000 && g.w < 3 * 914400 && isColoredBar(node)) {
                        box(node, { w: row ? 2.15 * 914400 * Math.max(0, Math.min(100, row.value)) / 100 : 1 });
                        fill(node, row && row.value < 80 ? colors.not_met : colors.unknown);
                    }
                }
            }
            const missing = ns.find(n => pkg.text(n).startsWith('Нет данных:'));
            if (missing)
                put(missing, point ? `Нет данных: ${point.teams.filter(t => t.state === 'unknown').map(t => t.name).join(' · ') || 'нет'}` : 'Контур, источник и период отдельной цели GigaCode не заданы', 'separate.missingList');
        });
    for (const [index, leader] of data.leaders.entries()) {
        const source = Math.min(4 + index, paths.length), original = originals[source - 1], ns = texts(original), header = ns.indexOf(find(ns, 'Команда')), footer = ns.findIndex(n => pkg.text(n).startsWith('Источник:')), slots = ns.slice(header + 4, footer), capacity = slots.length / 4;
        if (!Number.isInteger(capacity) || capacity < 1)
            fail('Не распознаны строки команд шаблона');
        const teams = [...leader.teams].sort((a, b) => ({ not_met: 0, unknown: 1, met: 2, excluded: 3 }[a.state] - { not_met: 0, unknown: 1, met: 2, excluded: 3 }[b.state]) || a.name.localeCompare(b.name, 'ru'));
        for (let start = 0; start < Math.max(1, teams.length); start += capacity)
            await emit(source, (doc, put) => {
                const nodes = texts(doc), title = nodes.find(n => pkg.text(n).includes('— результат команд'))!;
                put(title, `${leader.name} — результат команд${start ? ` · продолжение ${Math.floor(start / capacity) + 1}` : ''}`, 'detail.leaderTitle');
                const subtitle = nodes.find(n => pkg.text(n).includes('→'))!;
                put(subtitle, `${date(data.current.period)} · ${data.comparable ? `сравнение с ${date(data.baseline!.period)}` : 'без сопоставимого базового периода'} · неизвестно: ${leader.current.teamsUnknown}`, 'detail.scope');
                card(nodes, 'Команды: все доступные метрики выполнены', leader.current, data.comparable ? leader.baseline : null, 'detail.teams', put, 'teams');
                card(nodes, 'Метрики: выполнено / доступно', leader.current, data.comparable ? leader.baseline : null, 'detail.metrics', put, 'metrics');
                card(nodes, 'Команды с невыполнениями', leader.current, data.comparable ? leader.baseline : null, 'detail.failures', put, 'failures');
                const h = nodes.indexOf(find(nodes, 'Команда'));
                put(nodes[h + 1], data.comparable ? date(data.baseline!.period) : 'Базовый период', 'detail.baselineHeading');
                put(nodes[h + 2], date(data.current.period), 'detail.currentHeading');
                const end = nodes.findIndex(n => pkg.text(n).startsWith('Период '));
                const bodyNodes = nodes.slice(h + 4, end);
                for (let i = 0; i < capacity; i++) {
                    const group = bodyNodes.slice(i * 4, i * 4 + 4), team = teams[start + i];
                    if (!team) {
                        for (const node of group)
                            put(node, '', 'detail.unusedRow');
                        continue;
                    }
                    const previous = data.comparable ? leader.previousTeams.find(t => t.id === team.id) : null, first = geometry(group[0]), rowBottom = group.length && i < capacity - 1 ? geometry(bodyNodes[(i + 1) * 4]).y : first.y + 350000;
                    for (const cell of group)
                        box(cell, { y: geometry(cell).y - 45000, h: Math.max(180000, rowBottom - first.y - 20000) });
                    put(group[0], team.name, 'detail.teamName');
                    put(group[1], previous ? ratio(previous.stats.metricsMet, previous.stats.metricsEligible) : '—', 'detail.previous');
                    put(group[2], ratio(team.stats.metricsMet, team.stats.metricsEligible), 'detail.current', colors[team.state]);
                    put(group[3], failureText(team), 'detail.unmet', colors[team.state]);
                    const currentBox = geometry(group[2]);
                    for (const shape of pkg.shapeNodes(doc).filter(n => !pkg.all(n, A, 't').length)) {
                        const g = geometry(shape);
                        if (g.y <= first.y + 70000 && g.y + g.h > first.y && g.h < 800000 && g.x >= .5 * 914400) {
                            if (g.w < 100000)
                                fill(shape, colors[team.state]);
                            else if (g.x < currentBox.x + 100000 && g.x + g.w > currentBox.x && g.w < 2 * 914400)
                                fill(shape, team.state === 'met' ? 'E6F6F0' : team.state === 'not_met' ? 'FFF1DF' : 'EEF1F6');
                            else if(g.w>914400)fill(shape,team.state==='not_met'?'FFF8EF':team.state==='unknown'?'F1F3F7':i%2?'F3FAF7':'FFFFFF');
                        }
                    }
                }
            });
    }
    for (const file of Object.values(zip.files).filter(f => /^ppt\/slides\/_rels\/uor-maturity-\d+\.xml\.rels$/.test(f.name))) {
        const doc = pkg.xml(await file.async('text'));
        for (const rel of pkg.all(doc, R, 'Relationship').filter(r => r.getAttribute('Type')?.endsWith('/slide') && r.getAttribute('TargetMode') !== 'External')) {
            const target = rel.getAttribute('Target') ?? '', originalTarget = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`ppt/slides/${target}`), replacement = generatedPaths.get(originalTarget);
            if (replacement)
                rel.setAttribute('Target', path.posix.relative('ppt/slides', replacement));
            else
                rel.parentNode!.removeChild(rel);
        }
        zip.file(file.name, pkg.serialize(doc));
    }
    for (const original of paths) {
        zip.remove(original);
        zip.remove(original.replace(/\/([^/]+)$/, '/_rels/$1.rels'));
        for (const override of Array.from(types.getElementsByTagName('Override')).filter(e => e.getAttribute('PartName') === `/${original}`))
            override.parentNode!.removeChild(override);
    }
    pkg.cleanRemovedSlideParts(zip,types);
    zip.file('ppt/presentation.xml', pkg.serialize(presentation));
    zip.file('ppt/_rels/presentation.xml.rels', pkg.serialize(rels));
    zip.file('[Content_Types].xml', pkg.serialize(types));
    options.mapping?.(mapping);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
