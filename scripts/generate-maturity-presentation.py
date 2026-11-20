#!/usr/bin/env python3
"""Read the five-metric maturity export without conflating data and confirmation.

Only numeric observations enter the source-style available denominator. Missing,
excluded and no-event observations remain distinct and are reported separately.
The module never executes spreadsheet formulas or makes network requests.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import datetime as dt
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import re
from typing import Iterable
import unicodedata
import zipfile

from openpyxl import load_workbook


@dataclass(frozen=True)
class MetricSpec:
    key: str
    label: str
    short_label: str
    default_target: Decimal


METRICS = (
    MetricSpec("code", "Доля Историй и Багов, связанных с кодом", "Связь задач с кодом", Decimal("70")),
    MetricSpec("pr", "Доля PR, связанных с задачей", "Связь PR с задачей", Decimal("80")),
    MetricSpec("deploy", "Доля авторазвертываний ПРОД", "Авторазвёртывания ПРОД", Decimal("80")),
    MetricSpec("description", "Достаточность описания задач для участия в ПСИ",
               "Описание задач для ПСИ", Decimal("95")),
    MetricSpec("architecture", "Выполнение архитектурных требований перед ПСИ",
               "Архитектурные требования", Decimal("70")),
)
SOURCE_METRIC_TITLES = {
    "code": "Доля Историй и Багов, связанных с кодом",
    "pr": "Доля PR, связанных с задачей",
    "deploy": "Доля авторазвертываний ПРОД",
    "description": "Индекс достаточности описания задач для принятия решений об участии в ПСИ",
    "architecture": "Индекс зрелости выполнения архитектурных требований по Истории перед ПСИ",
}
_METRICS_BY_KEY = {metric.key: metric for metric in METRICS}
_STATES = {"numeric", "missing", "exception", "no_event"}
UNASSIGNED_LEADER = "Лидер не назначен"
_CODE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\Z")


def _text(value: object) -> str:
    if value is None:
        return ""
    return " ".join(unicodedata.normalize("NFKC", str(value)).split())


def _normalized(value: object) -> str:
    return _text(value).casefold()


_METRICS_BY_LABEL = {_normalized(SOURCE_METRIC_TITLES[metric.key]): metric for metric in METRICS}


def _validated_decimal(value: object, label: str) -> Decimal:
    if isinstance(value, bool):
        raise ValueError(f"{label}: логическое значение не является процентом.")
    try:
        number = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"{label}: ожидается числовое значение.") from exc
    if not number.is_finite() or not Decimal("0") <= number <= Decimal("100"):
        raise ValueError(f"{label}: процент должен находиться в диапазоне 0–100.")
    return number


@dataclass(frozen=True)
class Observation:
    metric: str
    value: Decimal | None
    target: Decimal
    state: str
    raw: str
    row: int

    def __post_init__(self) -> None:
        if self.metric not in _METRICS_BY_KEY or self.state not in _STATES:
            raise ValueError(f"Неподдерживаемая метрика или состояние: {self.metric}, {self.state}.")
        object.__setattr__(self, "target", _validated_decimal(self.target, "Цель метрики"))
        if self.state == "numeric":
            object.__setattr__(self, "value", _validated_decimal(self.value, "Значение метрики"))
        elif self.value is not None:
            raise ValueError("Нечисловое состояние не должно содержать числовой факт.")
        if not isinstance(self.row, int) or isinstance(self.row, bool) or self.row < 0:
            raise ValueError("Номер строки должен быть неотрицательным целым числом.")

    @property
    def passed(self) -> bool:
        return self.state == "numeric" and self.value is not None and self.value >= self.target


def _missing_observation(metric: MetricSpec) -> Observation:
    # row == 0 explicitly means no source row; the default is never evidence of
    # a historical target and is excluded from target-change comparisons.
    return Observation(metric.key, None, metric.default_target, "missing", "", 0)


@dataclass
class Team:
    code: str
    name: str
    cluster: str
    leader: str
    observations: dict[str, Observation]
    reported_met: int | None = None
    reported_available: int | None = None

    def __post_init__(self) -> None:
        self.observations = dict(self.observations)
        for key, observation in self.observations.items():
            if key not in _METRICS_BY_KEY or observation.metric != key:
                raise ValueError(f"Команда {self.code}: неподдерживаемая метрика {key}.")
        for metric in METRICS:
            self.observations.setdefault(metric.key, _missing_observation(metric))
        for label, reported, actual in (
            ("Метрик достигли", self.reported_met, self.passed),
            ("Всего метрик", self.reported_available, self.available),
        ):
            if reported is None:
                continue
            if not isinstance(reported, int) or isinstance(reported, bool) or reported < 0:
                raise ValueError(f"Команда {self.code}: {label} должно быть неотрицательным целым числом.")
            if reported != actual:
                raise ValueError(f"Команда {self.code}: итог «{label}» ({reported}) расходится с детализацией ({actual}).")

    @property
    def available(self) -> int:
        return sum(item.state == "numeric" for item in self.observations.values())

    @property
    def passed(self) -> int:
        return sum(item.passed for item in self.observations.values())

    @property
    def below(self) -> int:
        return sum(item.state == "numeric" and not item.passed for item in self.observations.values())

    @property
    def missing(self) -> int:
        return sum(item.state == "missing" for item in self.observations.values())

    @property
    def excluded(self) -> int:
        return sum(item.state == "exception" for item in self.observations.values())

    @property
    def no_event(self) -> int:
        return sum(item.state == "no_event" for item in self.observations.values())

    @property
    def all_available_met(self) -> bool:
        """Source-style result among measured metrics; not a confirmation."""
        return self.available > 0 and self.passed == self.available


@dataclass
class Snapshot:
    period: dt.date
    teams: dict[str, Team]
    source_name: str
    warnings: list[str] = field(default_factory=list)


def load_mapping(path: Path) -> dict[str, str]:
    """Read either {leaders: {name: [codes]}} or the existing normalized bundle."""
    path = Path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Не удалось прочитать карту лидеров {path.name}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("Карта лидеров должна быть JSON-объектом.")
    leaders = data.get("leaders")
    mapping: dict[str, str] = {}

    def assign(code: object, leader: object) -> None:
        if not isinstance(code, str) or not _CODE.fullmatch(code.strip()):
            raise ValueError(f"Некорректный код команды в карте лидеров: {code!r}.")
        if not isinstance(leader, str) or not _text(leader):
            raise ValueError(f"Не указано имя лидера команды {code}.")
        code, leader = code.strip(), _text(leader)
        if code in mapping and mapping[code] != leader:
            raise ValueError(f"Команда {code} назначена нескольким лидерам: {mapping[code]}, {leader}.")
        mapping[code] = leader

    if isinstance(leaders, dict):
        for leader, codes in leaders.items():
            if not isinstance(codes, list):
                raise ValueError(f"У лидера {leader!r} должен быть список кодов команд.")
            for code in codes:
                assign(code, leader)
        return mapping
    if isinstance(leaders, list) and isinstance(data.get("teams"), list):
        teams_by_id: dict[str, str] = {}
        ids_by_code: dict[str, str] = {}
        for item in data["teams"]:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
                raise ValueError("У команды справочника отсутствует идентификатор id.")
            code = item.get("code")
            if not isinstance(code, str) or not _CODE.fullmatch(code.strip()):
                raise ValueError("У команды справочника отсутствует корректный code.")
            code = code.strip()
            identifier = item["id"]
            if identifier in teams_by_id and teams_by_id[identifier] != code:
                raise ValueError(f"Идентификатор {identifier} связан с несколькими кодами команд.")
            if code in ids_by_code and ids_by_code[code] != identifier:
                raise ValueError(f"Код {code} связан с несколькими идентификаторами команд.")
            teams_by_id[identifier], ids_by_code[code] = code, identifier
        for leader in leaders:
            if not isinstance(leader, dict) or not isinstance(leader.get("teamIds"), list):
                raise ValueError("У лидера справочника должен быть список teamIds.")
            for identifier in leader["teamIds"]:
                if not isinstance(identifier, str) or identifier not in teams_by_id:
                    raise ValueError(f"Не найдена команда {identifier!r} из карты лидеров.")
                assign(teams_by_id[identifier], leader.get("name"))
        return mapping
    raise ValueError("Ожидается leaders с именами и кодами или нормализованный JSON с teams и leaders.")


_REQUIRED_HEADERS = {"команда", "метрика", "значение метрики", "цель метрики"}
_USED_HEADERS = _REQUIRED_HEADERS | {
    "блок", "трайб", "кластер", "этап app", "группа практик", "метрик достигли", "всего метрик",
}
_EMPTY = {"", "-", "—"}
_REASONS = {"в исключениях": "exception", "нет pr": "no_event", "нет релизов": "no_event",
            "нет данных": "missing"}


def _check_xlsx(path: Path) -> None:
    try:
        if path.stat().st_size > 10 * 1024 * 1024:
            raise ValueError("Размер XLSX превышает 10 МБ.")
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            if len(entries) > 4096 or sum(entry.file_size for entry in entries) > 64 * 1024 * 1024:
                raise ValueError("Распакованная книга XLSX слишком велика.")
            if len(names) != len(set(names)):
                raise ValueError("В архиве XLSX повторяются имена файлов.")
            if "xl/workbook.xml" not in names or "[Content_Types].xml" not in names:
                raise ValueError("Файл не содержит книгу XLSX.")
    except (OSError, zipfile.BadZipFile) as exc:
        raise ValueError(f"Не удалось прочитать XLSX {path.name}: {exc}") from exc


def _percentage(value: object, number_format: str, row: int, label: str) -> Decimal:
    context = f"Строка {row}, {label}"
    if isinstance(value, bool):
        raise ValueError(f"{context}: логическое значение вместо процента.")
    if isinstance(value, (int, float, Decimal)):
        try:
            number = Decimal(str(value))
        except InvalidOperation as exc:
            raise ValueError(f"{context}: некорректное число.") from exc
        # A quoted or escaped percent symbol is display text, not percent scaling.
        format_code = re.sub(r'"[^"]*"|\\.', "", number_format or "")
        if "%" in format_code:
            number *= Decimal("100")
        return _validated_decimal(number, context)
    text = _text(value)
    if not re.fullmatch(r"[+-]?\d+(?:[.,]\d+)?\s*%?", text):
        raise ValueError(f"{context}: ожидался процент, получено {text!r}.")
    number = Decimal(text.replace("%", "").replace(",", ".").strip())
    return _validated_decimal(number, context)


def _count(value: object, row: int, label: str) -> int | None:
    text = _normalized(value)
    if text in _EMPTY or text in {"не участвует", "нет данных"}:
        return None
    if isinstance(value, bool):
        raise ValueError(f"Строка {row}: «{label}» должно быть целым количеством.")
    try:
        number = Decimal(text.replace(",", "."))
    except InvalidOperation as exc:
        raise ValueError(f"Строка {row}: некорректное количество «{label}».") from exc
    if not number.is_finite() or number < 0 or number != number.to_integral_value():
        raise ValueError(f"Строка {row}: «{label}» должно быть неотрицательным целым количеством.")
    return int(number)


def _team_identity(value: object, row: int) -> tuple[str, str]:
    text = _text(value)
    match = re.fullmatch(r"(.+?)\s*\(([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\)", text)
    if not match or not match.group(1).strip():
        raise ValueError(f"Строка {row}: у команды {text!r} нет стабильного кода в конечных скобках.")
    return match.group(2), match.group(1).strip()


def read_snapshot(path: Path, period: dt.date, mapping: dict[str, str], sheet: str | None = None) -> Snapshot:
    """Read one maturity table; validate reported team counts against leaf facts.

    Headers may be reordered and start in any of the first 20 rows. A sheet must
    be explicitly selected when multiple tables match. Missing expected metrics
    are synthesized with state='missing', row=0, never with a zero value.
    """
    path = Path(path)
    _check_xlsx(path)
    cached = formulas = None
    try:
        cached = load_workbook(path, read_only=True, data_only=True, keep_links=False)
        formulas = load_workbook(path, read_only=True, data_only=False, keep_links=False)
        if sheet is not None and sheet not in cached.sheetnames:
            raise ValueError(f"Лист {sheet!r} не найден в {path.name}.")
        candidates = []
        worksheets = [cached[sheet]] if sheet is not None else cached.worksheets
        for worksheet in worksheets:
            if sheet is None and worksheet.sheet_state != "visible":
                continue
            if (worksheet.max_row or 0) > 25000 or (worksheet.max_column or 0) > 100:
                raise ValueError(f"Лист {worksheet.title!r} превышает 25 000 строк или 100 колонок.")
            for row_number, cells in enumerate(worksheet.iter_rows(min_row=1, max_row=min(20, worksheet.max_row or 1)), start=1):
                columns: dict[str, int] = {}
                duplicates = set()
                for index, cell in enumerate(cells):
                    name = _normalized(cell.value)
                    if name in columns:
                        duplicates.add(name)
                    else:
                        columns[name] = index
                if _REQUIRED_HEADERS.issubset(columns):
                    if duplicates & _USED_HEADERS:
                        raise ValueError(f"Лист {worksheet.title!r}: заголовки колонок повторяются.")
                    candidates.append((worksheet, row_number, columns))
        if len(candidates) != 1:
            if not candidates:
                raise ValueError("В первых 20 строках не найдена таблица с колонками Команда, Метрика, Значение метрики, Цель метрики.")
            raise ValueError("Найдено несколько таблиц зрелости; укажите один лист параметром --sheet.")
        worksheet, header_row, columns = candidates[0]
        source_sheet = formulas[worksheet.title]
        records: dict[str, dict] = {}
        warnings: list[str] = []
        formula_cells: set[str] = set()
        cached_rows = worksheet.iter_rows(min_row=header_row + 1, max_row=worksheet.max_row,
                                          max_col=worksheet.max_column)
        raw_rows = source_sheet.iter_rows(min_row=header_row + 1, max_row=worksheet.max_row,
                                          max_col=worksheet.max_column)
        for number, (cells, raw_cells) in enumerate(zip(cached_rows, raw_rows), start=header_row + 1):
            def get(name: str) -> object:
                if name not in columns:
                    return None
                index = columns[name]
                cell, raw_cell = cells[index], raw_cells[index]
                if raw_cell.data_type == "f":
                    if cell.value is None:
                        raise ValueError(f"Строка {number}, {name}: у формулы нет сохранённого результата; пересчитайте и сохраните книгу.")
                    formula_cells.add(raw_cell.coordinate)
                if cell.data_type == "e" or raw_cell.data_type == "e":
                    raise ValueError(f"Строка {number}, {name}: ошибка Excel {cell.value!r}.")
                return cell.value

            team_text, metric_text = _text(get("команда")), _text(get("метрика"))
            has_metric = metric_text not in _EMPTY
            if team_text in _EMPTY and not has_metric:
                continue  # Block / tribe / cluster totals never become teams.
            if team_text in _EMPTY:
                raise ValueError(f"Строка {number}: у метрики {metric_text!r} не указана команда.")
            is_team_row = not has_metric and all(_text(get(name)) in _EMPTY for name in ("этап app", "группа практик"))
            if not has_metric and not is_team_row:
                continue  # Stage and practice-group aggregates are not facts.
            code, name = _team_identity(team_text, number)
            cluster = _text(get("кластер"))
            hierarchy = tuple(_normalized(get(key)) for key in ("блок", "трайб", "кластер"))
            record = records.get(code)
            if record is None:
                record = {"name": name, "cluster": cluster, "hierarchy": hierarchy, "observations": {},
                          "reported_met": None, "reported_available": None, "metric_paths": {}}
                records[code] = record
            elif _normalized(record["name"]) != _normalized(name) or record["hierarchy"] != hierarchy:
                raise ValueError(f"Строка {number}: код {code} встречается с разными именами или положением в иерархии.")
            if is_team_row:
                for field_name, header in (("reported_met", "метрик достигли"), ("reported_available", "всего метрик")):
                    reported = _count(get(header), number, header)
                    if reported is not None:
                        previous = record[field_name]
                        if previous is not None and previous != reported:
                            raise ValueError(f"Строка {number}: для команды {code} указаны конфликтующие итоги.")
                        record[field_name] = reported
                continue
            metric = _METRICS_BY_LABEL.get(_normalized(metric_text))
            if metric is None:
                raise ValueError(f"Строка {number}: неподдерживаемая листовая метрика {metric_text!r}; ожидаются пять метрик модели зрелости.")
            target_cell = cells[columns["цель метрики"]]
            target = _percentage(get("цель метрики"), target_cell.number_format, number, "Цель метрики")
            value_cell = cells[columns["значение метрики"]]
            value_raw = get("значение метрики")
            raw = _text(value_raw)
            state = "missing" if _normalized(raw) in _EMPTY else _REASONS.get(_normalized(raw), "numeric")
            value = _percentage(value_raw, value_cell.number_format, number, "Значение метрики") if state == "numeric" else None
            observation = Observation(metric.key, value, target, state, raw, number)
            metric_path = tuple(_normalized(get(key)) for key in ("этап app", "группа практик"))
            previous = record["observations"].get(metric.key)
            if previous is not None:
                if ((previous.value, previous.target, previous.state) != (value, target, state)
                        or record["metric_paths"][metric.key] != metric_path):
                    raise ValueError(f"Строка {number}: конфликтующий повтор метрики {metric.key} команды {code} (первая строка {previous.row}).")
                warnings.append(f"Команда {code}: одинаковая повторная строка {number} метрики {metric.key} учтена один раз.")
            else:
                record["observations"][metric.key] = observation
                record["metric_paths"][metric.key] = metric_path
        if not records:
            raise ValueError("В таблице нет команд или строк метрик модели зрелости.")
        teams: dict[str, Team] = {}
        for code, record in records.items():
            leader = _text(mapping.get(code)) or UNASSIGNED_LEADER
            team = Team(code, record["name"], record["cluster"], leader, record["observations"],
                        record["reported_met"], record["reported_available"])
            teams[code] = team
            if leader == UNASSIGNED_LEADER:
                warnings.append(f"Команда {code}: лидер не назначен.")
            if team.missing:
                warnings.append(f"Команда {code}: нет данных по {team.missing} из {len(METRICS)} метрик.")
        if formula_cells:
            warnings.append(f"Использованы сохранённые результаты формул ({len(formula_cells)} ячеек); формулы не пересчитывались.")
        return Snapshot(period, teams, path.name, warnings)
    except ValueError:
        raise
    except (OSError, KeyError, zipfile.BadZipFile) as exc:
        raise ValueError(f"Не удалось прочитать книгу {path.name}: {exc}") from exc
    finally:
        if cached is not None:
            cached.close()
        if formulas is not None:
            formulas.close()


def summarize(teams: Iterable[Team]) -> dict[str, int]:
    totals = {"teams": 0, "teams_met": 0, "metrics_met": 0, "metrics_available": 0,
              "below": 0, "missing": 0, "excluded": 0, "no_event": 0}
    for team in teams:
        totals["teams"] += 1
        totals["teams_met"] += int(team.all_available_met)
        totals["metrics_met"] += team.passed
        totals["metrics_available"] += team.available
        for key in ("below", "missing", "excluded", "no_event"):
            totals[key] += getattr(team, key)
    return totals


def compare_snapshots(current: Snapshot, previous: Snapshot) -> dict[str, set]:
    """Return code sets and (code, metric-key) sets, never rename-based matches.

    applicability_changed covers any change between numeric, missing, exception
    and no_event. Threshold crossings require two numeric facts and an unchanged
    target. Synthesized missing rows cannot establish a target change.
    """
    current_codes, previous_codes = set(current.teams), set(previous.teams)
    result = {"added": current_codes - previous_codes, "removed": previous_codes - current_codes,
              "improved": set(), "regressed": set(), "applicability_changed": set(), "target_changed": set()}
    for code in current_codes & previous_codes:
        for metric in METRICS:
            now = current.teams[code].observations[metric.key]
            before = previous.teams[code].observations[metric.key]
            pair = (code, metric.key)
            if now.state != before.state:
                result["applicability_changed"].add(pair)
            if now.row > 0 and before.row > 0 and now.target != before.target:
                result["target_changed"].add(pair)
            if now.state != "numeric" or before.state != "numeric" or now.target != before.target:
                continue
            if now.passed and not before.passed:
                result["improved"].add(pair)
            elif before.passed and not now.passed:
                result["regressed"].add(pair)
    return result


# Presentation and command-line layer. Combined with model_part.py for delivery.
import argparse
import datetime as dt
import io
import json
import math
import os
import tempfile
import textwrap
import zipfile
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.xmlchemy import OxmlElement
from pptx.util import Inches, Pt


STYLE = {
    'background': 'F6F7FB', 'ink': '24283A', 'muted': '7D88A8',
    'purple': '7353D6', 'line': 'DFE3ED', 'white': 'FFFFFF',
    'green': '087F68', 'green_bg': 'E5F5EF', 'red': 'B42318',
    'red_bg': 'FCEEEB', 'gray_bg': 'EBEEF5', 'purple_bg': 'F0EBFF',
}
FONT = 'Arial'
REFERENCE_DATE = '2026-10-30'


def fmt_number(value):
    value = Decimal(str(value))
    return format(value.normalize(), 'f').replace('.', ',')


def ratio(numerator, denominator):
    if not denominator:
        return 'Нет данных'
    value = Decimal(numerator) * 100 / Decimal(denominator)
    # A real shortfall must never be displayed as 100% because of rounding.
    rounded = value.quantize(Decimal('0.1'))
    if numerator < denominator and rounded == 100:
        return '<100%'
    return fmt_number(rounded) + '%'


def delta(value):
    return ('+' if value > 0 else '−' if value < 0 else '') + str(abs(value))


def split_pages(items, capacity):
    items = list(items)
    return [items[i:i + capacity] for i in range(0, len(items), capacity)] or [[]]


def wrapped(text, width):
    lines = []
    for part in str(text).split('\n'):
        lines.extend(textwrap.wrap(part, width=width, break_long_words=True,
                                   break_on_hyphens=False) or [''])
    return '\n'.join(lines)


def team_attention(team):
    bits = []
    for spec in METRICS:
        obs = team.observations.get(spec.key)
        if obs is None or obs.state == 'missing':
            bits.append(spec.short_label + ': Нет данных')
        elif obs.state == 'numeric' and not obs.passed:
            bits.append(f'{spec.short_label}: {fmt_number(obs.value)}% / цель {fmt_number(obs.target)}%')
    if not bits:
        if team.available:
            bits.append('Все доступные метрики выполнены')
        else:
            bits.append('Нет измеренных метрик')
    if team.excluded:
        bits.append(f'Исключения: {team.excluded}')
    if team.no_event:
        bits.append(f'Нет событий: {team.no_event}')
    return '; '.join(bits)


def comparison_note(current, previous):
    if previous is None:
        return 'Базовая выгрузка не задана. Изменения не рассчитываются.'
    change = compare_snapshots(current, previous)
    chunks = []
    for key, label in [('added', 'Добавлены команды'), ('removed', 'Ушли из выгрузки'),
                       ('applicability_changed', 'Изменена доступность метрик'),
                       ('target_changed', 'Изменены пороги')]:
        if change[key]:
            chunks.append(f'{label}: {len(change[key])}')
    moved = sum(previous.teams[k].leader != current.teams[k].leader
                for k in current.teams.keys() & previous.teams.keys())
    if moved:
        chunks.append(f'Изменён лидер: {moved}')
    if chunks:
        return '. '.join(chunks) + '. Δ показывает разницу срезов, а не только рост показателей.'
    return ('Состав и пороги совпадают. Переходы через порог: '
            f'вверх {len(change["improved"])}, вниз {len(change["regressed"])}.')


class DeckBuilder:
    """Build editable slides using the DIT / OPS / UOR visual structure."""

    def __init__(self, current, previous=None, template=None, goal_share=Decimal('80')):
        self.current, self.previous, self.goal_share = current, previous, goal_share
        self.logo = None
        self.prs = Presentation(str(template)) if template else Presentation()
        if template:
            aspect = self.prs.slide_width / self.prs.slide_height
            if not 1.74 <= aspect <= 1.81:
                raise ValueError('Шаблон должен иметь формат 16:9.')
            # Reuse the small top-left logo, not sample data or whole-slide images.
            if self.prs.slides:
                for shape in self.prs.slides[0].shapes:
                    if (shape.shape_type == 13 and shape.top < self.prs.slide_height * .12
                            and shape.left < self.prs.slide_width * .2
                            and shape.width < self.prs.slide_width * .2):
                        self.logo = (shape.image.blob, shape.height / shape.width)
                        break
            # Dropping slide relationships also drops their speaker-note parts.
            for entry in list(self.prs.slides._sldIdLst):
                self.prs.part.drop_rel(entry.rId)
                self.prs.slides._sldIdLst.remove(entry)
        else:
            self.prs.slide_width, self.prs.slide_height = Inches(13.333333), Inches(7.5)
        self.sx = self.prs.slide_width / Inches(13.333333)
        self.sy = self.prs.slide_height / Inches(7.5)
        self.prs.core_properties.title = 'Модель зрелости ДИТ'
        self.prs.core_properties.subject = 'Сводка, динамика и команды по лидерам'
        self.prs.core_properties.author = 'ДИТ / OPS / УОР'
        self.prs.core_properties.keywords = 'maturity, generated, editable'
        self.specs = {m.key: m for m in METRICS}

    def x(self, value):
        return int(Inches(value) * self.sx)

    def y(self, value):
        return int(Inches(value) * self.sy)

    def box(self, slide, x, y, w, h, fill, border=None, rounded=False):
        kind = MSO_SHAPE.ROUNDED_RECTANGLE if rounded else MSO_SHAPE.RECTANGLE
        shape = slide.shapes.add_shape(kind, self.x(x), self.y(y), self.x(w), self.y(h))
        if rounded:
            shape.adjustments[0] = .08
        shape.fill.solid()
        shape.fill.fore_color.rgb = RGBColor.from_string(STYLE.get(fill, fill))
        if border:
            shape.line.color.rgb = RGBColor.from_string(STYLE.get(border, border))
            shape.line.width = Pt(.7)
        else:
            shape.line.fill.background()
        # Source templates may apply a shadow through the theme's effectRef.
        for effect in shape._element.findall('.//{http://schemas.openxmlformats.org/drawingml/2006/main}effectRef'):
            effect.set('idx', '0')
        shape._element.spPr.append(OxmlElement('a:effectLst'))
        return shape

    def text(self, slide, text, x, y, w, h, size=12, color='ink', bold=False,
             align=PP_ALIGN.LEFT, middle=False):
        shape = slide.shapes.add_textbox(self.x(x), self.y(y), self.x(w), self.y(h))
        frame = shape.text_frame
        frame.clear()
        frame.word_wrap = True
        frame.margin_left = frame.margin_right = 0
        frame.margin_top = frame.margin_bottom = 0
        frame.vertical_anchor = MSO_ANCHOR.MIDDLE if middle else MSO_ANCHOR.TOP
        for i, line in enumerate(str(text).split('\n')):
            paragraph = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
            paragraph.alignment = align
            paragraph.space_after = Pt(0)
            paragraph.space_before = Pt(0)
            paragraph.line_spacing = 1.0
            run = paragraph.add_run()
            run.text = line
            run.font.name = FONT
            run.font.size = Pt(size)
            run.font.bold = bold
            run.font.color.rgb = RGBColor.from_string(STYLE.get(color, color))
        return shape

    def slide(self, title, subtitle):
        layout = min(self.prs.slide_layouts, key=lambda item: len(item.placeholders))
        slide = self.prs.slides.add_slide(layout)
        for shape in list(slide.shapes):
            shape._element.getparent().remove(shape._element)
        slide._element.set('showMasterSp', '0')
        slide.background.fill.solid()
        slide.background.fill.fore_color.rgb = RGBColor.from_string(STYLE['background'])
        self.box(slide, .001, .001, 13.331, .045, 'purple')
        if self.logo:
            data, aspect = self.logo
            slide.shapes.add_picture(io.BytesIO(data), self.x(.55), self.y(.12),
                                     width=self.x(.78), height=self.y(.78 * aspect))
        else:
            self.text(slide, 'ДИТ', .55, .15, .78, .23, 12, 'purple', True)
        self.text(slide, 'ДИТ / OPS  ·  УОР  /  МОДЕЛЬ ЗРЕЛОСТИ', 1.55, .16, 8.6, .23,
                  10, 'muted', True)
        self.text(slide, self.current.period.strftime('%d.%m.%Y'), 10.85, .16, 1.45, .23,
                  10, 'muted', align=PP_ALIGN.RIGHT)
        self.box(slide, 12.42, .11, .4, .30, 'purple_bg', rounded=True)
        self.text(slide, f'{len(self.prs.slides):02d}', 12.42, .15, .4, .16,
                  9, 'purple', True, PP_ALIGN.CENTER)
        self.text(slide, title, .55, .66, 12.20, .46, 24, bold=True)
        self.text(slide, subtitle, .55, 1.13, 12.18, .36, 10.5, 'muted')
        return slide

    def footer(self, slide, text):
        self.text(slide, wrapped(text, 175), .55, 6.94, 12.2, .42, 8.5, 'muted')

    def card(self, slide, x, w, label, value, detail, color='purple'):
        self.box(slide, x, 1.66, w, 1.02, 'white', 'line', True)
        self.box(slide, x + .16, 1.83, .035, .22, color)
        self.text(slide, label, x + .27, 1.81, w - .43, .23, 10, 'muted')
        self.text(slide, value, x + .18, 2.08, w - .36, .32, 23, color, True)
        self.text(slide, detail, x + .18, 2.44, w - .36, .17, 8.8, 'muted')

    def table(self, slide, headers, rows, widths, top=3.16, row_heights=None, font=11):
        x, left, header_height = .55, .55, .38
        for header, width in zip(headers, widths):
            self.box(slide, x, top, width, header_height, 'purple_bg')
            self.text(slide, header, x + .10, top + .09, width - .2, .23,
                      10, 'purple', True)
            x += width
        y = top + header_height
        for index, row in enumerate(rows):
            height = row_heights[index] if row_heights else .385
            x = left
            for cell, width in zip(row, widths):
                value, color = cell if isinstance(cell, tuple) else (str(cell), 'ink')
                fill = 'white' if index % 2 == 0 else 'background'
                self.box(slide, x, y, width, height, fill)
                self.text(slide, value, x + .10, y + .06, width - .20, height - .10,
                          font, color)
                x += width
            y += height
        return y

    def leaders(self):
        groups = defaultdict(list)
        for team in self.current.teams.values():
            groups[team.leader].append(team)
        if self.previous:
            for team in self.previous.teams.values():
                groups.setdefault(team.leader, [])
        return sorted(groups.items(), key=lambda item: (-sum(t.below for t in item[1]),
                                                        -sum(t.missing for t in item[1]), item[0]))

    def old_teams(self, leader):
        return [t for t in self.previous.teams.values() if t.leader == leader] if self.previous else []

    def period_text(self):
        current = self.current.period.strftime('%d.%m.%Y')
        if self.previous:
            return self.previous.period.strftime('%d.%m.%Y') + ' → ' + current
        return 'Срез ' + current

    def summary_slides(self):
        now = summarize(self.current.teams.values())
        old = summarize(self.previous.teams.values()) if self.previous else None
        for page_number, group_page in enumerate(split_pages(self.leaders(), 8)):
            suffix = '' if page_number == 0 else f' · продолжение {page_number + 1}'
            slide = self.slide('Модель зрелости ДИТ' + suffix,
                               self.period_text() + '  ·  результат по доступным метрикам  ·  ' +
                               f'ориентир команд {fmt_number(self.goal_share)}%')
            self.card(slide, .55, 3.03, 'Команды: все доступные метрики',
                      f'{now["teams_met"]}/{now["teams"]}',
                      ratio(now['teams_met'], now['teams']) + ' команд по правилу выгрузки')
            self.card(slide, 3.76, 3.03, 'Метрики: выполнено / измерено',
                      f'{now["metrics_met"]}/{now["metrics_available"]}',
                      ratio(now['metrics_met'], now['metrics_available']))
            self.card(slide, 6.97, 2.85, 'Метрики ниже порога', str(now['below']),
                      f'Было {old["below"]}' if old else 'По текущим фактам',
                      'red' if now['below'] else 'green')
            self.card(slide, 10.0, 2.78, 'Нет данных', str(now['missing']),
                      'позиций метрик; учтены отдельно', 'muted')
            self.text(slide, 'Текущий результат и изменение по лидерам', .55, 2.89, 11.9, .27,
                      15, bold=True)
            rows = []
            for name, teams in group_page:
                summary = summarize(teams)
                prior = summarize(self.old_teams(name)) if self.previous else None
                issue = (f'Ниже порога: {summary["below"]}' if summary['below'] else 'Невыполнений нет')
                if summary['missing']:
                    issue += f'; нет данных: {summary["missing"]}'
                if not teams:
                    issue = 'Команд нет в текущей выгрузке'
                rows.append([name,
                             f'{summary["teams_met"]}/{summary["teams"]}' if teams else '—',
                             delta(summary['teams_met'] - prior['teams_met']) if prior else '—',
                             f'{summary["metrics_met"]}/{summary["metrics_available"]}' if teams else '—',
                             delta(summary['metrics_met'] - prior['metrics_met']) if prior else '—',
                             (issue, 'red' if summary['below'] else 'muted' if summary['missing'] or not teams else 'green')])
            bottom = self.table(slide, ['Лидер', 'Команды', 'Δ команд', 'Метрики', 'Δ метрик', 'Текущий статус'],
                                rows, [2.15, 1.04, .95, 1.1, .97, 6.02],
                                row_heights=[.36] * len(rows), font=10.5)
            note = comparison_note(self.current, self.previous)
            self.text(slide, wrapped(note, 154), .67, max(6.59, bottom + .12), 11.98, .32, 9.2, 'muted')
            self.footer(slide, 'В числителе команды, выполнившие все измеренные показатели. '
                        'Пропуски, исключения и отсутствие событий не подтверждают цель УОР.')

    def metric_slides(self):
        slide = self.slide('Пять метрик целеполагания', self.period_text() + '  ·  факт сравнивается с порогом из Excel')
        rows = []
        for spec in METRICS:
            observations = [t.observations.get(spec.key) for t in self.current.teams.values()]
            numeric = [o for o in observations if o and o.state == 'numeric']
            met = sum(o.passed for o in numeric)
            missing = sum(o is None or o.state == 'missing' for o in observations)
            targets = sorted({o.target for o in observations if o and o.row > 0})
            target = (' / '.join(fmt_number(t) + '%' for t in targets)
                      if len(targets) <= 2 else f'Разные: {len(targets)}')
            previous = [t.observations.get(spec.key) for t in self.previous.teams.values()] if self.previous else []
            prev_numeric = [o for o in previous if o and o.state == 'numeric']
            before = f'{sum(o.passed for o in prev_numeric)}/{len(prev_numeric)}' if self.previous else '—'
            rows.append([wrapped(spec.label, 39), target or 'Нет данных',
                         (f'{met}/{len(numeric)} · {ratio(met,len(numeric))}', 'green' if met == len(numeric) and numeric and not missing else 'red' if met < len(numeric) else 'muted'),
                         before, str(len(numeric) - met), str(missing)])
        self.table(slide, ['Метрика', 'Порог', 'Выполнено / измерено', 'Было', 'Ниже цели', 'Нет данных'],
                   rows, [4.1, 1.12, 2.48, 1.05, 1.25, 1.23], top=1.76,
                   row_heights=[.69] * 5, font=11.5)
        n = summarize(self.current.teams.values())
        self.box(slide, .55, 5.82, 12.23, .79, 'white', 'line', True)
        self.text(slide, f'Вне числового расчёта: исключения {n["excluded"]}  ·  '
                  f'нет событий {n["no_event"]}  ·  нет данных {n["missing"]}',
                  .75, 5.98, 11.85, .23, 12, 'muted', True)
        self.text(slide, 'Изменение этих состояний меняет знаменатель. Оно само по себе не означает рост метрики.',
                  .75, 6.29, 11.85, .22, 10.2, 'muted')
        self.footer(slide, f'Источник: {self.current.source_name}. Измерено = числовой факт; '
                    'неизвестные значения не заменяются нулём.')

    def leader_slides(self, name, teams):
        if not teams:
            return
        now, before = summarize(teams), summarize(self.old_teams(name)) if self.previous else None
        teams = sorted(teams, key=lambda t: (-t.below, -t.missing, t.name.casefold(), t.code))
        rows_with_height = []
        for team in teams:
            prior = self.previous.teams.get(team.code) if self.previous else None
            name_text = wrapped(f'{team.name} ({team.code})', 39)
            attention = team_attention(team)
            if prior and prior.leader != team.leader:
                attention += f'; прежний лидер: {prior.leader}'
            if self.previous and prior is None:
                attention += '; новая команда в выгрузке'
            attention_text = wrapped(attention, 77)
            height = max(.35, .11 + .155 * max(name_text.count('\n') + 1, attention_text.count('\n') + 1))
            color = 'red' if team.below else 'muted' if team.missing or not team.available else 'green'
            row = [name_text,
                   f'{prior.passed}/{prior.available}' if prior and prior.available else '—',
                   (f'{team.passed}/{team.available}' if team.available else 'Нет данных', color),
                   (attention_text, color)]
            rows_with_height.append((row, height))
        pages, page, occupied = [], [], 0
        for row, height in rows_with_height:
            if page and occupied + height > 3.55:
                pages.append(page)
                page, occupied = [], 0
            page.append((row, height))
            occupied += height
        if page:
            pages.append(page)
        for page_number, page in enumerate(pages, 1):
            title = f'{name} · результат команд'
            if len(pages) > 1:
                title += f' · {page_number}/{len(pages)}'
            slide = self.slide(title, self.period_text() + f'  ·  {len(teams)} команд у лидера  ·  текущий состав')
            self.card(slide, .55, 3.82, 'Команды: все доступные метрики',
                      f'{now["teams_met"]}/{now["teams"]}',
                      f'Было {before["teams_met"]}/{before["teams"]}' if before else 'Базовая выгрузка не задана')
            self.card(slide, 4.56, 3.82, 'Метрики: выполнено / измерено',
                      f'{now["metrics_met"]}/{now["metrics_available"]}',
                      f'Было {before["metrics_met"]}/{before["metrics_available"]}' if before else ratio(now['metrics_met'],now['metrics_available']))
            self.card(slide, 8.57, 4.21, 'Требуют внимания',
                      f'{now["below"]} ниже порога', f'Нет данных: {now["missing"]} позиций метрик',
                      'red' if now['below'] else 'muted' if now['missing'] else 'green')
            previous_label = self.previous.period.strftime('%d.%m') if self.previous else 'Было'
            self.table(slide, ['Команда', previous_label, self.current.period.strftime('%d.%m'),
                               'Статус: факт, порог и отсутствующие данные'],
                       [r for r, _ in page], [3.45, .90, 1.02, 6.86], top=2.96,
                       row_heights=[h for _, h in page], font=10.5)
            self.footer(slide, 'В долях — выполнено / измерено. Серый: нет данных или нет измеренных метрик. '
                        'Исключения и отсутствие событий показаны отдельно. Идентификация команды — по коду.')

    def build(self):
        self.summary_slides()
        self.metric_slides()
        for leader, teams in self.leaders():
            self.leader_slides(leader, teams)
        return self.prs


def validate_presentation(path):
    """Check the package and geometry; this is not an actual Microsoft Office test."""
    with zipfile.ZipFile(path) as archive:
        damaged = archive.testzip()
        if damaged:
            raise ValueError(f'Повреждён ZIP-элемент PPTX: {damaged}')
        for name in archive.namelist():
            if name.endswith(('.xml', '.rels')):
                ET.fromstring(archive.read(name))
        if any(n.startswith('ppt/notesSlides/') for n in archive.namelist()):
            raise ValueError('В PPTX остались заметки докладчика.')
    deck = Presentation(str(path))
    for i, slide in enumerate(deck.slides, 1):
        if not any(s.has_text_frame and s.text.strip() for s in slide.shapes):
            raise ValueError(f'Пустой слайд {i}.')
        for shape in slide.shapes:
            if (shape.left < 0 or shape.top < 0 or shape.left + shape.width > deck.slide_width + 10
                    or shape.top + shape.height > deck.slide_height + 10):
                raise ValueError(f'Объект за пределами слайда {i}.')
    return len(deck.slides)


def snapshot_audit(snapshot):
    return {'date': snapshot.period.isoformat(), 'source': snapshot.source_name,
            'summary': summarize(snapshot.teams.values()), 'warnings': snapshot.warnings,
            'teams': [{'code': t.code, 'name': t.name, 'leader': t.leader, 'cluster': t.cluster,
                       'met': t.passed, 'available': t.available, 'missing': t.missing,
                       'metrics': {key: {'state': o.state, 'value': str(o.value) if o.value is not None else None,
                                          'target': str(o.target) if o.row > 0 else None, 'source_row': o.row}
                                   for key, o in t.observations.items()}}
                      for t in snapshot.teams.values()]}


def parse_date(value):
    for fmt in ('%Y-%m-%d', '%d.%m.%Y'):
        try:
            return dt.datetime.strptime(value, fmt).date()
        except ValueError:
            pass
    raise argparse.ArgumentTypeError('Дата: YYYY-MM-DD или DD.MM.YYYY.')


def publish_staged_files(staged, force=False):
    """Publish complete files; no-clobber is atomic when force is false.

    All staging files must be on their destination's filesystem. If a later
    publication fails, roll back earlier files only while they are still ours.
    """
    backups, published = {}, []
    try:
        if force:
            for source, destination in staged:
                if destination.exists() or destination.is_symlink():
                    descriptor, name = tempfile.mkstemp(prefix='.maturity-backup-', dir=destination.parent)
                    os.close(descriptor)
                    backup = Path(name)
                    backup.unlink()
                    os.link(destination, backup, follow_symlinks=False)
                    backups[destination] = backup
        for source, destination in staged:
            identity = (source.stat().st_dev, source.stat().st_ino)
            if force:
                os.replace(source, destination)
            else:
                # Unlike check-then-replace, link cannot overwrite a concurrent run.
                os.link(source, destination)
            published.append((destination, identity))
    except OSError:
        for destination, identity in reversed(published):
            try:
                info = destination.stat()
                if (info.st_dev, info.st_ino) != identity:
                    continue  # Another writer now owns this path; leave it alone.
                if destination in backups:
                    os.replace(backups.pop(destination), destination)
                else:
                    destination.unlink()
            except OSError:
                # Retain a backup if the filesystem prevents rollback.
                backups.pop(destination, None)
        raise
    finally:
        for backup in backups.values():
            backup.unlink(missing_ok=True)


def main(argv=None):
    repo_root = Path(__file__).resolve().parents[1]
    default_mapping = repo_root / 'data' / 'reference' / f'maturity-{REFERENCE_DATE}.json'
    default_template = repo_root / 'materials' / 'maturity' / REFERENCE_DATE / 'source.pptx'
    parser = argparse.ArgumentParser(description='Презентация модели зрелости ДИТ из XLSX: сводка, динамика, лидеры.')
    parser.add_argument('--current', required=True, type=Path, help='Текущая XLSX-выгрузка.')
    parser.add_argument('--date', required=True, type=parse_date, help='Дата фактов текущей выгрузки.')
    parser.add_argument('--previous', type=Path, help='Предыдущая XLSX; без неё дельты не выдумываются.')
    parser.add_argument('--previous-date', type=parse_date)
    parser.add_argument('--leaders', type=Path, default=default_mapping if default_mapping.exists() else None,
                        help='Карта лидеров JSON; в репозитории по умолчанию опубликованный справочник.')
    parser.add_argument('--previous-leaders', type=Path, help='Историческая карта; по умолчанию выбранная карта текущего периода.')
    parser.add_argument('--template', type=Path, default=default_template if default_template.exists() else None,
                        help='Шаблон PPTX 16:9. В репозитории по умолчанию образец 30.10.2026.')
    parser.add_argument('--sheet', help='Лист Excel; по умолчанию единственный лист с нужными заголовками.')
    parser.add_argument('--output', type=Path, help='Файл результата .pptx.')
    parser.add_argument('--audit-json', type=Path, help='Локальный JSON с проверочными числами и источниками.')
    parser.add_argument('--goal-share', type=Decimal, default=Decimal('80'), help='Ориентир доли команд, по умолчанию 80.')
    parser.add_argument('--force', action='store_true', help='Разрешить замену существующего результата.')
    args = parser.parse_args(argv)
    if bool(args.previous) != bool(args.previous_date):
        parser.error('--previous и --previous-date задаются вместе.')
    if args.previous_date and args.previous_date >= args.date:
        parser.error('Базовая дата должна быть раньше текущей.')
    if args.previous_leaders and not args.previous:
        parser.error('--previous-leaders используется вместе с --previous.')
    if args.leaders is None:
        parser.error('Нужна --leaders: карта кодов команд и лидеров отсутствует рядом со скриптом.')
    if not args.goal_share.is_finite() or not 0 <= args.goal_share <= 100:
        parser.error('--goal-share должен быть конечным числом от 0 до 100.')
    output = args.output or Path(f'DIT_OPS_UOR_maturity_{args.date.isoformat()}.pptx')
    if output.suffix.lower() != '.pptx':
        parser.error('--output должен иметь расширение .pptx.')
    if args.audit_json and args.audit_json.suffix.lower() != '.json':
        parser.error('--audit-json должен иметь расширение .json.')
    inputs = {p.resolve() for p in [args.current, args.previous, args.leaders,
                                  args.previous_leaders, args.template] if p}
    outputs = [output] + ([args.audit_json] if args.audit_json else [])
    for path in outputs:
        if path.resolve() in inputs:
            parser.error('Результат не может перезаписать входной файл.')
        if path.exists() and not args.force:
            parser.error(f'Файл уже существует: {path}. Для замены добавьте --force.')
    if len({p.resolve() for p in outputs}) != len(outputs):
        parser.error('Для PPTX и JSON нужны разные пути.')
    try:
        mapping = load_mapping(args.leaders)
        current = read_snapshot(args.current, args.date, mapping, args.sheet)
        prior_mapping = load_mapping(args.previous_leaders) if args.previous_leaders else mapping
        previous = read_snapshot(args.previous, args.previous_date, prior_mapping, args.sheet) if args.previous else None
        if previous and not args.previous_leaders:
            current.warnings.append('Оба периода сгруппированы по одной выбранной карте лидеров; историческая карта не предоставлена.')
        deck = DeckBuilder(current, previous, args.template, args.goal_share).build()
        staged = []
        try:
            # Prepare both destinations before publishing either deliverable.
            for destination in outputs:
                destination.parent.mkdir(parents=True, exist_ok=True)
                descriptor, temp_name = tempfile.mkstemp(prefix='.maturity-', suffix=destination.suffix,
                                                         dir=destination.parent)
                os.close(descriptor)
                staged.append((Path(temp_name), destination))
            temp_path = staged[0][0]
            deck.save(str(temp_path))
            count = validate_presentation(temp_path)
            audit = {'generator': 'dit-maturity-python-v1', 'current': snapshot_audit(current),
                     'previous': snapshot_audit(previous) if previous else None,
                     'comparison_note': comparison_note(current, previous), 'slides': count}
            if previous:
                audit['changes'] = {k: sorted(v) for k, v in compare_snapshots(current, previous).items()}
            if args.audit_json:
                staged[1][0].write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            publish_staged_files(staged, force=args.force)
        finally:
            for source, _ in staged:
                source.unlink(missing_ok=True)
        print(f'Готово: {output} ({count} слайдов).')
        n = summarize(current.teams.values())
        print(f'По доступным метрикам: {n["teams_met"]}/{n["teams"]} команд; '
              f'{n["metrics_met"]}/{n["metrics_available"]} метрик; нет данных: {n["missing"]}.')
        for warning in current.warnings + (previous.warnings if previous else []):
            print('Внимание: ' + warning)
        return 0
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as exc:
        parser.exit(2, f'Ошибка: {exc}\n')


if __name__ == '__main__':
    raise SystemExit(main())
