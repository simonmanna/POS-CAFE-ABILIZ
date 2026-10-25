/**
 * Current UI language, as a React state value. The app root uses it as a
 * `key`, so changing language (or a phrase map finishing its fetch) remounts
 * the tree — that is what makes the non-hook `tx()` helper re-evaluate
 * everywhere, including inside memoised subtrees and non-component helpers.
 */
import { useEffect, useState } from 'react';
import i18n from './i18n';
import { currentLang, onPhrasesLoaded } from './tx';

export function useAppLanguage(): string {
  const [key, setKey] = useState(() => currentLang());
  useEffect(() => {
    let loads = 0;
    const onLang = () => setKey(currentLang());
    const onLoad = () => setKey(`${currentLang()}#${++loads}`);
    i18n.on('languageChanged', onLang);
    const off = onPhrasesLoaded(onLoad);
    return () => {
      i18n.off('languageChanged', onLang);
      off();
    };
  }, []);
  return key;
}
