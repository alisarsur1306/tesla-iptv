import { useEffect, useState, type ReactNode } from 'react';
import { LocaleContext, initialLocale, type Locale } from '@/lib/locale';

export default function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'en' ? 'ltr' : 'rtl';
    try { localStorage.setItem('tesla-iptv:language', locale); } catch { /* Keep the selection for this visit. */ }
  }, [locale]);
  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>;
}
