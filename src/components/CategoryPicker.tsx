import { useState } from 'react';
import { LayoutGrid } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import type { XtreamCategory } from '@/lib/xtream';

export default function CategoryPicker({ categories, activeCategory, onSelect }: {
  categories: XtreamCategory[];
  activeCategory: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = categories.find((c) => String(c.category_id) === activeCategory);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          aria-label="Choose channel group"
          className={`h-16 min-w-0 flex-1 px-5 text-xl sm:max-w-sm ${selected ? 'bg-red-600 hover:bg-red-500' : 'bg-zinc-800 hover:bg-zinc-700'} text-white`}
        >
          <LayoutGrid className="size-6" />
          <span dir="auto" className="truncate">{selected?.category_name || 'Groups'}</span>
        </Button>
      </SheetTrigger>
      <SheetContent
        className="w-full gap-0 border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-2xl [&>button]:flex [&>button]:size-14 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-xl [&>button]:bg-zinc-800 [&>button>svg]:size-7"
      >
        <SheetHeader className="shrink-0 border-b border-zinc-800 p-6 pr-24">
          <SheetTitle className="text-2xl text-white">Channel groups</SheetTitle>
          <SheetDescription className="text-base text-zinc-400">Choose a group to browse its channels.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {categories.map((category) => (
              <button
                key={category.category_id}
                aria-pressed={String(category.category_id) === activeCategory}
                className={`min-h-16 rounded-xl px-5 py-4 text-start text-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-white ${String(category.category_id) === activeCategory ? 'bg-red-600 text-white' : 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700'}`}
                onClick={() => {
                  onSelect(String(category.category_id));
                  setOpen(false);
                }}
              >
                <span dir="auto">{category.category_name}</span>
              </button>
            ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
