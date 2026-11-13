const formats = new Set(['bar', 'stacked', 'table']);
const groups = new Set(['status', 'leader', 'objective']);
const cardId = /^[a-z0-9][a-z0-9-]{0,79}$/;

function field(value, label, { limit = 180, required = false } = {}) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f]/.test(value) || (required && !value.trim())) {
    throw new Error(`Проверьте поле «${label}».`);
  }
  return value.trim();
}

export function validateCards(cards) {
  if (!Array.isArray(cards) || cards.length > 8) throw new Error('На экране можно разместить до восьми карточек.');
  const ids = new Set();
  return cards.map(card => {
    if (!card || typeof card !== 'object' || typeof card.id !== 'string' || !cardId.test(card.id) || ids.has(card.id)) {
      throw new Error('Карточки должны иметь разные идентификаторы.');
    }
    ids.add(card.id);
    if (!formats.has(card.kind) || !groups.has(card.group)) throw new Error('Выберите вид и группировку карточки.');
    const period = field(card.period, 'Период', { limit: 24, required: true });
    if (!/^(?:Q[1-4]\s+20\d{2}|Y\d{2})$/i.test(period)) throw new Error('Выберите один квартальный или годовой период.');
    return {
      id: card.id, kind: card.kind, group: card.group, period,
      title: field(card.title, 'Название карточки', { limit: 90, required: true }),
      status: field(card.status, 'Прогноз'),
      leader: field(card.leader, 'Руководитель')
    };
  });
}
