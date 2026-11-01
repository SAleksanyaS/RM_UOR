import { useEffect, useState } from 'react';

export function WelcomeToast({ displayName }: { displayName: string | null }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => { const timer = window.setTimeout(() => setVisible(false), 5000); return () => window.clearTimeout(timer); }, []);
  return visible ? <aside className="wb-welcome" aria-label="Приветствие"><span role="status">Здравствуйте{displayName ? ', ' + displayName : ''}! Рабочее место УОР готово.</span><button type="button" aria-label="Закрыть приветствие" onClick={() => setVisible(false)}>Закрыть</button></aside> : null;
}
