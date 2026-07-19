import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KeyRound } from 'lucide-react';

interface KeyPromptProps {
  onSave: (key: string) => void;
  onCancel: () => void;
}

/** Small overlay asking for the deployment access key (shown after a 403). */
export default function KeyPrompt({ onSave, onCancel }: KeyPromptProps) {
  const [value, setValue] = useState('');

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6">
      <Card className="w-full max-w-xl border-zinc-700 bg-zinc-900 text-zinc-100">
        <CardHeader>
          <div className="flex items-center gap-4">
            <KeyRound className="h-10 w-10 text-amber-400" />
            <CardTitle className="text-3xl font-bold">Access key required</CardTitle>
          </div>
          <CardDescription className="text-lg text-zinc-400">
            This deployment is protected. Enter the access key to continue.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Access key"
            autoFocus
            autoComplete="off"
            className="h-14 border-zinc-700 bg-zinc-800 text-lg"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim()) onSave(value.trim());
            }}
          />
          <div className="flex gap-4">
            <Button
              onClick={() => value.trim() && onSave(value.trim())}
              className="h-14 flex-1 bg-red-600 text-xl font-bold hover:bg-red-500"
            >
              Save & retry
            </Button>
            <Button
              onClick={onCancel}
              variant="outline"
              className="h-14 border-zinc-700 bg-transparent px-8 text-xl text-zinc-300 hover:bg-zinc-800"
            >
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
