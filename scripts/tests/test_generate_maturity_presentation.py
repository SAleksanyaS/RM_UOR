"""Synthetic, independent fixtures for the maturity workbook data layer."""
from __future__ import annotations

import datetime as dt
from decimal import Decimal
import json
from pathlib import Path
import tempfile
import unittest

from openpyxl import Workbook

import importlib.util
import sys
_SCRIPT = Path(__file__).resolve().parents[1] / "generate-maturity-presentation.py"
_spec = importlib.util.spec_from_file_location("maturity_generator_under_test", _SCRIPT)
model = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = model
_spec.loader.exec_module(model)

HEADERS = [
    "Блок", "Трайб", "Кластер", "Команда", "Этап APP", "Группа практик", "Метрика",
    "Доля команд", "Команд достигли", "Всего команд", "Доля метрик", "Метрик достигли",
    "Всего метрик", "Значение метрики", "Цель метрики",
]
LABELS = [
    "Доля Историй и Багов, связанных с кодом", "Доля PR, связанных с задачей",
    "Доля авторазвертываний ПРОД",
    "Индекс достаточности описания задач для принятия решений об участии в ПСИ",
    "Индекс зрелости выполнения архитектурных требований по Истории перед ПСИ",
]
TARGETS = ["70%", "80%", "80%", "95%", "70%"]
TODAY = dt.date(2030, 2, 20)


