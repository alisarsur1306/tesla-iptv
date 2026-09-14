import { useLocale, type Locale } from '@/lib/locale';
import { appStrings } from '@/lib/appStrings';
export default function LanguageSelect() {
  const { locale, setLocale } = useLocale();
  return <select aria-label={appStrings[locale].language} value={locale} onChange={e => setLocale(e.target.value as Locale)} className="h-12 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-base text-zinc-100" dir="ltr">
    <option value="en">English</option><option value="he">עברית</option><option value="ar">العربية</option>
  </select>;
}
