import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { Kanban } from "lucide-react";

import KanbanBoard from "@/components/kanban-board";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <>
      <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="inline-flex items-center gap-2 font-medium">
            <Kanban className="size-4" />
            <span>TaskFlow</span>
          </div>
          <div className="inline-flex items-center gap-2">
            <SignedOut>
              <SignInButton mode="modal">
                <Button size="sm">Sign in</Button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <UserButton />
            </SignedIn>
          </div>
        </div>
      </header>

      <SignedIn>
        <KanbanBoard />
      </SignedIn>

      <SignedOut>
        <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-4xl items-center justify-center px-4 py-10 text-center">
          <div className="space-y-4">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Welcome to TaskFlow</h1>
            <p className="text-muted-foreground">Please sign in to access your Kanban board.</p>
            <SignInButton mode="modal">
              <Button>Sign in with Clerk</Button>
            </SignInButton>
          </div>
        </main>
      </SignedOut>

      <div className="fixed bottom-4 right-4 text-xs text-muted-foreground bg-background/90 border rounded-full px-3 py-1.5 shadow-sm inline-flex items-center gap-1.5">
        <Kanban className="size-3" /> Built with Next.js 16 + Tailwind v4 + shadcn/ui
      </div>
    </>
  );
}
