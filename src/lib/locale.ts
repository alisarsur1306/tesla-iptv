import { createContext, useContext } from 'react';
export type Locale = 'en' | 'he' | 'ar';
export const LocaleContext = createContext<{ locale: Locale; setLocale: (locale: Locale) => void }>({ locale: 'en', setLocale: () => {} });
export const useLocale = () => useContext(LocaleContext);

export function initialLocale(): Locale {
  try {
    const value = localStorage.getItem('tesla-iptv:language');
    if (value === 'en' || value === 'he' || value === 'ar') return value;
  } catch { /* Browser preferences remain usable. */ }
  const language = navigator.language?.split('-')[0];
  return language === 'he' || language === 'ar' ? language : 'en';
}
