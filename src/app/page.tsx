import { Kanban } from "lucide-react";

import KanbanBoard from "@/components/kanban-board";

export default function Home() {
  return (
    <>
      <KanbanBoard />
      <div className="fixed bottom-4 right-4 text-xs text-muted-foreground bg-background/90 border rounded-full px-3 py-1.5 shadow-sm inline-flex items-center gap-1.5">
        <Kanban className="size-3" /> Built with Next.js 16 + Tailwind v4 + shadcn/ui
      </div>
    </>
  );
}