def team_rows(code="SYN001", values=None, reported=(5, 5), name="Команда А"):
    values = ["100%"] * 5 if values is None else values
    common = {"Блок": "Блок А", "Трайб": "Трайб А", "Кластер": "Кластер А",
              "Команда": f"{name} ({code})"}
    rows = [{**common, "Доля метрик": "100%", "Метрик достигли": reported[0],
             "Всего метрик": reported[1]}]
    for label, value, target in zip(LABELS, values, TARGETS):
        rows.append({**common, "Этап APP": "Этап", "Группа практик": "Группа",
                     "Метрика": label, "Значение метрики": value, "Цель метрики": target})
    return rows


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(model, "The requested data layer has not been implemented yet")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def book(self, rows, *, headers=None, preamble=0, extra_sheet=False):
        wb = Workbook()
        ws = wb.active
        ws.title = "Данные"
        headers = HEADERS if headers is None else headers
        for _ in range(preamble):
            ws.append(["Синтетическая проверочная выгрузка"])
        ws.append(headers)
        for values in rows:
            ws.append([values.get(header) for header in headers])
        if extra_sheet:
            ws2 = wb.create_sheet("Вторая")
            ws2.append(headers)
            for values in rows:
                ws2.append([values.get(header) for header in headers])
        path = self.root / "fixture.xlsx"
        wb.save(path)
        wb.close()
        return path

    def read(self, rows, **kwargs):
        return model.read_snapshot(self.book(rows, **kwargs), TODAY, {"SYN001": "Лидер А"})

    def test_hierarchy_totals_never_duplicate_teams_or_leaf_counts(self):
        parents = [
            {"Блок": "Блок А", "Команд достигли": 99, "Всего команд": 100},
            {"Блок": "Блок А", "Трайб": "Трайб А", "Команд достигли": 99, "Всего команд": 100},
            {"Блок": "Блок А", "Трайб": "Трайб А", "Кластер": "Кластер А"},
        ]
        rows = parents + team_rows() + team_rows(
            "SYN002", ["70%", "79,99%", "В исключениях", "Нет PR", "Нет данных"],
            reported=(1, 2), name="Команда Б")
        current = self.read(rows)
        self.assertEqual(set(current.teams), {"SYN001", "SYN002"})
        self.assertEqual(current.source_name, "fixture.xlsx")
        self.assertEqual(current.period, TODAY)
        self.assertEqual(model.summarize(current.teams.values()), {
            "teams": 2, "teams_met": 1, "metrics_met": 6, "metrics_available": 7,
            "below": 1, "missing": 1, "excluded": 1, "no_event": 1,
        })
        self.assertEqual(current.teams["SYN002"].leader, "Лидер не назначен")
        self.assertTrue(any("SYN002" in item for item in current.warnings))

    def test_absent_metric_rows_remain_missing_even_if_available_metrics_pass(self):
        current = self.read(team_rows(reported=(1, 1))[:2])
        team = current.teams["SYN001"]
        self.assertEqual((team.available, team.passed, team.missing), (1, 1, 4))
        self.assertTrue(team.all_available_met)
        self.assertEqual(team.observations["pr"].state, "missing")
        self.assertEqual(team.observations["pr"].row, 0)

    def test_all_non_numeric_metrics_do_not_make_a_team_met(self):
        team = self.read(team_rows(values=["В исключениях"] * 5, reported=(0, 0))).teams["SYN001"]
        self.assertEqual((team.available, team.passed, team.excluded), (0, 0, 5))
        self.assertFalse(team.all_available_met)

    def test_headers_found_by_name_after_preamble_and_column_reordering(self):
        current = self.read(team_rows(), headers=list(reversed(HEADERS)), preamble=4)
        self.assertEqual(current.teams["SYN001"].passed, 5)
        self.assertEqual(current.teams["SYN001"].observations["code"].row, 7)

    def test_table_can_start_after_an_empty_first_column(self):
        current = self.read(team_rows(), headers=[None] + HEADERS)
        self.assertEqual(current.teams["SYN001"].passed, 5)

    def test_percent_cell_formats_and_decimal_comparison_preserve_precision(self):
        from openpyxl import load_workbook
        path = self.book(team_rows(values=["69,9999%", "80%", "80%", "95%", "70%"], reported=(4, 5)))
        wb = load_workbook(path)
        ws = wb.active
        ws["N3"] = 0.699999
        ws["N3"].number_format = "0.00%"
        ws["O3"] = 0.7
        ws["O3"].number_format = "0%"
        ws["N4"] = 80
        ws["N4"].number_format = '0"%"'
        wb.save(path)
        wb.close()
        team = model.read_snapshot(path, TODAY, {}).teams["SYN001"]
        self.assertEqual(team.observations["code"].value, Decimal("69.9999"))
        self.assertFalse(team.observations["code"].passed)
        self.assertTrue(team.observations["pr"].passed)
        self.assertEqual((team.passed, team.available), (4, 5))

    def test_blank_values_do_not_become_zero_or_numeric(self):
        team = self.read(team_rows(values=[None, "Нет данных", "-", "нет pr", "В исключениях"],
                                   reported=(0, 0))).teams["SYN001"]
        self.assertEqual((team.available, team.missing, team.no_event, team.excluded), (0, 3, 1, 1))
        self.assertIsNone(team.observations["code"].value)

    def test_missing_reported_counts_are_not_invented(self):
        team = self.read(team_rows(reported=(None, None))).teams["SYN001"]
        self.assertIsNone(team.reported_met)
        self.assertIsNone(team.reported_available)
        self.assertEqual(team.available, 5)

    def test_disagreeing_reported_team_totals_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "SYN001"):
            self.read(team_rows(reported=(4, 5)))

    def test_unknown_leaf_metric_is_rejected_instead_of_mixed_with_goal(self):
        rows = team_rows()
        rows[1]["Метрика"] = "Доля использования GigaCode"
        with self.assertRaisesRegex(ValueError, "GigaCode"):
            self.read(rows)

    def test_missing_stable_team_code_is_rejected(self):
        rows = team_rows()
        rows[0]["Команда"] = "Команда без кода"
        with self.assertRaises(ValueError):
            self.read(rows)

    def test_identical_leaf_duplicates_are_deduplicated_but_conflicts_rejected(self):
        rows = team_rows()
        current = self.read(rows + [dict(rows[1])])
        self.assertEqual(current.teams["SYN001"].available, 5)
        conflict = {**rows[1], "Значение метрики": "99%"}
        with self.assertRaisesRegex(ValueError, "SYN001"):
            self.read(rows + [conflict])

    def test_same_code_in_different_clusters_is_rejected(self):
        rows = team_rows()
        rows[2]["Кластер"] = "Кластер Б"
        with self.assertRaisesRegex(ValueError, "SYN001"):
            self.read(rows)

    def test_invalid_numbers_and_absent_targets_are_rejected(self):
        for bad in ("101%", "NaN", -1, True, "неизвестно"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.read(team_rows(values=[bad, "100%", "100%", "100%", "100%"], reported=(None, None)))
        rows = team_rows()
        rows[1]["Цель метрики"] = None
        with self.assertRaises(ValueError):
            self.read(rows)

    def test_formula_without_cached_result_is_rejected(self):
        rows = team_rows()
        rows[1]["Значение метрики"] = "=1/1"
        with self.assertRaisesRegex(ValueError, "формул"):
            self.read(rows)

    def test_empty_or_ambiguous_workbook_is_rejected_and_sheet_can_be_selected(self):
        with self.assertRaises(ValueError):
            self.read([])
        path = self.book(team_rows(), extra_sheet=True)
        with self.assertRaises(ValueError):
            model.read_snapshot(path, TODAY, {})
        self.assertEqual(len(model.read_snapshot(path, TODAY, {}, sheet="Вторая").teams), 1)
        with self.assertRaises(ValueError):
            model.read_snapshot(path, TODAY, {}, sheet="Нет листа")

    def test_mapping_supports_simple_and_existing_normalized_formats(self):
        simple = self.root / "simple.json"
        simple.write_text(json.dumps({"leaders": {"Лидер А": ["SYN001", "SYN002"]}}, ensure_ascii=False), encoding="utf-8")
        self.assertEqual(model.load_mapping(simple), {"SYN001": "Лидер А", "SYN002": "Лидер А"})
        normalized = self.root / "normalized.json"
        normalized.write_text(json.dumps({"teams": [{"id": "t-1", "code": "SYN001"}],
                                          "leaders": [{"name": "Лидер Б", "teamIds": ["t-1"]}]}), encoding="utf-8")
        self.assertEqual(model.load_mapping(normalized), {"SYN001": "Лидер Б"})

    def test_conflicting_leader_mapping_is_rejected(self):
        path = self.root / "bad.json"
        path.write_text(json.dumps({"leaders": {"Лидер А": ["SYN001"], "Лидер Б": ["SYN001"]}}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "SYN001"):
            model.load_mapping(path)

    def test_compare_uses_codes_numeric_threshold_crossings_and_separate_method_changes(self):
        old_rows = team_rows(values=["60%", "90%", "70%", "Нет PR", "Нет данных"], reported=(1, 3))
        old_rows += team_rows("REMOVED", name="Удалённая")
        previous = self.read(old_rows)
        new_rows = team_rows(values=["75%", "70%", "85%", "100%", "Нет данных"], reported=(2, 4), name="Новое имя")
        new_rows[3]["Цель метрики"] = "90%"
        new_rows += team_rows("ADDED", name="Добавленная")
        current = self.read(new_rows)
        result = model.compare_snapshots(current, previous)
        self.assertEqual(result["added"], {"ADDED"})
        self.assertEqual(result["removed"], {"REMOVED"})
        self.assertEqual(result["improved"], {("SYN001", "code")})
        self.assertEqual(result["regressed"], {("SYN001", "pr")})
        self.assertEqual(result["applicability_changed"], {("SYN001", "description")})
        self.assertEqual(result["target_changed"], {("SYN001", "deploy")})

    def test_missing_synthesized_observation_does_not_invent_target_change(self):
        old_rows = team_rows(reported=(5, 5))
        old_rows[1]["Цель метрики"] = "75%"
        previous = self.read(old_rows)
        current = self.read(team_rows(reported=(4, 4))[:1] + team_rows()[2:])
        changes = model.compare_snapshots(current, previous)
        self.assertEqual(changes["target_changed"], set())
        self.assertEqual(changes["applicability_changed"], {("SYN001", "code")})



"""Integration checks for the generator's output and CLI contracts."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

from openpyxl import Workbook, load_workbook
from pptx import Presentation

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'generate-maturity-presentation.py'


def make_book(path, *, missing=False, renamed=False, teams=3):
    wb = Workbook()
    ws = wb.active
    ws.append(['Блок', 'Трайб', 'Кластер', 'Команда', 'Этап APP', 'Группа практик',
               'Метрика', 'Доля команд', 'Команд достигли', 'Всего команд',
               'Доля метрик', 'Метрик достигли', 'Всего метрик', 'Значение метрики', 'Цель метрики'])
    labels = ['Доля Историй и Багов, связанных с кодом', 'Доля PR, связанных с задачей',
              'Доля авторазвертываний ПРОД',
              'Индекс достаточности описания задач для принятия решений об участии в ПСИ',
              'Индекс зрелости выполнения архитектурных требований по Истории перед ПСИ']
    for n in range(teams):
        name = ('Переименованная команда' if renamed and n == 0 else 'Команда') + f' {n} (T{n})'
        values = ['100,0%', '79,6%' if n == 0 else '100%', '100%', '100%', '100%']
        if missing and n == 1:
            values[2] = 'Нет данных'
        available = 4 if missing and n == 1 else 5
        passed = available - (n == 0)
        ws.append(['Блок', 'Трайб', 'Кластер', name, None, None, None,
                   None, None, None, None, passed, available, None, None])
        for label, fact, target in zip(labels, values, ['70%', '80%', '80%', '95%', '70%']):
            ws.append(['Блок', 'Трайб', 'Кластер', name, 'Разработка', 'Практика', label,
                       None, None, None, None, None, None, fact, target])
    wb.save(path)


class PresentationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.current = self.root / 'current.xlsx'
        make_book(self.current, missing=True)
        self.mapping = self.root / 'leaders.json'
        self.mapping.write_text(json.dumps({'leaders': {'Лидер А.': ['T0','T1'], 'Лидер Б.': ['T2']}}, ensure_ascii=False), encoding='utf-8')

    def run_cli(self, *extra):
        return subprocess.run([sys.executable, str(SCRIPT), '--current', str(self.current),
                               '--date', '2026-11-20', '--leaders', str(self.mapping), *extra],
                              capture_output=True, text=True)

    def test_build_has_summary_and_leader_details_without_notes(self):
        output = self.root / 'result.pptx'
        result = self.run_cli('--output', str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        deck = Presentation(output)
        self.assertEqual(len(deck.slides), 4)
        first = '\n'.join(sh.text for sh in deck.slides[0].shapes if sh.has_text_frame)
        self.assertIn('Лидер А.', first)
        self.assertIn('Лидер Б.', first)
        self.assertIn('2/3', first)
        all_text = '\n'.join(sh.text for sl in deck.slides for sh in sl.shapes if sh.has_text_frame)
        self.assertIn('79,6%', all_text)
        self.assertIn('Нет данных', all_text)
        for slide in deck.slides:
            self.assertTrue(any(sh.has_text_frame and sh.text.strip() for sh in slide.shapes))
            for sh in slide.shapes:
                self.assertGreaterEqual(sh.left, 0)
                self.assertGreaterEqual(sh.top, 0)
                self.assertLessEqual(sh.left + sh.width, deck.slide_width + 10)
                self.assertLessEqual(sh.top + sh.height, deck.slide_height + 10)
        with zipfile.ZipFile(output) as z:
            self.assertIsNone(z.testzip())
            self.assertFalse(any(n.startswith('ppt/notesSlides/') for n in z.namelist()))

    def test_template_old_notes_and_sample_text_are_not_carried(self):
        template = self.root / 'template.pptx'
        p = Presentation()
        p.slide_width = 12192000
        p.slide_height = 6858000
        s = p.slides.add_slide(p.slide_layouts[6])
        s.shapes.add_textbox(100,100,1000000,100000).text = 'OLD EXAMPLE MUST GO'
        s.notes_slide.notes_text_frame.text = 'OLD SECRET NOTES'
        p.save(template)
        output = self.root / 'templated.pptx'
        result = self.run_cli('--template', str(template), '--output', str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(output) as z:
            blob = b'\n'.join(z.read(n) for n in z.namelist() if n.endswith('.xml'))
            self.assertNotIn(b'OLD EXAMPLE MUST GO', blob)
            self.assertNotIn(b'OLD SECRET NOTES', blob)

    def test_many_teams_create_continuation_slides(self):
        make_book(self.current, teams=23)
        self.mapping.write_text(json.dumps({'leaders': {'Лидер А.': [f'T{i}' for i in range(23)]}}), encoding='utf-8')
        output = self.root / 'many.pptx'
        result = self.run_cli('--output', str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        p = Presentation(output)
        self.assertGreaterEqual(len(p.slides), 5)
        text = '\n'.join(sh.text for s in p.slides for sh in s.shapes if sh.has_text_frame)
        for i in range(23):
            self.assertIn(f'Команда {i}', text)

    def test_previous_date_cannot_be_same_or_later(self):
        old = self.root / 'old.xlsx'
        make_book(old)
        result = self.run_cli('--previous', str(old), '--previous-date', '2026-11-20', '--output', str(self.root / 'bad.pptx'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Базовая дата', result.stderr)
        self.assertFalse((self.root / 'bad.pptx').exists())

    def test_refuses_to_replace_source_or_existing_output(self):
        result = self.run_cli('--output', str(self.current), '--force')
        self.assertNotEqual(result.returncode, 0)
        output = self.root / 'existing.pptx'
        output.write_bytes(b'keep-me')
        result = self.run_cli('--output', str(output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Файл уже существует', result.stderr)
        self.assertEqual(output.read_bytes(), b'keep-me')

    def test_audit_counts_do_not_double_count_hierarchy(self):
        output = self.root / 'result.pptx'
        audit = self.root / 'audit.json'
        result = self.run_cli('--output', str(output), '--audit-json', str(audit))
        self.assertEqual(result.returncode, 0, result.stderr)
        j = json.loads(audit.read_text(encoding='utf-8'))
        self.assertEqual(j['current']['summary']['teams'], 3)
        self.assertEqual(j['current']['summary']['metrics_available'], 14)
        self.assertEqual(j['current']['summary']['metrics_met'], 13)
        self.assertEqual(j['current']['summary']['missing'], 1)

    def test_missing_source_row_never_invents_a_threshold(self):
        make_book(self.current, teams=2)
        book = load_workbook(self.current)
        sheet = book.active
        sheet.cell(3, 15, '85%')
        sheet.cell(8, 12, 4)
        sheet.cell(8, 13, 4)
        sheet.delete_rows(9)
        book.save(self.current)
        output, audit = self.root / 'threshold.pptx', self.root / 'audit.json'
        result = self.run_cli('--output', str(output), '--audit-json', str(audit))
        self.assertEqual(result.returncode, 0, result.stderr)
        p = Presentation(output)
        metrics = '\n'.join(sh.text for sh in p.slides[1].shapes if sh.has_text_frame)
        self.assertIn('85%', metrics)
        self.assertNotIn('70% / 85%', metrics)
        data = json.loads(audit.read_text(encoding='utf-8'))
        team = next(t for t in data['current']['teams'] if t['code'] == 'T1')
        self.assertIsNone(team['metrics']['code']['target'])

    def test_bad_audit_destination_does_not_publish_pptx(self):
        blocked = self.root / 'not-a-directory'
        blocked.write_text('keep')
        output = self.root / 'unpublished.pptx'
        result = self.run_cli('--output', str(output), '--audit-json', str(blocked / 'audit.json'))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.exists())
        self.assertEqual(blocked.read_text(), 'keep')

    def test_atomic_publisher_refuses_existing_file_and_rolls_back(self):
        spec = importlib.util.spec_from_file_location('maturity_output_contract', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        self.assertTrue(hasattr(module, 'publish_staged_files'), 'Atomic publishing is not implemented')
        staged_a, staged_b = self.root / 'a.tmp', self.root / 'b.tmp'
        target_a, target_b = self.root / 'a.pptx', self.root / 'b.json'
        staged_a.write_bytes(b'new-a')
        staged_b.write_bytes(b'new-b')
        target_b.write_bytes(b'keep-b')
        with self.assertRaises(FileExistsError):
            module.publish_staged_files([(staged_a, target_a), (staged_b, target_b)], force=False)
        self.assertFalse(target_a.exists())
        self.assertEqual(target_b.read_bytes(), b'keep-b')


if __name__ == '__main__':
    unittest.main()
