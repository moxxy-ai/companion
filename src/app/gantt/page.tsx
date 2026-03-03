"use client";

import { addDays, differenceInCalendarDays, format, startOfDay } from "date-fns";
import { CalendarRange, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

type Epic = {
  id: string;
  name: string;
  owner: string;
  startDate: string;
  endDate: string;
  progress: number;
  status: "on_track" | "at_risk" | "done";
};

const epics: Epic[] = [
  {
    id: "epic-1",
    name: "Authentication & Access Control",
    owner: "Platform",
    startDate: "2026-03-01",
    endDate: "2026-03-18",
    progress: 70,
    status: "on_track",
  },
  {
    id: "epic-2",
    name: "Kanban Drag & Drop Hardening",
    owner: "Frontend",
    startDate: "2026-03-05",
    endDate: "2026-03-22",
    progress: 45,
    status: "at_risk",
  },
  {
    id: "epic-3",
    name: "IndexedDB Offline Sync",
    owner: "Data",
    startDate: "2026-03-10",
    endDate: "2026-03-30",
    progress: 30,
    status: "on_track",
  },
  {
    id: "epic-4",
    name: "Release Readiness",
    owner: "QA",
    startDate: "2026-03-21",
    endDate: "2026-04-04",
    progress: 10,
    status: "on_track",
  },
];

const statusStyle: Record<Epic["status"], string> = {
  on_track: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  at_risk: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  done: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
};

const timelineStart = startOfDay(new Date("2026-03-01"));
const timelineDays = 38;
const dayWidth = 36;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export default function GanttPage() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_var(--color-primary)/8,_transparent_40%),linear-gradient(to_bottom_right,var(--color-background),color-mix(in_oklch,var(--color-background),black_4%))]">
      <div className="mx-auto max-w-[1400px] p-4 md:p-8 space-y-6">
        <header className="rounded-3xl border bg-card/70 backdrop-blur p-5 md:p-7 shadow-sm">
          <div className="inline-flex items-center gap-2 text-xs text-muted-foreground mb-2">
            <Sparkles className="size-3.5" /> Epic Delivery Insights
          </div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Epics Gantt Flow</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Visualize how epics progress over time and identify schedule pressure early.
          </p>
        </header>

        <Card className="rounded-3xl border shadow-sm bg-card/80 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base inline-flex items-center gap-2">
              <CalendarRange className="size-4" /> Timeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="w-full">
              <div style={{ minWidth: 300 + timelineDays * dayWidth }} className="space-y-3 pb-3">
                <div className="grid" style={{ gridTemplateColumns: `280px repeat(${timelineDays}, ${dayWidth}px)` }}>
                  <div className="text-xs text-muted-foreground font-medium px-3 py-2 border-b">Epic</div>
                  {Array.from({ length: timelineDays }).map((_, idx) => {
                    const day = addDays(timelineStart, idx);
                    return (
                      <div key={idx} className="text-[10px] text-muted-foreground px-1 py-2 border-b text-center">
                        {format(day, "d MMM")}
                      </div>
                    );
                  })}
                </div>

                {epics.map((epic) => {
                  const start = startOfDay(new Date(epic.startDate));
                  const end = startOfDay(new Date(epic.endDate));
                  const startOffset = clamp(differenceInCalendarDays(start, timelineStart), 0, timelineDays - 1);
                  const length = clamp(differenceInCalendarDays(end, start) + 1, 1, timelineDays);

                  return (
                    <div
                      key={epic.id}
                      className="grid items-center"
                      style={{ gridTemplateColumns: `280px repeat(${timelineDays}, ${dayWidth}px)` }}
                    >
                      <div className="px-3 py-3 border rounded-l-xl bg-background/70 mr-1">
                        <p className="text-sm font-medium leading-5">{epic.name}</p>
                        <p className="text-xs text-muted-foreground">Owner: {epic.owner}</p>
                        <div className="mt-1 flex items-center gap-2">
                          <Badge variant="outline" className={statusStyle[epic.status]}>
                            {epic.status.replace("_", " ")}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{epic.progress}%</span>
                        </div>
                      </div>

                      <div className="relative h-14 border rounded-r-xl bg-background/40 overflow-hidden">
                        <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${timelineDays}, ${dayWidth}px)` }}>
                          {Array.from({ length: timelineDays }).map((_, i) => (
                            <div key={i} className="border-r last:border-r-0" />
                          ))}
                        </div>

                        <div
                          className="absolute top-3 h-8 rounded-lg bg-primary/80 text-primary-foreground text-xs px-2 flex items-center shadow"
                          style={{ left: startOffset * dayWidth + 4, width: length * dayWidth - 8 }}
                        >
                          {format(start, "MMM d")} → {format(end, "MMM d")}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
